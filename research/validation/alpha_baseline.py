"""Deterministic OHLC validation of exported ULTE analysis/decision cycles.

This is a fill *assumption* layer. Signal, regime, target and invalidation values
must come from the existing engines; no strategy rule is reimplemented here.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
from decimal import Decimal, InvalidOperation, ROUND_HALF_EVEN, getcontext
from pathlib import Path


FAMILIES = {"TREND_PULLBACK_CONTINUATION", "BREAKOUT_RETEST", "LIQUIDITY_SWEEP_REVERSAL"}
REGIMES = {"TREND_UP", "TREND_DOWN", "RANGE", "COMPRESSION", "EXPANSION", "TRANSITION"}
Q = Decimal("0.000001")
getcontext().prec = 512
DECIMAL_PATTERN = re.compile(r"^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$")


def d(value):
    if (not isinstance(value, str) or not DECIMAL_PATTERN.fullmatch(value) or
        len(value.replace(".", "")) > 128):
        raise ValueError("price must be a fixed decimal string of at most 128 digits")
    try:
        result = Decimal(value)
    except InvalidOperation as exc:
        raise ValueError(f"invalid decimal: {value}") from exc
    if not result.is_finite() or result < 0:
        raise ValueError(f"non-finite or negative decimal: {value}")
    return result


def num(value):
    return str(value.quantize(Q, rounding=ROUND_HALF_EVEN)) if value is not None else None


def integer(value, name):
    if type(value) is not int or value < 0:
        raise ValueError(f"{name} must be a non-negative integer")
    return value


def bps(value, name):
    integer(value, name)
    if value > 10000:
        raise ValueError(f"{name} exceeds 10000 bps")
    return value


def validate(data):
    meta = data["metadata"]
    if not all(isinstance(meta.get(k), str) and meta[k] for k in
               ("datasetId", "instrumentId", "timeframe", "source", "codeRevision")):
        raise ValueError("dataset identity, instrument, timeframe, source and revision are required")
    config = data["config"]
    for key in ("entryFeeBps", "exitFeeBps", "entrySlippageBps", "exitSlippageBps", "spreadBps", "fundingBpsPerCandle"):
        bps(config[key], key)
    train_end = integer(config["trainEnd"], "trainEnd")
    validation_end = integer(config["validationEnd"], "validationEnd")
    if train_end >= validation_end:
        raise ValueError("chronological train/validation/test boundaries required")
    candles = data["candles"]
    if not candles:
        raise ValueError("historical candles required")
    prior = None
    for c in candles:
        start, end = integer(c["openTime"], "openTime"), integer(c["closeTime"], "closeTime")
        if start >= end or (prior is not None and start != prior):
            raise ValueError("candles must be ordered, contiguous and unique")
        if c["instrumentId"] != meta["instrumentId"] or c["timeframe"] != meta["timeframe"]:
            raise ValueError("candle identity mismatch")
        if c["isClosed"] is not True or "GAP_DETECTED" in c["quality"]:
            raise ValueError("open or gapped candle")
        o, h, l, close = (d(c[k]) for k in ("open", "high", "low", "close"))
        if min(o, h, l, close) <= 0 or h < max(o, close) or l > min(o, close):
            raise ValueError("invalid OHLC")
        prior = end
    if not (candles[0]["openTime"] < train_end < validation_end < candles[-1]["closeTime"]):
        raise ValueError("all three chronological segments need candles")
    seen = set()
    prior = -1
    for item in data["observations"]:
        a, decision = item["analysis"], item["decision"]
        asof = integer(a["analysisAsOf"], "analysisAsOf")
        if (asof <= prior or asof != a["triggerCloseTime"] or
            asof != decision["analysisAsOf"] or asof != decision["triggerCloseTime"]):
            raise ValueError("duplicate, unordered or mismatched analysis boundary")
        if decision["analysisCycleId"] != a["analysisCycleId"] or a["analysisCycleId"] in seen:
            raise ValueError("analysis/decision identity mismatch")
        if a["instrumentId"] != meta["instrumentId"]:
            raise ValueError("analysis instrument mismatch")
        for frame in a["frame"]["timeframes"]:
            previous_close = -1
            for snapshot in frame["candles"]:
                candle = snapshot["candle"]
                if (candle["timeframe"] != frame["timeframe"] or
                    candle["instrumentId"] != meta["instrumentId"] or
                    candle["isClosed"] is not True or candle["closeTime"] > asof or
                    candle["openTime"] < previous_close or
                    "GAP_DETECTED" in snapshot["quality"]):
                    raise ValueError("future, open, gapped or unordered analysis frame")
                previous_close = candle["closeTime"]
        if a["status"] in ("ANALYZED", "NO_SETUP"):
            regime = a["regime"]
            if regime["status"] == "READY" and (
                regime["primaryRegime"] not in REGIMES or regime["windowEnd"] > asof or
                regime["instrumentId"] != meta["instrumentId"] or
                regime["direction"] not in ("UP", "DOWN", "NEUTRAL") or
                regime["volatilityState"] not in ("COMPRESSION", "NORMAL", "EXPANSION")
            ):
                raise ValueError("future or unknown regime")
        seen.add(a["analysisCycleId"])
        prior = asof
    return candles, data["observations"], config


def segment(time, config):
    if time < config["trainEnd"]:
        return "TRAIN"
    if time < config["validationEnd"]:
        return "VALIDATION"
    return "TEST"


def metrics(trades):
    values = [Decimal(t["netR"]) for t in trades]
    count = len(values)
    if not count:
        return {"sampleSize": 0, "sampleStatus": "INSUFFICIENT_SAMPLE", "winRate": None,
                "lossRate": None, "averageWinR": None, "averageLossR": None,
                "netExpectancyR": None, "medianR": None, "profitFactor": None,
                "averageProjectedNetR": None, "fourRTargetRate": None,
                "totalNetR": None, "maxDrawdownR": None, "maxConsecutiveLosses": 0,
                "maxConsecutiveWins": 0, "averageHoldingCandles": None,
                "averageMfeR": None, "averageMaeR": None, "targetHitDistribution": None}
    wins = [v for v in values if v > 0]
    losses = [v for v in values if v < 0]
    ordered = sorted(values)
    median = ordered[count // 2] if count % 2 else (ordered[count // 2 - 1] + ordered[count // 2]) / 2
    equity = peak = drawdown = Decimal(0)
    streak_win = streak_loss = max_win = max_loss = 0
    for value in values:
        equity += value
        peak = max(peak, equity)
        drawdown = max(drawdown, peak - equity)
        streak_win = streak_win + 1 if value > 0 else 0
        streak_loss = streak_loss + 1 if value < 0 else 0
        max_win, max_loss = max(max_win, streak_win), max(max_loss, streak_loss)
    target = {str(i): sum(t["exitReason"] == "TARGET" and Decimal(t["realizedGrossR"]) >= i
                          for t in trades) for i in (1, 2, 3, 4)}
    return {
        "sampleSize": count, "sampleStatus": "INSUFFICIENT_SAMPLE" if count < 30 else "MEASURABLE",
        "winRate": num(Decimal(len(wins)) / count), "lossRate": num(Decimal(len(losses)) / count),
        "averageWinR": num(sum(wins) / len(wins)) if wins else None,
        "averageLossR": num(sum(losses) / len(losses)) if losses else None,
        "netExpectancyR": num(sum(values) / count), "medianR": num(median),
        "averageProjectedNetR": num(sum(Decimal(t["projectedNetR"]) for t in trades) / count),
        "fourRTargetRate": num(Decimal(target["4"]) / count),
        "profitFactor": num(sum(wins) / -sum(losses)) if losses else None,
        "totalNetR": num(equity), "maxDrawdownR": num(drawdown),
        "maxConsecutiveLosses": max_loss, "maxConsecutiveWins": max_win,
        "averageHoldingCandles": num(Decimal(sum(t["holdingCandles"] for t in trades)) / count),
        "averageMfeR": num(sum(Decimal(t["mfeR"]) for t in trades) / count),
        "averageMaeR": num(sum(Decimal(t["maeR"]) for t in trades) / count),
        "targetHitDistribution": target,
    }


def run(data):
    candles, observations, config = validate(data)
    meta = data["metadata"]
    by_open = {c["openTime"]: i for i, c in enumerate(candles)}
    trades, skipped = [], {"noDecision": 0, "rejected": 0, "overlap": 0, "noNextCandle": 0}
    no_decision_reasons, rejection_stages = {}, {}
    occupied_through = -1
    seen_candidates = set()
    unresolved = []
    for item in observations:
        a, decision = item["analysis"], item["decision"]
        if decision["status"] == "NO_DECISION":
            skipped["noDecision"] += 1
            reason = decision["reason"]
            no_decision_reasons[reason] = no_decision_reasons.get(reason, 0) + 1
            continue
        if decision["status"] == "DECISION_REJECTED":
            skipped["rejected"] += 1
            stage = decision["blockingStage"]
            rejection_stages[stage] = rejection_stages.get(stage, 0) + 1
            continue
        if decision["status"] != "TRADE_INTENT_CREATED":
            raise ValueError("unsupported decision status")
        risk, intent, candidate = decision["structuralRiskResult"], decision["tradeIntentResult"], decision["setupCandidate"]
        regime = a["regime"]
        if risk["status"] != "QUALIFIED" or intent["status"] != "INTENT_READY" or candidate["stage"] != "CONFIRMED":
            raise ValueError("signal lacks authoritative qualified intent")
        if (a["status"] != "ANALYZED" or a["setup"]["status"] != "READY" or
            candidate not in a["setup"]["candidates"]):
            raise ValueError("decision candidate absent from analysis cycle")
        if (candidate["family"] not in FAMILIES or candidate["id"] != risk["candidateId"] or
            candidate["id"] != intent["candidateId"] or candidate["asOf"] != a["analysisAsOf"] or
            risk["asOf"] != a["analysisAsOf"] or intent["asOf"] != a["analysisAsOf"] or
            candidate["instrumentId"] != meta["instrumentId"] or
            candidate["setupTimeframe"] != meta["timeframe"] or
            candidate["contextTimeframe"] != regime["timeframe"] or
            risk["instrumentId"] != meta["instrumentId"] or
            intent["instrumentId"] != meta["instrumentId"] or
            any(risk[k] != intent[k] for k in ("entryReferencePrice", "invalidationPrice", "primaryTargetPrice")) or
            risk["direction"] != intent["direction"] or risk["family"] != intent["family"] or
            not isinstance(risk["netRewardRiskBps"], str) or
            not risk["netRewardRiskBps"].isdigit() or
            int(risk["netRewardRiskBps"]) < 30000):
            raise ValueError("incoherent or below-minimum official signal")
        if candidate["id"] in seen_candidates:
            skipped["rejected"] += 1
            rejection_stages["REPEATED_CANDIDATE"] = rejection_stages.get("REPEATED_CANDIDATE", 0) + 1
            continue
        seen_candidates.add(candidate["id"])
        if regime["status"] != "READY":
            raise ValueError("accepted signal lacks ready regime")
        index = by_open.get(a["analysisAsOf"])
        if index is None:
            skipped["noNextCandle"] += 1
            continue
        if index <= occupied_through:
            skipped["overlap"] += 1
            continue
        direction = 1 if intent["direction"] == "UP" else -1
        stop, target = d(intent["invalidationPrice"]), d(intent["primaryTargetPrice"])
        fee_in = Decimal(config["entryFeeBps"]) / 10000
        fee_out = Decimal(config["exitFeeBps"]) / 10000
        slip_in = Decimal(config["entrySlippageBps"] + config["spreadBps"]) / 10000
        slip_out = Decimal(config["exitSlippageBps"] + config["spreadBps"]) / 10000
        entry = d(candles[index]["open"]) * (1 + direction * slip_in)
        if entry <= 0 or direction * (entry - stop) <= 0 or direction * (target - entry) <= 0:
            raise ValueError("next-open entry invalidates structural stop/target")
        risk_unit = abs(entry - stop) + entry * fee_in + stop * fee_out
        mfe = mae = Decimal(0)
        exit_price = None
        exit_reason = None
        for j in range(index, len(candles)):
            c = candles[j]
            high, low, opening = d(c["high"]), d(c["low"]), d(c["open"])
            hit_stop = low <= stop if direction == 1 else high >= stop
            hit_target = high >= target if direction == 1 else low <= target
            if hit_stop:
                base = min(opening, stop) if direction == 1 else max(opening, stop)
                exit_price = base * (1 - direction * slip_out)
                exit_reason = "STOP" if not hit_target else "BOTH_STOP_FIRST"
            elif hit_target:
                exit_price = target * (1 - direction * slip_out)
                exit_reason = "TARGET"
            if exit_price is not None:
                # The path within the exit candle is unknown. Include only the
                # opening and the proven exit barrier, never its opposite wick.
                mfe = max(mfe, direction * (opening - entry))
                mae = max(mae, direction * (entry - opening))
                if hit_target and not hit_stop:
                    mfe = max(mfe, direction * (target - entry))
                if hit_stop:
                    mae = max(mae, direction * (entry - stop))
                break
            mfe = max(mfe, (high - entry) if direction == 1 else (entry - low))
            mae = max(mae, (entry - low) if direction == 1 else (high - entry))
        if exit_price is None:
            unresolved.append(candidate["id"])
            occupied_through = len(candles) - 1
            continue
        gross = direction * (exit_price - entry)
        funding = entry * Decimal(config["fundingBpsPerCandle"]) * (j - index + 1) / 10000
        net = gross - entry * fee_in - exit_price * fee_out - funding
        trade = {
            "candidateId": candidate["id"], "family": candidate["family"],
            "regime": regime["primaryRegime"], "direction": intent["direction"],
            "regimeDirection": regime["direction"], "volatilityState": regime["volatilityState"],
            "timeframePair": f"{candidate['contextTimeframe']}->{candidate['setupTimeframe']}",
            "decisionTime": a["analysisAsOf"], "entryTime": candles[index]["openTime"],
            "exitTime": candles[j]["closeTime"], "segment": segment(candles[index]["openTime"], config),
            "entryPrice": str(entry), "exitPrice": str(exit_price), "stop": str(stop), "target": str(target),
            "exitReason": exit_reason, "holdingCandles": j - index + 1,
            "splitEligible": (segment(candles[index]["openTime"], config) ==
                              segment(candles[j]["closeTime"] - 1, config)),
            "projectedNetR": num(Decimal(risk["netRewardRiskBps"]) / 10000),
            "realizedGrossR": num(gross / risk_unit), "netR": num(net / risk_unit),
            "mfeR": num(mfe / risk_unit), "maeR": num(mae / risk_unit),
        }
        trades.append(trade)
        occupied_through = j
    groups = lambda key: {name: metrics([t for t in trades if t[key] == name]) for name in sorted({t[key] for t in trades})}
    equity = Decimal(0)
    curve = []
    for trade in trades:
        equity += Decimal(trade["netR"])
        curve.append({"exitTime": trade["exitTime"], "netR": num(equity)})
    total_period = candles[-1]["closeTime"] - candles[0]["openTime"]
    exposure = sum(t["exitTime"] - t["entryTime"] for t in trades)
    return {
        "certified": False,
        "eligibleForEvidenceReview": not unresolved and skipped["noNextCandle"] == 0 and
            len(trades) >= 30 and
            sum(t["segment"] == "TEST" and t["splitEligible"] for t in trades) >= 30,
        "dataset": data["metadata"], "period": [candles[0]["openTime"], candles[-1]["closeTime"]],
        "config": config, "counts": {"candles": len(candles), "observations": len(observations), **skipped,
                                     "closedTrades": len(trades), "unresolved": len(unresolved),
                                     "crossBoundaryTrades": sum(not t["splitEligible"] for t in trades)},
        "unresolvedCandidateIds": unresolved, "metrics": metrics(trades),
        "noDecisionReasons": no_decision_reasons, "rejectionStages": rejection_stages,
        "split": {name: metrics([t for t in trades if t["segment"] == name and t["splitEligible"]])
                  for name in ("TRAIN", "VALIDATION", "TEST")},
        "regime": groups("regime"), "setup": groups("family"),
        "regimeDirection": groups("regimeDirection"), "volatilityState": groups("volatilityState"),
        "mtf": groups("timeframePair"),
        "score": {"status": "UNAVAILABLE_IN_CURRENT_STACK"},
        "tradeFrequencyPer30Days": num(Decimal(len(trades)) * 30 * 86400000 / total_period),
        "exposureFraction": num(Decimal(exposure) / total_period),
        "tradeLedger": trades, "equityCurve": curve,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    args = parser.parse_args()
    payload = args.input.read_bytes()
    data = json.loads(payload)
    result = run(data)
    result["inputSha256"] = hashlib.sha256(payload).hexdigest()
    args.output_dir.mkdir(parents=True, exist_ok=True)
    (args.output_dir / "alpha_baseline.json").write_text(json.dumps(result, indent=2, sort_keys=True) + "\n")
    (args.output_dir / "alpha_baseline.txt").write_text(
        f"Certified: {result['certified']}\nDataset: {result['dataset']['datasetId']}\n"
        f"Closed trades: {result['counts']['closedTrades']}\n"
        f"Net expectancy R: {result['metrics']['netExpectancyR']}\n"
        f"Unresolved: {result['counts']['unresolved']}\n")


if __name__ == "__main__":
    main()
