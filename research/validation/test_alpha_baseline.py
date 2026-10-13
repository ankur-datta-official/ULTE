"""Mechanical fixtures only; these are not historical alpha evidence."""

import copy
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from alpha_baseline import main, run


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
    def test_next_open_and_both_touch_stop_first_with_costs(self):
        result = run(fixture())
        trade = result["tradeLedger"][0]
        self.assertEqual(trade["entryTime"], 180000)
        self.assertEqual(trade["exitReason"], "BOTH_STOP_FIRST")
        self.assertLess(float(trade["netR"]), -1)
        self.assertEqual(result["split"]["VALIDATION"]["sampleSize"], 1)
        self.assertEqual(result["split"]["TEST"]["sampleSize"], 0)
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
