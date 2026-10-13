"""Normalize the checksum-verified Binance archives with the existing OHLCV importer."""

from __future__ import annotations

import csv
import hashlib
import io
import json
import zipfile
from datetime import datetime, timezone
from decimal import Decimal
from pathlib import Path

from import_ohlcv import import_csv
from derive_canonical_timeframes import main as derive_canonical_timeframes


ROOT = Path(__file__).resolve().parents[1] / "data" / "binance_btcusdt_v1"
START = 1577836800000
END = 1790812800000  # 2026-10-01T00:00:00Z, exclusive
INSTRUMENT = "ulte:v1:BINANCE:PERPETUAL:BTCUSDT"
DURATIONS = {"15m": 900000, "1h": 3600000, "4h": 14400000, "1d": 86400000}
HEADER = "open_time,open,high,low,close,volume\n"


def read_archive(item: dict) -> list[list[str]]:
    path = ROOT / item["file"]
    payload = path.read_bytes()
    if hashlib.sha256(payload).hexdigest() != item["sha256"]:
        raise ValueError(f"Archive checksum changed: {path}")
    with zipfile.ZipFile(io.BytesIO(payload)) as archive:
        expected = Path(item["file"]).stem + ".csv"
        if archive.namelist() != [expected]:
            raise ValueError(f"Unexpected archive members: {path}")
        text = archive.read(expected).decode("utf-8-sig")
    rows = list(csv.reader(io.StringIO(text), strict=True))
    if rows and rows[0][0] in ("open_time", "calc_time"):
        rows.pop(0)
    return rows


def normalize_klines(items: list[dict], timeframe: str, retrieval_ms: int) -> dict:
    duration = DURATIONS[timeframe]
    prepared = [HEADER]
    previous = None
    gaps = []
    count = 0
    for item in items:
        for row in read_archive(item):
            if len(row) != 12:
                raise ValueError(f"Unexpected Binance kline columns: {item['file']}")
            opened, official_close = int(row[0]), int(row[6])
            if opened < START or opened >= END:
                raise ValueError(f"Archive row outside target period: {item['file']} {opened}")
            if official_close != opened + duration - 1:
                raise ValueError(f"Binance close-time mismatch: {item['file']} {opened}")
            if previous is not None and opened != previous:
                gaps.append({"expectedOpenTime": previous, "nextOpenTime": opened,
                             "missingIntervals": max(0, (opened - previous) // duration)})
            previous = opened + duration
            prepared.append(",".join(row[:6]) + "\n")
            count += 1
    if count == 0 or int(prepared[1].split(",")[0]) != START or previous != END:
        raise ValueError(f"{timeframe} does not span the exact target period")
    output = ROOT / "normalized" / timeframe
    output.mkdir(parents=True, exist_ok=True)
    source = "".join(prepared).encode("utf-8")
    (output / "source.csv").write_bytes(source)
    quality = {"rows": count, "gaps": gaps, "sourceCsvSha256": hashlib.sha256(source).hexdigest()}
    if gaps:
        (output / "quality.json").write_text(json.dumps(quality, indent=2) + "\n", encoding="utf-8")
        raise ValueError(f"{timeframe}: {len(gaps)} discontinuities; first: {gaps[0]}")
    candles, report = import_csv(source, instrument_id=INSTRUMENT, timeframe=timeframe,
                                 anchor_ms=0, latest_close_ms=retrieval_ms)
    encoded = (json.dumps(candles, separators=(",", ":")) + "\n").encode("utf-8")
    (output / "candles.json").write_bytes(encoded)
    quality.update(report)
    quality["importerSuggestedSplitBoundaries"] = quality.pop("splitBoundaries")
    quality["normalizedSha256"] = hashlib.sha256(encoded).hexdigest()
    (output / "quality.json").write_text(json.dumps(quality, indent=2) + "\n", encoding="utf-8")
    return quality


def normalize_funding(items: list[dict]) -> dict:
    records = []
    previous = None
    gaps = []
    for item in items:
        for row in read_archive(item):
            if len(row) != 3:
                raise ValueError(f"Unexpected Binance funding columns: {item['file']}")
            timestamp = int(row[0])
            interval_hours = int(row[1])
            rate = Decimal(row[2])
            if timestamp < START or timestamp >= END or timestamp <= (previous or -1):
                raise ValueError(f"Funding chronology or period error: {item['file']} {timestamp}")
            if not rate.is_finite() or interval_hours <= 0:
                raise ValueError(f"Invalid funding record: {item['file']} {timestamp}")
            if previous is not None and abs(timestamp - previous - interval_hours * 3600000) > 60000:
                gaps.append({"previousTime": previous, "nextTime": timestamp})
            records.append({"time": timestamp, "intervalHours": interval_hours, "rate": str(rate)})
            previous = timestamp
    if gaps:
        raise ValueError(f"Funding history has {len(gaps)} interval gaps; first: {gaps[0]}")
    output = ROOT / "normalized" / "fundingRate"
    output.mkdir(parents=True, exist_ok=True)
    payload = (json.dumps(records, separators=(",", ":")) + "\n").encode("utf-8")
    (output / "funding.json").write_bytes(payload)
    return {"rows": len(records), "missingIntervals": 0,
            "startTime": records[0]["time"], "endTime": records[-1]["time"],
            "normalizedSha256": hashlib.sha256(payload).hexdigest()}


def cross_timeframe_quality() -> dict:
    series = {timeframe: json.loads((ROOT / "normalized" / timeframe / "candles.json")
                                    .read_text(encoding="utf-8")) for timeframe in DURATIONS}
    def compare(smaller: str, larger: str, ratio: int) -> list[int]:
        mismatches = []
        for index, candle in enumerate(series[larger]):
            group = series[smaller][index * ratio:index * ratio + ratio]
            if (Decimal(group[0]["open"]) != Decimal(candle["open"]) or
                Decimal(group[-1]["close"]) != Decimal(candle["close"]) or
                max(Decimal(item["high"]) for item in group) != Decimal(candle["high"]) or
                min(Decimal(item["low"]) for item in group) != Decimal(candle["low"])):
                mismatches.append(candle["openTime"])
        return mismatches
    return {
        "15mTo1hMismatchOpenTimes": compare("15m", "1h", 4),
        "1hTo4hMismatchOpenTimes": compare("1h", "4h", 4),
        "1hTo1dMismatchOpenTimes": compare("1h", "1d", 24),
        "4hTo1dMismatchOpenTimes": compare("4h", "1d", 6),
    }


def main() -> None:
    receipt = json.loads((ROOT / "download_receipt.json").read_text(encoding="utf-8"))
    if receipt["failures"] or len(receipt["files"]) != 405:
        raise ValueError("Complete official archive receipt required")
    retrieval_ms = int(datetime.fromisoformat(receipt["retrievedAtUtc"]).timestamp() * 1000)
    groups = {kind: sorted((item for item in receipt["files"] if item["kind"] == kind),
                           key=lambda item: item["month"]) for kind in (*DURATIONS, "fundingRate")}
    quality = {}
    for timeframe in DURATIONS:
        if len(groups[timeframe]) != 81:
            raise ValueError(f"Incomplete {timeframe} archive set")
        quality[timeframe] = normalize_klines(groups[timeframe], timeframe, retrieval_ms)
        print(f"{timeframe}: {quality[timeframe]['rows']} contiguous rows", flush=True)
    quality["fundingRate"] = normalize_funding(groups["fundingRate"])
    print(f"fundingRate: {quality['fundingRate']['rows']} rows", flush=True)
    quality["crossTimeframe"] = cross_timeframe_quality()
    print(f"Cross-timeframe OHLC mismatch counts: " + ", ".join(
        f"{key}={len(value)}" for key, value in quality["crossTimeframe"].items()), flush=True)
    manifest = {
        "id": "RESEARCH_TARGET_V1", "venue": "Binance", "market": "USD-M perpetual futures",
        "instrument": "BTCUSDT", "instrumentId": INSTRUMENT,
        "timeframes": {"decision": "1h", "context": ["4h", "1d"], "executionDetail": "15m"},
        "periodUtc": {"startInclusive": "2020-01-01T00:00:00Z", "endExclusive": "2026-10-01T00:00:00Z"},
        "splitUtc": {"previousFinalOosStartInclusive": "2025-07-01T00:00:00Z",
                     "previousFinalOosEndExclusive": "2026-10-01T00:00:00Z",
                     "previousFinalOosStatus": "BURNED_FOR_RESEARCH_DIAGNOSTICS",
                     "trueForwardHoldoutStart": "2026-10-01T00:00:00Z",
                     "finalPristineOosAvailable": False,
                     "walkForwardProtocol": "WALK_FORWARD_PROTOCOL_V1.md"},
        "source": receipt["rootUrl"], "sourceVerified": True,
        "sourceVerification": "Each downloaded ZIP matched its adjacent Binance Public Data .CHECKSUM SHA-256",
        "archiveVersion": "SHA-256 snapshot at retrievedAtUtc; Binance may later revise archives",
        "retrievedAtUtc": receipt["retrievedAtUtc"],
        "utcNormalization": "Unix milliseconds; kline closeTime=openTime+duration, available at closeTime; no fill",
        "files": receipt["files"], "quality": quality,
    }
    (Path(__file__).resolve().parent / "RESEARCH_TARGET_V1.json").write_text(
        json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    derive_canonical_timeframes()


if __name__ == "__main__":
    main()
