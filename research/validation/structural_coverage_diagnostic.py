"""Research-only structural coverage and post-decision path diagnostics.

No counterfactual here produces an order, target, or new strategy result.
"""

from collections import Counter, defaultdict
import csv
from decimal import Decimal, getcontext
from itertools import islice
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1] / "data" / "binance_btcusdt_v1"
REPORT = Path(__file__).resolve().parent / "STRUCTURAL_COVERAGE_205_CANDIDATES.csv"
CUTOFF = 1790812800000  # 2026-10-01T00:00:00Z, exclusive
START = 1577836800000
QUARTER = 900000
getcontext().prec = 80


def decimal(value):
    result = Decimal(value)
    if not result.is_finite():
        raise ValueError("Nonfinite diagnostic price")
    return result


def ratio(numerator, denominator):
    return numerator / denominator if denominator > 0 else None


def bucket(value):
    if value < 1:
        return "LT_1R"
    if value < 2:
        return "1_TO_LT_2R"
    if value < 3:
        return "2_TO_LT_3R"
    if value < 4:
        return "3_TO_LT_4R"
    return "4R_PLUS"


def median_decimal(values):
    ordered = sorted(values)
    midpoint = len(ordered) // 2
    return ((ordered[midpoint - 1] + ordered[midpoint]) / 2
            if len(ordered) % 2 == 0 else ordered[midpoint])


def path_diagnostic(row, candles):
    """Conservative favorable path to first stop touch, or dataset censoring."""
    entry = decimal(row["entryReferencePrice"])
    stop = decimal(row["invalidationPrice"])
    direction = 1 if row["direction"] == "UP" else -1
    gross_risk = direction * (entry - stop)
    if gross_risk <= 0:
        raise ValueError("Invalid entry/invalidation direction")
    start_index = (row["asOf"] - START) // QUARTER
    if start_index < 0 or start_index >= len(candles) or candles[start_index]["openTime"] != row["asOf"]:
        raise ValueError("Missing aligned next 15m bar")
    mfe_lower = mfe_upper = mae_lower = Decimal(0)
    stopped_at = None
    bars = 0
    for candle in islice(candles, start_index, None):
        if candle["closeTime"] > CUTOFF:
            raise ValueError("Future holdout entered counterfactual path")
        opened, high, low = map(decimal, (candle["open"], candle["high"], candle["low"]))
        bars += 1
        hit_stop = low <= stop if direction == 1 else high >= stop
        favorable = high - entry if direction == 1 else entry - low
        adverse = entry - low if direction == 1 else high - entry
        at_open_favorable = direction * (opened - entry)
        at_open_adverse = direction * (entry - opened)
        if hit_stop:
            # Ordering inside this 15m bar is unknown. A favorable wick may
            # have preceded the stop, but only the open is certain before it.
            mfe_lower = max(mfe_lower, at_open_favorable, Decimal(0))
            mfe_upper = max(mfe_upper, favorable, Decimal(0))
            mae_lower = max(mae_lower, gross_risk, at_open_adverse, Decimal(0))
            stopped_at = candle["closeTime"]
            break
        mfe_lower = max(mfe_lower, favorable, Decimal(0))
        mfe_upper = max(mfe_upper, favorable, Decimal(0))
        mae_lower = max(mae_lower, adverse, Decimal(0))
    return {
        "censoredAtDatasetEnd": stopped_at is None,
        "stopObservationTime": stopped_at,
        "observedBars": bars,
        "grossRiskDistance": str(gross_risk),
        "mfeLowerDistance": str(mfe_lower), "mfeUpperDistance": str(mfe_upper),
        "maeLowerDistance": str(mae_lower),
        "mfeLowerR": str(mfe_lower / gross_risk),
        "mfeUpperR": str(mfe_upper / gross_risk),
        "maeLowerR": str(mae_lower / gross_risk),
    }


def coverage_matrix(rows, key):
    groups = defaultdict(list)
    for row in rows:
        groups[row[key]].append(row)
    return {name: {
        "confirmed": len(items),
        "targetAvailable": sum(item["primaryTargetPrice"] is not None for item in items),
        "noTarget": sum(item["reason"] == "NO_STRUCTURAL_TARGET" for item in items),
        "below3R": sum(item["reason"] == "NET_RR_BELOW_MINIMUM" for item in items),
        "costConsumed": sum(item["reason"] == "COSTS_CONSUME_REWARD" for item in items),
        "qualified": sum(item["reason"] == "QUALIFIED" for item in items),
    } for name, items in sorted(groups.items())}


def summarize(rows, cost_assumptions):
    reasons = Counter(row["reason"] for row in rows)
    no_target = [row for row in rows if row["reason"] == "NO_STRUCTURAL_TARGET"]
    below = [row for row in rows if row["reason"] == "NET_RR_BELOW_MINIMUM"]
    consumed = [row for row in rows if row["reason"] == "COSTS_CONSUME_REWARD"]
    if reasons != {"NO_STRUCTURAL_TARGET": 150, "NET_RR_BELOW_MINIMUM": 46,
                   "COSTS_CONSUME_REWARD": 5, "QUALIFIED": 4}:
        raise ValueError(f"Historical funnel changed: {reasons}")
    no_target_reasons = Counter(row["targetReason"] for row in no_target)
    if no_target_reasons.get("TARGET_FINDER_MISMATCH", 0):
        raise ValueError("Target finder missed an eligible level")
    for row in rows:
        entry, stop = decimal(row["entryReferencePrice"]), decimal(row["invalidationPrice"])
        target = row["primaryTargetPrice"]
        gross_risk = abs(entry - stop)
        gross_reward = abs(decimal(target) - entry) if target is not None else None
        gross_rr = ratio(gross_reward, gross_risk) if gross_reward is not None else None
        row["grossRewardRiskDiagnostic"] = str(gross_rr) if gross_rr is not None else None
        if row["grossReward"] is not None and decimal(row["grossReward"]) != gross_reward:
            raise ValueError("Diagnostic reward geometry differs from shared engine")
        if row["grossRisk"] is not None and decimal(row["grossRisk"]) != gross_risk:
            raise ValueError("Diagnostic risk geometry differs from shared engine")
        if row["netReward"] is not None:
            net_rr = decimal(row["netReward"]) / decimal(row["netRisk"])
            row["netRewardRiskDiagnostic"] = str(net_rr)
            row["costDragR"] = str(gross_rr - net_rr)
        elif target is not None:
            entry_cost = entry * Decimal(cost_assumptions["entryCostBps"]) / 10000
            target_cost = decimal(target) * Decimal(cost_assumptions["targetExitCostBps"]) / 10000
            stop_cost = stop * Decimal(cost_assumptions["stopExitCostBps"]) / 10000
            net_reward = gross_reward - entry_cost - target_cost
            net_risk = gross_risk + entry_cost + stop_cost
            row["netRewardRiskDiagnostic"] = str(net_reward / net_risk)
            row["costDragR"] = str(gross_rr - net_reward / net_risk)
            row["costToGrossReward"] = str((entry_cost + target_cost) / gross_reward)
        else:
            row["netRewardRiskDiagnostic"] = None
            row["costDragR"] = None
    for row in no_target + below:
        if "pathDiagnostic" not in row:
            raise ValueError("Missing post-decision diagnostic path")
    def path_summary(items):
        observed = [row for row in items if not row["pathDiagnostic"]["censoredAtDatasetEnd"]]
        lower = [decimal(row["pathDiagnostic"]["mfeLowerR"]) for row in items]
        upper = [decimal(row["pathDiagnostic"]["mfeUpperR"]) for row in items]
        adverse = [decimal(row["pathDiagnostic"]["maeLowerR"]) for row in items]
        return {
            "count": len(items), "stopped": len(observed), "rightCensored": len(items) - len(observed),
            "potentialBucketsLower": dict(Counter(bucket(value) for value in lower)),
            "mfeLower3RPlus": sum(value >= 3 for value in lower),
            "mfeUpper3RPlus": sum(value >= 3 for value in upper),
            "mfeLower3RPlusRate": str(Decimal(sum(value >= 3 for value in lower)) / len(items)),
            "mfeUpper3RPlusRate": str(Decimal(sum(value >= 3 for value in upper)) / len(items)),
            "medianMfeLowerR": str(median_decimal(lower)) if items else None,
            "medianMaeLowerR": str(median_decimal(adverse)) if items else None,
        }
    below_gross = [decimal(row["grossRewardRiskDiagnostic"]) for row in below]
    below_net = [decimal(row["netRewardRiskDiagnostic"]) for row in below]
    below_drag = [decimal(row["costDragR"]) for row in below]
    return {
        "confirmedCandidates": len(rows), "reasons": dict(reasons),
        "noTargetReasonBreakdown": dict(no_target_reasons),
        "targetCoverageBy": {key: coverage_matrix(rows, key) for key in
                             ("direction", "regime", "family", "contextTimeframe",
                              "structureState", "volatilityState")},
        "noTargetPath": path_summary(no_target),
        "below3RPath": path_summary(below),
        "below3R": {
            "grossRRMin": str(min(below_gross)), "grossRRMax": str(max(below_gross)),
            "grossRRMedian": str(median_decimal(below_gross)),
            "netRRMin": str(min(below_net)), "netRRMax": str(max(below_net)),
            "netRRMedian": str(median_decimal(below_net)),
            "costDragRMin": str(min(below_drag)), "costDragRMax": str(max(below_drag)),
            "costDragRMedian": str(median_decimal(below_drag)),
            "grossBelow3R": sum(value < 3 for value in below_gross),
            "grossAtLeast3RButNetBelow3R": sum(value >= 3 for value in below_gross),
        },
        "costConsumed": [{k: row[k] for k in
                          ("utc", "candidateId", "direction", "entryReferencePrice",
                           "invalidationPrice", "primaryTargetPrice", "grossRewardRiskDiagnostic",
                           "netRewardRiskDiagnostic", "costToGrossReward", "costDragR")}
                         for row in consumed],
    }


def main():
    source = json.loads((ROOT / "structural_candidates.json").read_text(encoding="utf-8"))
    candles = json.loads((ROOT / "normalized" / "15m" / "candles.json").read_text(encoding="utf-8"))
    if (source["historicalEndExclusive"] != CUTOFF or len(candles) != (CUTOFF - START) // QUARTER or
            candles[-1]["closeTime"] != CUTOFF or any(row["asOf"] >= CUTOFF for row in source["rows"])):
        raise ValueError("Historical source crosses the reserved future holdout")
    rows = source["rows"]
    for row in rows:
        if row["reason"] in ("NO_STRUCTURAL_TARGET", "NET_RR_BELOW_MINIMUM"):
            row["pathDiagnostic"] = path_diagnostic(row, candles)
    summary = summarize(rows, source["costAssumptions"])
    (ROOT / "structural_coverage_diagnostic.json").write_text(
        json.dumps({"summary": summary, "candidates": rows}, indent=2) + "\n", encoding="utf-8")
    columns = ("utc", "candidateId", "direction", "regime", "family", "contextTimeframe",
               "setupTimeframe", "volatilityState", "structureState", "entryReferencePrice",
               "invalidationPrice", "primaryTargetPrice", "targetSearchResult", "targetLevelCount",
               "grossRewardRiskDiagnostic", "netRewardRiskDiagnostic", "costDragR",
               "entryCost", "targetExitCost", "stopExitCost", "reason", "targetReason",
               "mfeLowerR", "mfeUpperR", "maeLowerR", "stoppedAt", "rightCensored")
    with REPORT.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=columns)
        writer.writeheader()
        for row in rows:
            path = row.get("pathDiagnostic", {})
            writer.writerow({
                **{name: row.get(name) for name in columns},
                "targetSearchResult": "TARGET_FOUND" if row["primaryTargetPrice"] else "NO_TARGET",
                "targetLevelCount": len(row["targetPath"]),
                "mfeLowerR": path.get("mfeLowerR"), "mfeUpperR": path.get("mfeUpperR"),
                "maeLowerR": path.get("maeLowerR"), "stoppedAt": path.get("stopObservationTime"),
                "rightCensored": path.get("censoredAtDatasetEnd"),
            })
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
