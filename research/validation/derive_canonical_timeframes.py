"""Build closed UTC higher timeframes from checksum-verified, contiguous 15m bars."""

import hashlib
import json
from decimal import Decimal
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1] / "data" / "binance_btcusdt_v1"
START = 1577836800000
END = 1790812800000
BASE_MS = 900000
RATIOS = {"1h": 4, "4h": 16, "1d": 96}


def canonical_bars(children, timeframe, ratio, *, start=START, end=END):
    if len(children) != (end - start) // BASE_MS or len(children) % ratio:
        raise ValueError("15m history has incorrect row count")
    out = []
    for i, child in enumerate(children):
        opened = start + i * BASE_MS
        if (child["timeframe"] != "15m" or child["openTime"] != opened or
            child["closeTime"] != opened + BASE_MS or child["availableAt"] != opened + BASE_MS or
            child["isClosed"] is not True or child["quality"] or
            not all(Decimal(child[k]).is_finite() and Decimal(child[k]) > 0
                    for k in ("open", "high", "low", "close")) or
            not Decimal(child["volume"]).is_finite() or Decimal(child["volume"]) < 0 or
            Decimal(child["high"]) < max(Decimal(child["open"]), Decimal(child["close"])) or
            Decimal(child["low"]) > min(Decimal(child["open"]), Decimal(child["close"]))):
            raise ValueError(f"Invalid, missing, open or misaligned 15m bar at {opened}")
    for offset in range(0, len(children), ratio):
        group = children[offset:offset + ratio]
        opened = group[0]["openTime"]
        close = group[-1]["closeTime"]
        if opened % (ratio * BASE_MS) or close != opened + ratio * BASE_MS:
            raise ValueError("Partial or misaligned higher-timeframe bar")
        out.append({
            "instrumentId": group[0]["instrumentId"], "timeframe": timeframe,
            "openTime": opened, "closeTime": close, "availableAt": close,
            "open": group[0]["open"],
            "high": str(max(Decimal(c["high"]) for c in group)),
            "low": str(min(Decimal(c["low"]) for c in group)),
            "close": group[-1]["close"],
            "volume": str(sum((Decimal(c["volume"]) for c in group), Decimal(0))),
            "isClosed": True, "quality": [],
        })
    return out


def compare(derived, official):
    if len(derived) != len(official):
        raise ValueError("Official timeframe row count mismatch")
    conflicts = []
    for d, o in zip(derived, official, strict=True):
        if (d["openTime"], d["closeTime"]) != (o["openTime"], o["closeTime"]):
            raise ValueError("Official timeframe alignment mismatch")
        differences = {k: {"canonical15m": d[k], "official": o[k]}
                       for k in ("open", "high", "low", "close", "volume")
                       if Decimal(d[k]) != Decimal(o[k])}
        if differences:
            conflicts.append({"openTime": d["openTime"], "differences": differences})
    return conflicts


def main():
    children = json.loads((ROOT / "normalized" / "15m" / "candles.json").read_bytes())
    results = {}
    for timeframe, ratio in RATIOS.items():
        derived = canonical_bars(children, timeframe, ratio)
        official = json.loads((ROOT / "normalized" / timeframe / "candles.json").read_bytes())
        conflicts = compare(derived, official)
        output = ROOT / "canonical" / timeframe
        output.mkdir(parents=True, exist_ok=True)
        payload = (json.dumps(derived, separators=(",", ":")) + "\n").encode()
        (output / "candles.json").write_bytes(payload)
        results[timeframe] = {"rows": len(derived), "sha256": hashlib.sha256(payload).hexdigest(),
                              "officialComparisonConflicts": conflicts}
    manifest = Path(__file__).resolve().parent / "RESEARCH_TARGET_V1.json"
    data = json.loads(manifest.read_text(encoding="utf-8"))
    data["canonicalPricePolicy"] = {
        "raw": "official checksum-verified 15m", "higherTimeframes": "deterministic UTC aggregate of 15m",
        "availability": "only at derived bar close", "officialHigherTimeframes": "QA only",
        "derived": results,
    }
    data["splitUtc"] = {
        "previousFinalOosStartInclusive": "2025-07-01T00:00:00Z",
        "previousFinalOosEndExclusive": "2026-10-01T00:00:00Z",
        "previousFinalOosStatus": "BURNED_FOR_RESEARCH_DIAGNOSTICS",
        "trueForwardHoldoutStart": "2026-10-01T00:00:00Z",
        "finalPristineOosAvailable": False,
        "walkForwardProtocol": "WALK_FORWARD_PROTOCOL_V1.md",
    }
    manifest.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({tf: {"rows": v["rows"], "conflicts": len(v["officialComparisonConflicts"])}
                      for tf, v in results.items()}))


if __name__ == "__main__":
    main()
