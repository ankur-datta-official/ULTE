"""Signal-level outcomes and counterfactual paths from shared-engine decisions.

This file simulates only the disclosed 15m fill path. It does not implement
regime, setup, target discovery, qualification, or portfolio sizing rules.
"""

from __future__ import annotations

from collections import Counter
from decimal import Decimal
import hashlib
import json
from pathlib import Path

from alpha_baseline import metrics, num
from structural_coverage_diagnostic import path_diagnostic

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent / "data" / "core_universe_v1"
BTC = HERE.parent / "data" / "binance_btcusdt_v1"
POLICY_PATH = HERE / "ALPHA_RESEARCH_POLICY_V1.json"
POLICY = json.loads(POLICY_PATH.read_text(encoding="utf-8"))
CUTOFF = 1790812800000
FEE_IN = Decimal(POLICY["costs"]["entryFeeBps"]) / 10000
FEE_OUT = Decimal(POLICY["costs"]["exitFeeBps"]) / 10000
SLIP_IN = Decimal(POLICY["costs"]["entrySlippageBps"] + POLICY["costs"]["spreadBps"]) / 10000
SLIP_OUT = Decimal(POLICY["costs"]["exitSlippageBps"] + POLICY["costs"]["spreadBps"]) / 10000


def d(value):
    result = Decimal(value)
    if not result.is_finite():
        raise ValueError("Nonfinite monetary or price input")
    return result


def sample_label(n):
    if n < 30:
        return "VERY_INSUFFICIENT"
    if n < 50:
        return "INSUFFICIENT"
    if n < 100:
        return "LIMITED"
    if n < 200:
        return "USABLE_BASELINE"
    return "STRONGER_RESEARCH_BASELINE"


def simulate(row, bars, by_open, funding):
    index = by_open.get(row["asOf"])
    if index is None:
        return None, "NO_NEXT_15M_BAR"
    direction = 1 if row["direction"] == "UP" else -1
    stop, target = d(row["invalidationPrice"]), d(row["primaryTargetPrice"])
    entry = d(bars[index]["open"]) * (1 + direction * SLIP_IN)
    if entry <= 0 or direction * (entry - stop) <= 0 or direction * (target - entry) <= 0:
        return None, "NEXT_OPEN_INVALIDATES_GEOMETRY"
    risk_unit = abs(entry - stop) + entry * FEE_IN + stop * FEE_OUT
    mfe = mae = Decimal(0)
    first_funding = 0
    while first_funding < len(funding) and funding[first_funding]["time"] < row["asOf"]:
        first_funding += 1
    funding_cursor = first_funding
    funding_amount = Decimal(0)
    funding_count = 0
    for j in range(index, len(bars)):
        bar = bars[j]
        high, low, opened = d(bar["high"]), d(bar["low"]), d(bar["open"])
        stop_hit = low <= stop if direction == 1 else high >= stop
        target_hit = high >= target if direction == 1 else low <= target
        raw_exit = None
        reason = None
        if stop_hit:
            raw_exit = min(opened, stop) if direction == 1 else max(opened, stop)
            reason = "BOTH_STOP_FIRST" if target_hit else "STOP"
        elif target_hit:
            raw_exit = target
            reason = "TARGET"
        if raw_exit is not None:
            mfe = max(mfe, direction * (opened - entry), Decimal(0))
            mae = max(mae, direction * (entry - opened), Decimal(0))
            if target_hit and not stop_hit:
                mfe = max(mfe, direction * (target - entry))
            if stop_hit:
                mae = max(mae, direction * (entry - stop))
        else:
            mfe = max(mfe, (high - entry) if direction == 1 else (entry - low), Decimal(0))
            mae = max(mae, (entry - low) if direction == 1 else (high - entry), Decimal(0))
        while funding_cursor < len(funding) and funding[funding_cursor]["time"] <= bar["closeTime"]:
            event = funding[funding_cursor]
            rate = direction * d(event["rate"])
            if event["time"] == row["asOf"] or raw_exit is not None:
                rate = max(rate, Decimal(0))
            funding_amount += entry * rate
            funding_count += 1
            funding_cursor += 1
        if raw_exit is None:
            continue
        exit_price = raw_exit * (1 - direction * SLIP_OUT)
        gross = direction * (exit_price - entry)
        net = gross - entry * FEE_IN - exit_price * FEE_OUT - funding_amount
        return {"symbol": row["symbol"], "candidateId": row["candidateId"],
                "direction": row["direction"], "family": row["family"],
                "regime": row["regime"], "decisionTime": row["asOf"],
                "entryTime": row["asOf"], "exitTime": bar["closeTime"],
                "entryPrice": str(entry), "exitPrice": str(exit_price),
                "exitReason": reason, "holdingCandles": (j - index) // 4 + 1,
                "fundingEvents": funding_count, "fundingAmountPerQuantity": str(funding_amount),
                "projectedNetR": num(d(row["netRewardRiskBps"]) / 10000),
                "realizedGrossR": num(gross / risk_unit), "netR": num(net / risk_unit),
                "mfeR": num(mfe / risk_unit), "maeR": num(mae / risk_unit)}, None
    return None, "RIGHT_CENSORED_AT_CUTOFF"


def percentages(confirmed, target, no_target, below, eligible):
    def pct(value):
        return num(Decimal(100) * value / confirmed) if confirmed else None
    return {"confirmed": confirmed, "validStructuralTarget": target,
            "targetCoveragePct": pct(target), "noTargetPct": pct(no_target),
            "belowRrPct": pct(below), "executablePct": pct(eligible)}


def summarize_symbol(symbol):
    replay = json.loads((ROOT / symbol / "signal_replay.json").read_text(encoding="utf-8"))
    if replay["symbol"] != symbol or replay["policyId"] != POLICY["id"] or \
       replay["policySha256"] != hashlib.sha256(POLICY_PATH.read_bytes()).hexdigest() or \
       replay["historicalEndExclusive"] != POLICY["historicalEndExclusive"]:
        raise ValueError(f"Replay provenance mismatch for {symbol}")
    path = (BTC / "normalized" / "15m" / "candles.json") if symbol == "BTCUSDT" else \
           (ROOT / symbol / "canonical" / "15m" / "candles.json")
    payload = path.read_bytes()
    if hashlib.sha256(payload).hexdigest() != replay["canonical15mSha256"]:
        raise ValueError(f"Canonical 15m path changed for {symbol}")
    bars = json.loads(payload)
    funding_path = (BTC if symbol == "BTCUSDT" else ROOT / symbol) / "normalized" / "fundingRate" / "funding.json"
    funding = json.loads(funding_path.read_text(encoding="utf-8"))
    if bars[-1]["closeTime"] != CUTOFF or any(x["time"] >= CUTOFF for x in funding):
        raise ValueError("Reserved future data entered baseline")
    by_open = {bar["openTime"]: i for i, bar in enumerate(bars)}
    if len(by_open) != len(bars):
        raise ValueError("Duplicate canonical detail bar")
    funnel = replay["funnel"]
    rows = replay["candidates"]
    if len(rows) != funnel["CONFIRMED_CANDIDATES"]:
        raise ValueError("Confirmed candidate count mismatch")
    reasons = Counter(row["reason"] for row in rows)
    if reasons["NO_STRUCTURAL_TARGET"] != funnel["NO_STRUCTURAL_TARGET"] or \
       reasons["NET_RR_BELOW_MINIMUM"] != funnel["BELOW_RR"] or \
       reasons["COSTS_CONSUME_REWARD"] != funnel["COST_BLOCKED"]:
        raise ValueError("Shared risk funnel mismatch")
    no_target_reasons = Counter(row["targetReason"] for row in rows if row["reason"] == "NO_STRUCTURAL_TARGET")
    trades = []
    unexecuted = Counter()
    diagnostic = {"NO_STRUCTURAL_TARGET": [], "NET_RR_BELOW_MINIMUM": []}
    diagnostic_records = []
    for row in rows:
        if row["reason"] in diagnostic:
            if row["asOf"] in by_open:
                path_result = path_diagnostic(row, bars,
                    start=bars[0]["openTime"], cutoff=CUTOFF)
                diagnostic[row["reason"]].append(path_result)
                diagnostic_records.append({"candidateId": row["candidateId"],
                                           "reason": row["reason"], "asOf": row["asOf"],
                                           **path_result})
            else:
                unexecuted["DIAGNOSTIC_NO_NEXT_BAR"] += 1
        if row["reason"] == "QUALIFIED" and not row["multipleActionable"]:
            trade, skip = simulate({**row, "symbol": symbol}, bars, by_open, funding)
            if trade is not None:
                trades.append(trade)
            else:
                unexecuted[skip] += 1
    if funnel["SIGNAL_ELIGIBLE"] != len(trades) + sum(v for k, v in unexecuted.items()
                                                     if k != "DIAGNOSTIC_NO_NEXT_BAR"):
        raise ValueError("Signal eligibility does not reconcile to independent execution paths")
    target = sum(row["primaryTargetPrice"] is not None for row in rows)
    (ROOT / symbol / "candidate_diagnostics.json").write_text(
        json.dumps(diagnostic_records, indent=2) + "\n", encoding="utf-8")
    coverage = percentages(len(rows), target, reasons["NO_STRUCTURAL_TARGET"],
                           reasons["NET_RR_BELOW_MINIMUM"], funnel["SIGNAL_ELIGIBLE"])
    return {"symbol": symbol, "periodStartInclusive": replay["historicalStartInclusive"],
            "funnel": {**funnel, "EXECUTED_RESEARCH_TRADES": len(trades)},
            "targetCoverage": coverage, "noTargetReasonDistribution": dict(no_target_reasons),
            "unexecutedReasons": dict(unexecuted), "metrics": metrics(trades),
            "sampleAdequacy": sample_label(len(trades)), "tradeLedger": trades,
            "diagnostic": diagnostic}


def diagnostic_summary(paths):
    n = len(paths)
    stopped = [x for x in paths if not x["censoredAtDatasetEnd"]]
    ordered = sorted(d(x["mfeLowerR"]) for x in paths)
    median = ((ordered[n // 2 - 1] + ordered[n // 2]) / 2 if n % 2 == 0 else ordered[n // 2]) if n else None
    return {"sampleCount": n, "stopped": len(stopped),
            "rightCensored": n - len(stopped),
            "mfeLowerRAtLeast": {str(threshold): sum(d(x["mfeLowerR"]) >= threshold for x in paths)
                                  for threshold in (1, 2, 3, 4)},
            "stoppedMfeLowerRAtLeast": {str(threshold): sum(d(x["mfeLowerR"]) >= threshold for x in stopped)
                                         for threshold in (1, 2, 3, 4)},
            "mfeUpperRAtLeast": {str(threshold): sum(d(x["mfeUpperR"]) >= threshold for x in paths)
                                  for threshold in (1, 2, 3, 4)},
            "medianMfeLowerR": num(median),
            "meanMfeLowerR": num(sum((d(x["mfeLowerR"]) for x in paths), Decimal(0)) / n) if n else None,
            "meanMaeLowerR": num(sum((d(x["maeLowerR"]) for x in paths), Decimal(0)) / n) if n else None,
            "maxAvailableConservativeR": num(max(d(x["mfeLowerR"]) for x in paths)) if n else None,
            "maxStoppedConservativeR": num(max(d(x["mfeLowerR"]) for x in stopped)) if stopped else None}


def main():
    symbols = {symbol: summarize_symbol(symbol) for symbol in POLICY["coreUniverse"]}
    aggregate_funnel = {key: sum(item["funnel"][key] for item in symbols.values())
                        for key in next(iter(symbols.values()))["funnel"]}
    trades = sorted((trade for item in symbols.values() for trade in item["tradeLedger"]),
                    key=lambda x: (x["exitTime"], POLICY["coreUniverse"].index(x["symbol"]), x["candidateId"]))
    confirmed = aggregate_funnel["CONFIRMED_CANDIDATES"]
    target = sum(item["targetCoverage"]["validStructuralTarget"] for item in symbols.values())
    aggregate_coverage = percentages(confirmed, target, aggregate_funnel["NO_STRUCTURAL_TARGET"],
                                     aggregate_funnel["BELOW_RR"], aggregate_funnel["SIGNAL_ELIGIBLE"])
    aggregate_diagnostic = {reason: diagnostic_summary([path for item in symbols.values()
                                                        for path in item["diagnostic"][reason]])
                            for reason in ("NO_STRUCTURAL_TARGET", "NET_RR_BELOW_MINIMUM")}
    no_target_reasons = Counter()
    for item in symbols.values():
        no_target_reasons.update(item["noTargetReasonDistribution"])
        item["diagnosticSummary"] = {reason: diagnostic_summary(paths)
                                     for reason, paths in item.pop("diagnostic").items()}
    result = {"policyId": POLICY["id"], "policyStatus": POLICY["status"],
              "historicalEndExclusive": POLICY["historicalEndExclusive"],
              "universe": POLICY["coreUniverse"], "bySymbol": symbols,
              "aggregate": {"funnel": aggregate_funnel, "targetCoverage": aggregate_coverage,
                            "noTargetReasonDistribution": dict(no_target_reasons),
                            "metrics": metrics(trades), "sampleAdequacy": sample_label(len(trades)),
                            "diagnosticSummary": aggregate_diagnostic,
                            "tradeLedger": trades}}
    (ROOT / "core_universe_baseline.json").write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"funnel": aggregate_funnel, "sample": result["aggregate"]["sampleAdequacy"],
                      "targetCoverage": aggregate_coverage, "metrics": result["aggregate"]["metrics"],
                      "diagnostics": aggregate_diagnostic}, indent=2))


if __name__ == "__main__":
    main()
