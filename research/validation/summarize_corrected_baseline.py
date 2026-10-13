"""Summarize the preregistered exploratory historical forward windows."""

from datetime import datetime
import json
from pathlib import Path

from alpha_baseline import metrics

ROOT = Path(__file__).resolve().parents[1] / "data" / "binance_btcusdt_v1"
PROTOCOL = Path(__file__).resolve().parent / "WALK_FORWARD_PROTOCOL_V1.md"
WINDOWS = [
    ("1", "2023-01-01T00:00:00Z", "2024-01-01T00:00:00Z"),
    ("2", "2024-01-01T00:00:00Z", "2025-01-01T00:00:00Z"),
    ("3", "2025-01-01T00:00:00Z", "2026-01-01T00:00:00Z"),
    ("4", "2026-01-01T00:00:00Z", "2026-10-01T00:00:00Z"),
]


def milliseconds(value):
    return int(datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp() * 1000)


def summarize(baseline, funnel, protocol_text):
    if ("BURNED_FOR_RESEARCH_DIAGNOSTICS" not in protocol_text or
            "TRUE_FORWARD_HOLDOUT_START = 2026-10-01T00:00:00Z" not in protocol_text):
        raise ValueError("Walk-forward protocol is missing burned OOS or true holdout lock")
    if baseline["dataset"]["strategyConfigStatus"] != "EXPLORATORY_TEST_SETTINGS_NO_PRODUCTION_COMPOSITION":
        raise ValueError("Production configuration status was silently changed")
    trades = baseline["tradeLedger"]
    if baseline["counts"]["closedTrades"] != len(trades):
        raise ValueError("Trade count mismatch")
    folds = []
    for name, start, end in WINDOWS:
        if start[:10] not in protocol_text or end[:10] not in protocol_text:
            raise ValueError("Window boundary differs from locked protocol")
        first, last = milliseconds(start), milliseconds(end)
        selected = [trade for trade in trades if first <= trade["entryTime"] and trade["exitTime"] <= last]
        folds.append({"fold": name, "forwardStart": start, "forwardEndExclusive": end,
                      "metrics": metrics(selected)})
    account = baseline["causalAccount"]
    if account is None or len(account["closedTrades"]) != len(trades):
        raise ValueError("Causal account and fill ledgers do not reconcile")
    return {
        "verdict": "CORRECTED_EXPLORATORY_NOT_PRODUCTION_EQUIVALENT",
        "productionConfigReplay": False,
        "causalAccountContext": True,
        "mtfDataCanonicalized": True,
        "previousOosStatus": "BURNED_FOR_RESEARCH_DIAGNOSTICS",
        "finalPristineOosAvailable": False,
        "trueForwardHoldoutStart": "2026-10-01T00:00:00Z",
        "decisionFunnel": funnel,
        "counts": baseline["counts"],
        "signalLevel": {"eligible": baseline["counts"]["signalEligible"],
                        "metrics": baseline["metrics"] if baseline["counts"]["riskAccountBlocked"] == 0 else None},
        "portfolioLevel": {"executed": len(trades), "metrics": baseline["metrics"],
                           "finalEquity": account["finalEquity"]},
        "direction": baseline["direction"],
        "walkForward": folds,
        "fundingEventsDuringPositions": sum(t["fundingEvents"] for t in account["closedTrades"]),
        "worseCostExpectancyR": baseline["worseCostSensitivity"]["metrics"]["netExpectancyR"],
        "optimizationAllowed": False,
    }


def main():
    baseline = json.loads((ROOT / "baseline" / "alpha_baseline.json").read_text())
    funnel = json.loads((ROOT / "exploratory_funnel.json").read_text())
    report = summarize(baseline, funnel, PROTOCOL.read_text(encoding="utf-8"))
    output = ROOT / "baseline" / "corrected_summary.json"
    output.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n")
    print(json.dumps({"verdict": report["verdict"], "foldCounts": [x["metrics"]["sampleSize"]
                     for x in report["walkForward"]], "sample": report["portfolioLevel"]["metrics"]["sampleStatus"]}))


if __name__ == "__main__":
    main()
