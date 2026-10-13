"""Mechanical fixtures only; these are not historical alpha evidence."""

import copy
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from alpha_baseline import main, run, sample_status, uncertainty
from decimal import Decimal


def fixture():
    candles = []
    for i, (opening, high, low, close) in enumerate([
        ("100", "101", "99", "100"),
        ("100", "101", "99", "100"),
        ("100", "101", "99", "100"),
        ("100", "131", "89", "105"),
        ("105", "106", "104", "105"),
        ("105", "106", "104", "105"),
    ]):
        candles.append({"instrumentId": "TEST", "timeframe": "1m", "openTime": i * 60000,
                        "closeTime": (i + 1) * 60000, "open": opening, "high": high,
                        "low": low, "close": close, "isClosed": True, "quality": ["SNAPSHOT"]})
    risk = {"status": "QUALIFIED", "candidateId": "c1", "family": "BREAKOUT_RETEST",
            "instrumentId": "TEST",
            "direction": "UP", "asOf": 180000, "entryReferencePrice": "100",
            "invalidationPrice": "90", "primaryTargetPrice": "130", "netRewardRiskBps": "30000"}
    intent = {"status": "INTENT_READY", "candidateId": "c1", "family": "BREAKOUT_RETEST",
              "instrumentId": "TEST",
              "direction": "UP", "asOf": 180000, "entryReferencePrice": "100",
              "invalidationPrice": "90", "primaryTargetPrice": "130"}
    candidate = {"id": "c1", "family": "BREAKOUT_RETEST", "stage": "CONFIRMED",
                 "instrumentId": "TEST", "contextTimeframe": "5m",
                 "setupTimeframe": "1m", "asOf": 180000}
    observation = {"analysis": {"analysisCycleId": "a1", "instrumentId": "TEST",
                                "analysisAsOf": 180000, "triggerCloseTime": 180000,
                                "status": "ANALYZED", "regime": {"status": "READY",
                                "primaryRegime": "TREND_UP", "direction": "UP",
                                "volatilityState": "NORMAL", "windowEnd": 180000,
                                "instrumentId": "TEST", "timeframe": "5m"},
                                "setup": {"status": "READY", "candidates": [candidate]},
                                "frame": {"timeframes": [{"timeframe": "1m", "candles": [
                                    {"candle": c, "quality": c["quality"]} for c in candles[:3]]}]}},
                   "decision": {"analysisCycleId": "a1", "analysisAsOf": 180000,
                                "triggerCloseTime": 180000, "status": "TRADE_INTENT_CREATED",
                                "setupCandidate": candidate,
                                "structuralRiskResult": risk, "tradeIntentResult": intent}}
    return {"metadata": {"datasetId": "mechanical-test-only", "instrumentId": "TEST",
                         "timeframe": "1m", "source": "fixture", "codeRevision": "test"},
            "config": {"trainEnd": 120000, "validationEnd": 240000, "entryFeeBps": 10,
                       "exitFeeBps": 10, "entrySlippageBps": 5, "exitSlippageBps": 5,
                       "spreadBps": 0, "fundingBpsPerCandle": 0},
            "candles": candles, "observations": [observation]}


class AlphaBaselineTest(unittest.TestCase):
    def test_sample_adequacy_and_uncertainty_are_explicit(self):
        self.assertEqual([sample_status(n) for n in (0, 29, 30, 49, 50, 99, 100)],
                         ["VERY_INSUFFICIENT", "VERY_INSUFFICIENT", "INSUFFICIENT",
                          "INSUFFICIENT", "LIMITED", "LIMITED", "USABLE_BASELINE"])
        interval = uncertainty([Decimal("-1")] * 4)
        self.assertEqual(interval["expectancyBootstrap95"], ["-1.000000", "-1.000000"])
        self.assertGreater(Decimal(interval["winRateWilson95"][1]), 0)

    def test_causal_ledger_must_reconcile_with_independent_fill(self):
        data = fixture()
        trade = run(data)["tradeLedger"][0]
        entry, exit_price = Decimal(trade["entryPrice"]), Decimal(trade["exitPrice"])
        net = (exit_price - entry - entry * Decimal("0.001") -
               exit_price * Decimal("0.001"))
        booked = {k: trade[k] for k in ("candidateId", "direction", "entryTime",
                                         "exitTime", "exitReason", "entryPrice", "exitPrice")}
        booked.update({"quantity": "1", "netPnl": str(net),
                       "accountEquityAfterExit": str(Decimal("10000") + net)})
        data["causalAccount"] = {"initialEquity": "10000", "finalEquity": booked["accountEquityAfterExit"],
                                 "closedTrades": [booked], "unresolvedPositions": []}
        self.assertEqual(run(data)["causalAccount"]["finalEquity"], booked["accountEquityAfterExit"])
        booked["netPnl"] = "0"
        with self.assertRaisesRegex(ValueError, "PnL differs"):
            run(data)

    def test_15m_path_resolves_target_before_later_stop_and_charges_actual_funding(self):
        data = fixture()
        data["metadata"]["timeframe"] = "1h"
        data["config"]["trainEnd"] *= 60
        data["config"]["validationEnd"] *= 60
        for candle in data["candles"]:
            candle["timeframe"] = "1h"
            candle["openTime"] *= 60
            candle["closeTime"] *= 60
        observation = data["observations"][0]
        for part in (observation["analysis"], observation["decision"]):
            part["analysisAsOf"] *= 60
            part["triggerCloseTime"] *= 60
        observation["analysis"]["regime"]["windowEnd"] *= 60
        observation["decision"]["setupCandidate"]["asOf"] *= 60
        observation["decision"]["setupCandidate"]["setupTimeframe"] = "1h"
        observation["decision"]["structuralRiskResult"]["asOf"] *= 60
        observation["decision"]["tradeIntentResult"]["asOf"] *= 60
        observation["analysis"]["frame"]["timeframes"][0]["timeframe"] = "1h"
        for snapshot in observation["analysis"]["frame"]["timeframes"][0]["candles"]:
            snapshot["candle"]["timeframe"] = "1h"
        quarters = []
        for candle in data["candles"]:
            for index in range(4):
                opening = candle["open"]
                close = candle["close"] if index == 3 else opening
                high = candle["high"] if index == 1 else max(opening, close, key=float)
                low = candle["low"] if index == 2 else min(opening, close, key=float)
                quarters.append({"instrumentId": "TEST", "timeframe": "15m",
                                 "openTime": candle["openTime"] + index * 900000,
                                 "closeTime": candle["openTime"] + (index + 1) * 900000,
                                 "open": opening, "high": high, "low": low, "close": close,
                                 "isClosed": True, "quality": []})
        entry_quarters = quarters[12:16]
        entry_quarters[0].update({"high": "101", "low": "99"})
        entry_quarters[1].update({"high": "131", "low": "100"})
        entry_quarters[2].update({"high": "100", "low": "89"})
        data["executionCandles"] = quarters
        data["fundingEvents"] = [{"time": entry_quarters[1]["closeTime"],
                                  "intervalHours": 8, "rate": "0.001"}]
        funded = run(data)["tradeLedger"][0]
        self.assertEqual(funded["exitReason"], "TARGET")
        self.assertEqual(funded["fundingEvents"], 1)
        self.assertEqual(funded["exitTime"], entry_quarters[1]["closeTime"])
        data["fundingEvents"][0]["rate"] = "-0.001"
        uncertain_credit = run(data)["tradeLedger"][0]
        data["fundingEvents"] = []
        unfunded = run(data)["tradeLedger"][0]
        self.assertLess(float(funded["netR"]), float(unfunded["netR"]))
        self.assertEqual(uncertain_credit["netR"], unfunded["netR"])
        data["executionCandles"][0]["high"] = "102"
        self.assertEqual(run(data)["dataQuality"]["executionPathMismatchOpenTimes"], [0])
        data["executionCandles"][13]["high"] = "130"
        with self.assertRaisesRegex(ValueError, "during an open trade"):
            run(data)

    def test_next_open_and_both_touch_stop_first_with_costs(self):
        result = run(fixture())
        trade = result["tradeLedger"][0]
        self.assertEqual(trade["entryTime"], 180000)
        self.assertEqual(trade["exitReason"], "BOTH_STOP_FIRST")
        self.assertLess(float(trade["netR"]), -1)
        self.assertEqual(result["split"]["VALIDATION"]["sampleSize"], 1)
        self.assertEqual(result["split"]["BURNED_DIAGNOSTICS"]["sampleSize"], 0)
        self.assertEqual(result["metrics"]["sampleStatus"], "VERY_INSUFFICIENT")
        self.assertEqual(result["counts"]["signalEligible"], 1)
        self.assertFalse(result["certified"])
        self.assertLess(float(trade["mfeR"]), 1)  # no post-stop target wick

    def test_target_fill_and_costs(self):
        data = fixture()
        data["candles"][3]["low"] = "99"
        result = run(data)
        self.assertEqual(result["tradeLedger"][0]["exitReason"], "TARGET")
        self.assertLess(float(result["tradeLedger"][0]["netR"]), 3)

    def test_future_regime_and_unfinished_candle_fail_closed(self):
        data = fixture()
        data["observations"][0]["analysis"]["regime"]["windowEnd"] = 240000
        with self.assertRaisesRegex(ValueError, "future"):
            run(data)
        data = fixture()
        data["candles"][2]["isClosed"] = False
        with self.assertRaisesRegex(ValueError, "open or gapped"):
            run(data)
        data = fixture()
        data["observations"][0]["analysis"]["frame"]["timeframes"][0]["candles"][2]["candle"] = copy.deepcopy(data["candles"][2])
        data["observations"][0]["analysis"]["frame"]["timeframes"][0]["candles"][2]["candle"]["closeTime"] = 240000
        with self.assertRaisesRegex(ValueError, "future, open"):
            run(data)

    def test_duplicate_and_disordered_candles_fail_closed(self):
        for open_time in (60000, 30000):
            data = fixture()
            data["candles"][2]["openTime"] = open_time
            with self.assertRaisesRegex(ValueError, "ordered"):
                run(data)

    def test_non_authoritative_or_below_floor_signal_fails_closed(self):
        data = fixture()
        data["observations"][0]["decision"]["structuralRiskResult"]["netRewardRiskBps"] = "29999"
        with self.assertRaisesRegex(ValueError, "below-minimum"):
            run(data)
        data = fixture()
        data["observations"][0]["decision"]["tradeIntentResult"]["primaryTargetPrice"] = "140"
        with self.assertRaisesRegex(ValueError, "incoherent"):
            run(data)

    def test_same_candidate_cannot_be_reentered(self):
        data = fixture()
        second = copy.deepcopy(data["observations"][0])
        second["analysis"]["analysisCycleId"] = "a2"
        second["decision"]["analysisCycleId"] = "a2"
        second["analysis"]["analysisAsOf"] = second["analysis"]["triggerCloseTime"] = 240000
        second["decision"]["analysisAsOf"] = second["decision"]["triggerCloseTime"] = 240000
        second["analysis"]["regime"]["windowEnd"] = 240000
        second["decision"]["setupCandidate"]["asOf"] = 240000
        second["analysis"]["setup"]["candidates"][0]["asOf"] = 240000
        second["decision"]["structuralRiskResult"]["asOf"] = 240000
        second["decision"]["tradeIntentResult"]["asOf"] = 240000
        data["observations"].append(second)
        result = run(data)
        self.assertEqual(result["counts"]["closedTrades"], 1)
        self.assertEqual(result["counts"]["rejected"], 1)

    def test_trade_crossing_split_is_excluded_from_split_metrics(self):
        data = fixture()
        data["config"]["validationEnd"] = 210000
        result = run(data)
        self.assertEqual(result["counts"]["closedTrades"], 1)
        self.assertEqual(result["counts"]["crossBoundaryTrades"], 1)
        self.assertEqual(result["split"]["VALIDATION"]["sampleSize"], 0)

    def test_cli_artifacts_are_reproducible(self):
        with tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parent) as directory:
            source = Path(directory) / "fixture.json"
            output = Path(directory) / "results"
            source.write_text(json.dumps(fixture()))
            args = ["alpha_baseline.py", "--input", str(source), "--output-dir", str(output)]
            with patch.object(sys, "argv", args):
                main()
            first = (output / "alpha_baseline.json").read_bytes()
            with patch.object(sys, "argv", args):
                main()
            self.assertEqual(first, (output / "alpha_baseline.json").read_bytes())
            self.assertIn("inputSha256", json.loads(first))
            self.assertIn("Certified: False", (output / "alpha_baseline.txt").read_text())


if __name__ == "__main__":
    unittest.main()
