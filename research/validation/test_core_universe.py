"""Regression checks for the frozen policy and signal-level path model."""
import json
from pathlib import Path
import unittest

from summarize_core_universe import POLICY, sample_label, simulate

HERE = Path(__file__).resolve().parent


class CoreUniversePolicyTests(unittest.TestCase):
    def test_untuned_alpha_fields_are_copied_exactly(self):
        old = json.loads((HERE / "REPLAY_CONFIG_EXPLORATORY_V1.json").read_text(encoding="utf-8"))
        self.assertEqual({**POLICY["analysis"], "profileVersion": old["analysis"]["profileVersion"]},
                         old["analysis"])
        self.assertEqual(POLICY["decision"], old["decision"])
        self.assertEqual(POLICY["costs"], old["costs"])
        self.assertEqual(POLICY["risk"]["minimumNetRewardRiskBps"], 30000)
        self.assertEqual(POLICY["historicalEndExclusive"], "2026-10-01T00:00:00Z")
        self.assertEqual(POLICY["signalExecution"]["sameBarStopAndTarget"], "STOP_FIRST")
        self.assertIn("independent signal-level", POLICY["signalExecution"]["overlap"])
        self.assertEqual(POLICY["coreUniverse"], ["BTCUSDT", "ETHUSDT", "BNBUSDT", "SOLUSDT",
                                                  "XRPUSDT", "ADAUSDT", "DOGEUSDT", "LINKUSDT"])

    def test_sufficiency_labels_at_boundaries(self):
        self.assertEqual([sample_label(n) for n in (29, 30, 49, 50, 99, 100, 199, 200)],
                         ["VERY_INSUFFICIENT", "INSUFFICIENT", "INSUFFICIENT", "LIMITED",
                          "LIMITED", "USABLE_BASELINE", "USABLE_BASELINE",
                          "STRONGER_RESEARCH_BASELINE"])

    def test_stop_first_and_independent_signal_outcomes(self):
        bars = [
            {"openTime": 0, "closeTime": 900000, "open": "100", "high": "103", "low": "99", "close": "100"},
            {"openTime": 900000, "closeTime": 1800000, "open": "100", "high": "106", "low": "94", "close": "100"},
        ]
        signal = {"symbol": "TESTUSDT", "candidateId": "a", "direction": "UP",
                  "family": "BREAKOUT_RETEST", "regime": "TREND_UP", "asOf": 0,
                  "entryReferencePrice": "100", "invalidationPrice": "95",
                  "primaryTargetPrice": "105", "netRewardRiskBps": "30000"}
        trade, skip = simulate(signal, bars, {0: 0, 900000: 1}, [])
        self.assertIsNone(skip)
        self.assertEqual(trade["exitReason"], "BOTH_STOP_FIRST")
        self.assertLess(float(trade["netR"]), -1)
        second, skip = simulate({**signal, "candidateId": "b"}, bars, {0: 0, 900000: 1}, [])
        self.assertIsNone(skip)
        self.assertEqual(second["exitTime"], trade["exitTime"])


if __name__ == "__main__":
    unittest.main()
