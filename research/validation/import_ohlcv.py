"""Import a declared official OHLCV CSV without repairing or inventing candles.

The declaration is recorded, not independently authenticated. A separate
review must establish that the input bytes came from the named official source.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import re
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation
from pathlib import Path
from urllib.parse import quote, unquote


DECIMAL = re.compile(r"^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$")
TIMEFRAME = re.compile(r"^([1-9][0-9]*)([smhdw])$")
FIELDS = ("open_time", "open", "high", "low", "close", "volume")
MS = {"s": 1000, "m": 60000, "h": 3600000, "d": 86400000, "w": 604800000}
MAX_MS = 8640000000000000
KINDS = {"SPOT", "PERPETUAL", "FUTURE", "OPTION", "CFD", "EQUITY", "ETF", "INDEX"}


def instrument_venue(value: str) -> str:
    parts = value.split(":") if isinstance(value, str) else []
    if len(parts) != 5 or parts[:2] != ["ulte", "v1"] or parts[3] not in KINDS:
        raise ValueError("canonical ULTE instrument ID required")
    decoded = [unquote(parts[index]) for index in (2, 4)]
    if any(not item or quote(item, safe="-_.!~*'()") != parts[index]
           for item, index in zip(decoded, (2, 4))):
        raise ValueError("canonical ULTE instrument ID required")
    return decoded[0]


def parse_time(value: str) -> int:
    if re.fullmatch(r"(?:0|[1-9][0-9]*)", value):
        timestamp = int(value)
    else:
        if not value.endswith("Z") or "T" not in value:
            raise ValueError("open_time must be UTC ISO-8601 Z or Unix milliseconds")
        try:
            parsed = datetime.fromisoformat(value[:-1] + "+00:00")
        except ValueError as exc:
            raise ValueError("invalid UTC open_time") from exc
        if parsed.microsecond % 1000:
            raise ValueError("open_time must have millisecond precision")
        epoch = datetime(1970, 1, 1, tzinfo=timezone.utc)
        elapsed = parsed - epoch
        timestamp = (elapsed.days * 86400000 + elapsed.seconds * 1000 +
                     elapsed.microseconds // 1000)
    if timestamp < 0 or timestamp > MAX_MS:
        raise ValueError("open_time outside supported UTC range")
    return timestamp


def decimal(value: str, name: str) -> Decimal:
    if not isinstance(value, str) or not DECIMAL.fullmatch(value) or len(value.replace(".", "")) > 128:
        raise ValueError(f"{name} must be a non-negative plain decimal string")
    try:
        return Decimal(value)
    except InvalidOperation as exc:
        raise ValueError(f"invalid {name}") from exc


def import_csv(payload: bytes, *, instrument_id: str, timeframe: str,
               anchor_ms: int = 0, latest_close_ms: int | None = None) -> tuple[list[dict], dict]:
    match = TIMEFRAME.fullmatch(timeframe)
    instrument_venue(instrument_id)
    if not match:
        raise ValueError("fixed-duration timeframe required")
    duration = int(match[1]) * MS[match[2]]
    if duration > MAX_MS:
        raise ValueError("timeframe too large")
    if anchor_ms < 0 or anchor_ms >= duration:
        raise ValueError("anchor must be within one timeframe interval")
    try:
        content = payload.decode("utf-8-sig")
    except UnicodeDecodeError as exc:
        raise ValueError("CSV must be UTF-8") from exc
    reader = csv.DictReader(content.splitlines(), strict=True)
    if reader.fieldnames != list(FIELDS):
        raise ValueError(f"CSV columns must be exactly {','.join(FIELDS)}")
    candles: list[dict] = []
    previous_close = None
    for line, row in enumerate(reader, start=2):
        if None in row or any(value is None for value in row.values()):
            raise ValueError(f"row {line}: malformed CSV")
        start = parse_time(row["open_time"])
        end = start + duration
        if end > MAX_MS or (start - anchor_ms) % duration != 0:
            raise ValueError(f"row {line}: impossible or misaligned candle time")
        if latest_close_ms is not None and end > latest_close_ms:
            raise ValueError(f"row {line}: candle closes after retrieval time")
        if previous_close is not None and start != previous_close:
            reason = "missing interval" if start > previous_close else "duplicate or unordered interval"
            raise ValueError(f"row {line}: {reason}; expected open_time {previous_close}")
        values = {name: decimal(row[name], name) for name in FIELDS[1:]}
        opening, high, low, close, volume = (values[name] for name in FIELDS[1:])
        if min(opening, high, low, close) <= 0 or high < max(opening, close) or low > min(opening, close):
            raise ValueError(f"row {line}: invalid OHLC")
        if volume < 0:
            raise ValueError(f"row {line}: negative volume")
        candles.append({
            "instrumentId": instrument_id, "timeframe": timeframe,
            "openTime": start, "closeTime": end, "availableAt": end,
            "open": row["open"], "high": row["high"], "low": row["low"],
            "close": row["close"], "volume": row["volume"],
            "isClosed": True, "quality": [],
        })
        previous_close = end
    if len(candles) < 5:
        raise ValueError("at least five contiguous candles required for chronological splits")
    train_end = candles[len(candles) * 3 // 5]["openTime"]
    validation_end = candles[len(candles) * 4 // 5]["openTime"]
    report = {
        "status": "PASS", "rows": len(candles), "duplicates": 0,
        "missingIntervals": 0, "invalidOhlcv": 0, "misalignedTimestamps": 0,
        "futureRows": 0, "priceForwardFilled": False,
        "startOpenTime": candles[0]["openTime"], "endCloseTime": candles[-1]["closeTime"],
        "splitBoundaries": {"trainEnd": train_end, "validationEnd": validation_end},
    }
    return candles, report


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--source-url", required=True)
    parser.add_argument("--retrieved-at-utc", required=True,
                        help="UTC ISO-8601 retrieval instant ending in Z")
    parser.add_argument("--venue", required=True)
    parser.add_argument("--market-type", required=True)
    parser.add_argument("--instrument-id", required=True)
    parser.add_argument("--timeframe", required=True)
    parser.add_argument("--anchor-ms", type=int, required=True,
                        help="UTC timeframe boundary offset in milliseconds")
    args = parser.parse_args()
    if not args.retrieved_at_utc.endswith("Z") or "T" not in args.retrieved_at_utc:
        parser.error("--retrieved-at-utc must be a UTC ISO-8601 instant ending in Z")
    retrieved_ms = parse_time(args.retrieved_at_utc)
    if not args.source_url.startswith("https://"):
        parser.error("--source-url must be an HTTPS provenance URL")
    if not args.venue or not args.market_type:
        parser.error("venue and market type are required")
    if instrument_venue(args.instrument_id) != args.venue:
        parser.error("--venue must match the venue encoded in --instrument-id")
    payload = args.input.read_bytes()
    candles, quality = import_csv(payload, instrument_id=args.instrument_id,
                                  timeframe=args.timeframe, anchor_ms=args.anchor_ms,
                                  latest_close_ms=retrieved_ms)
    manifest = {
        "normalizationVersion": "OHLCV_CSV_V1", "source": args.source_url,
        "sourceVerified": False, "sourceFileSha256": hashlib.sha256(payload).hexdigest(),
        "venue": args.venue, "marketType": args.market_type,
        "instrumentId": args.instrument_id, "timeframe": args.timeframe,
        "anchorMs": args.anchor_ms,
        "retrievalDateUtc": args.retrieved_at_utc[:10],
        "retrievalTimeUtc": args.retrieved_at_utc,
        "startOpenTime": quality["startOpenTime"], "endCloseTime": quality["endCloseTime"],
        "rowCount": quality["rows"], "splitBoundaries": quality["splitBoundaries"],
        "utcAvailabilityRule": "Each candle is available at closeTime only",
        "quality": quality,
    }
    args.output_dir.mkdir(parents=True, exist_ok=True)
    canonical = (json.dumps(candles, sort_keys=True, separators=(",", ":")) + "\n").encode()
    manifest["normalizedSha256"] = hashlib.sha256(canonical).hexdigest()
    (args.output_dir / "candles.json").write_bytes(canonical)
    (args.output_dir / "manifest.json").write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
