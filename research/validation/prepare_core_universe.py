"""Import official USD-M archives and derive the causal 15m-based price path."""

from __future__ import annotations

import csv
from datetime import datetime
from decimal import Decimal
import hashlib
import io
import json
from pathlib import Path
import zipfile

from import_ohlcv import import_csv
from derive_canonical_timeframes import canonical_bars, compare

HERE = Path(__file__).resolve().parent
DATA = HERE.parent / "data" / "core_universe_v1"
POLICY = json.loads((HERE / "ALPHA_RESEARCH_POLICY_V1.json").read_text(encoding="utf-8"))
CUTOFF = 1790812800000
DURATIONS = {"15m": 900000, "1h": 3600000, "4h": 14400000, "1d": 86400000}
RATIOS = {"1h": 4, "4h": 16, "1d": 96}


def archive_rows(item):
    payload = (DATA / item["file"]).read_bytes()
    if hashlib.sha256(payload).hexdigest() != item["sha256"]:
        raise ValueError(f"Archive checksum changed: {item['file']}")
    with zipfile.ZipFile(io.BytesIO(payload)) as archive:
        expected = Path(item["file"]).stem + ".csv"
        if archive.namelist() != [expected]:
            raise ValueError(f"Unexpected archive members: {item['file']}")
        rows = list(csv.reader(io.StringIO(archive.read(expected).decode("utf-8-sig")), strict=True))
    if rows and rows[0][0] in ("open_time", "calc_time"):
        rows.pop(0)
    return rows


def monthly_items(receipt, symbol, kind):
    return sorted((item for item in receipt["files"] if item["symbol"] == symbol and item["kind"] == kind),
                  key=lambda x: x["month"])


def normalize_price(receipt, symbol, kind, retrieval_ms):
    duration = DURATIONS[kind]
    rows = []
    previous = None
    gaps = []
    for item in monthly_items(receipt, symbol, kind):
        for row in archive_rows(item):
            if len(row) != 12:
                raise ValueError(f"Unexpected kline columns: {item['file']}")
            opened = int(row[0])
            if opened >= CUTOFF or int(row[6]) != opened + duration - 1:
                raise ValueError(f"Future or invalid kline: {item['file']} {opened}")
            if previous is not None and opened != previous:
                gaps.append({"expectedOpenTime": previous, "nextOpenTime": opened,
                             "missingIntervals": max(0, (opened - previous) // duration)})
            previous = opened + duration
            rows.append(row)
    if not rows or previous != CUTOFF:
        raise ValueError(f"Incomplete official {kind} history for {symbol}")
    monthly_gaps = list(gaps)
    gap_fill_rows = 0
    if kind == "15m" and gaps:
        missing = {opened for gap in gaps
                   for opened in range(gap["expectedOpenTime"], gap["nextOpenTime"], duration)}
        filled = {}
        for item in receipt.get("gapFillFiles", []):
            if item["symbol"] != symbol:
                continue
            for row in archive_rows(item):
                opened = int(row[0])
                if (len(row) != 12 or opened not in missing or opened in filled or
                        int(row[6]) != opened + duration - 1):
                    raise ValueError(f"Daily gap-fill row conflicts with monthly source: {item['file']} {opened}")
                filled[opened] = row
        if set(filled) != missing:
            raise ValueError(f"Official daily source does not fully cover {symbol} monthly gap")
        rows.extend(filled.values())
        rows.sort(key=lambda row: int(row[0]))
        gap_fill_rows = len(filled)
        gaps = []
        expected = int(rows[0][0])
        for row in rows:
            if int(row[0]) != expected:
                gaps.append({"expectedOpenTime": expected, "nextOpenTime": int(row[0])})
            expected = int(row[0]) + duration
    # Independent higher-timeframe publications are QA references only. Their
    # gaps are reported rather than silently repaired or treated as authority.
    if gaps and kind == "15m":
        raise ValueError(f"Canonical 15m path has gaps: {symbol} {gaps[:3]}")
    header = "open_time,open,high,low,close,volume\n"
    source = (header + "".join(",".join(row[:6]) + "\n" for row in rows)).encode()
    instrument = f"ulte:v1:BINANCE:PERPETUAL:{symbol}"
    segments = []
    current = []
    expected = None
    for row in rows:
        opened = int(row[0])
        if expected is not None and opened != expected:
            segments.append(current)
            current = []
        current.append(row)
        expected = opened + duration
    segments.append(current)
    candles = []
    reports = []
    for segment in segments:
        segment_source = (header + "".join(",".join(row[:6]) + "\n" for row in segment)).encode()
        part, report = import_csv(segment_source, instrument_id=instrument, timeframe=kind,
                                  anchor_ms=0, latest_close_ms=retrieval_ms)
        candles.extend(part)
        reports.append(report)
    output = DATA / symbol / "normalized" / kind
    output.mkdir(parents=True, exist_ok=True)
    payload = (json.dumps(candles, separators=(",", ":")) + "\n").encode()
    (output / "candles.json").write_bytes(payload)
    return candles, {"rows": len(candles), "firstOpenTime": candles[0]["openTime"],
                     "lastCloseTime": candles[-1]["closeTime"], "missingIntervals": gaps,
                     "monthlySourceMissingIntervals": monthly_gaps,
                     "officialDailyGapFillRows": gap_fill_rows,
                     "sourceCsvSha256": hashlib.sha256(source).hexdigest(),
                     "normalizedSha256": hashlib.sha256(payload).hexdigest(),
                     "importQualitySegments": reports}


def normalize_funding(receipt, symbol):
    records = []
    gaps = []
    previous = None
    for item in monthly_items(receipt, symbol, "fundingRate"):
        for row in archive_rows(item):
            if len(row) != 3:
                raise ValueError(f"Unexpected funding columns: {item['file']}")
            timestamp, hours = int(row[0]), int(row[1])
            rate = Decimal(row[2])
            if timestamp >= CUTOFF or timestamp <= (previous or -1) or hours <= 0 or not rate.is_finite():
                raise ValueError(f"Invalid funding record: {item['file']} {timestamp}")
            if previous is not None and abs(timestamp - previous - hours * 3600000) > 60000:
                gaps.append({"previousTime": previous, "nextTime": timestamp})
            records.append({"time": timestamp, "intervalHours": hours, "rate": str(rate)})
            previous = timestamp
    if not records:
        raise ValueError(f"No funding history for {symbol}")
    output = DATA / symbol / "normalized" / "fundingRate"
    output.mkdir(parents=True, exist_ok=True)
    payload = (json.dumps(records, separators=(",", ":")) + "\n").encode()
    (output / "funding.json").write_bytes(payload)
    return {"rows": len(records), "firstEventTime": records[0]["time"],
            "lastEventTime": records[-1]["time"], "missingIntervals": gaps,
            "normalizedSha256": hashlib.sha256(payload).hexdigest()}


def prepare_symbol(receipt, symbol, retrieval_ms):
    official = {}
    quality = {}
    for kind in DURATIONS:
        official[kind], quality[kind] = normalize_price(receipt, symbol, kind, retrieval_ms)
    quality["fundingRate"] = normalize_funding(receipt, symbol)
    raw = official["15m"]
    first_full_day = ((raw[0]["openTime"] + 86400000 - 1) // 86400000) * 86400000
    if first_full_day != raw[0]["openTime"]:
        raw = raw[(first_full_day - raw[0]["openTime"]) // 900000:]
    if not raw or raw[0]["openTime"] != first_full_day or raw[-1]["closeTime"] != CUTOFF:
        raise ValueError(f"Cannot establish full canonical UTC-day span for {symbol}")
    # The replay's raw detail path is exactly the child path used to derive all
    # signal frames. Earlier partial listing-day bars remain in normalized QA.
    output = DATA / symbol / "canonical" / "15m"
    output.mkdir(parents=True, exist_ok=True)
    payload = (json.dumps(raw, separators=(",", ":")) + "\n").encode()
    (output / "candles.json").write_bytes(payload)
    canonical = {"15m": {"rows": len(raw), "startOpenTime": first_full_day,
                         "endCloseTime": CUTOFF, "sha256": hashlib.sha256(payload).hexdigest(),
                         "excludedPartialListingDayBars": len(official["15m"]) - len(raw)}}
    for kind, ratio in RATIOS.items():
        derived = canonical_bars(raw, kind, ratio, start=first_full_day, end=CUTOFF)
        references = official[kind]
        conflicts = []
        missing_reference = []
        if references is not None:
            by_open = {item["openTime"]: item for item in references}
            for candle in derived:
                reference = by_open.get(candle["openTime"])
                if reference is None:
                    missing_reference.append(candle["openTime"])
                else:
                    conflicts.extend(compare([candle], [reference]))
        output = DATA / symbol / "canonical" / kind
        output.mkdir(parents=True, exist_ok=True)
        payload = (json.dumps(derived, separators=(",", ":")) + "\n").encode()
        (output / "candles.json").write_bytes(payload)
        canonical[kind] = {"rows": len(derived), "startOpenTime": derived[0]["openTime"],
                           "endCloseTime": derived[-1]["closeTime"],
                           "sha256": hashlib.sha256(payload).hexdigest(),
                           "officialQaConflicts": conflicts,
                           "officialQaMissingOpenTimes": missing_reference}
    files = [item for item in receipt["files"] if item["symbol"] == symbol] + [
        item for item in receipt.get("gapFillFiles", []) if item["symbol"] == symbol]
    return {"instrumentId": f"ulte:v1:BINANCE:PERPETUAL:{symbol}",
            "officialArchiveFirstMonth": {kind: monthly_items(receipt, symbol, kind)[0]["month"]
                                          for kind in (*DURATIONS, "fundingRate")},
            "officialArchiveFiles": files, "quality": quality, "canonical": canonical}


def main():
    receipt_path = DATA / "download_receipt.json"
    receipt = json.loads(receipt_path.read_text(encoding="utf-8"))
    if receipt["failures"] or receipt["policyId"] != POLICY["id"]:
        raise ValueError("Complete official fixed-policy archive receipt required")
    retrieval_ms = int(datetime.fromisoformat(receipt["retrievedAtUtc"]).timestamp() * 1000)
    btc_path = HERE / "RESEARCH_TARGET_V1.json"
    btc = json.loads(btc_path.read_text(encoding="utf-8"))
    if (not btc["sourceVerified"] or btc["periodUtc"]["endExclusive"] != POLICY["historicalEndExclusive"] or
            btc["quality"]["15m"]["rows"] != 236640 or len(btc["files"]) != 405):
        raise ValueError("Verified Task056 BTC provenance required")
    symbols = {"BTCUSDT": {
        "instrumentId": btc["instrumentId"], "sourceManifest": "RESEARCH_TARGET_V1.json",
        "sourceManifestSha256": hashlib.sha256(btc_path.read_bytes()).hexdigest(),
        "officialArchiveFirstMonth": {kind: "2020-01" for kind in (*DURATIONS, "fundingRate")},
        "officialArchiveFileCount": len(btc["files"]),
        "quality": btc["quality"],
        "canonical": {"15m": {"rows": btc["quality"]["15m"]["rows"],
                              "startOpenTime": 1577836800000, "endCloseTime": CUTOFF,
                              "sha256": btc["quality"]["15m"]["normalizedSha256"]},
                      **btc["canonicalPricePolicy"]["derived"]},
    }}
    for symbol in POLICY["coreUniverse"]:
        if symbol == "BTCUSDT":
            continue  # The earlier verified Task056 BTC source is reused separately.
        symbols[symbol] = prepare_symbol(receipt, symbol, retrieval_ms)
        print(f"Prepared {symbol}: {symbols[symbol]['canonical']['1h']['rows']} decision bars", flush=True)
    manifest = {"id": "CORE_UNIVERSE_DATA_MANIFEST_V1", "policyId": POLICY["id"],
                "source": receipt["source"], "rootUrl": receipt["rootUrl"],
                "retrievedAtUtc": receipt["retrievedAtUtc"],
                "archiveReceiptSha256": hashlib.sha256(receipt_path.read_bytes()).hexdigest(),
                "historicalEndExclusive": POLICY["historicalEndExclusive"],
                "priceAuthority": "checksum-verified official 15m, complete UTC aggregation at close",
                "higherTimeframeArchives": "checksum-verified QA reference only",
                "symbols": symbols}
    (HERE / "CORE_UNIVERSE_DATA_MANIFEST_V1.json").write_text(
        json.dumps(manifest, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
