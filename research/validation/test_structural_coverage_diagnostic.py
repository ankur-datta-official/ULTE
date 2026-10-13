"""Focused checks for research-only path timing and conservative ordering."""

import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))
from structural_coverage_diagnostic import QUARTER, START, path_diagnostic


def candle(open_time, opened, high, low):
    return {"openTime": open_time, "closeTime": open_time + QUARTER,
            "open": opened, "high": high, "low": low}


class PathDiagnosticTest(unittest.TestCase):
    def test_long_same_bar_stop_uses_open_as_certain_favorable_price(self):
        row = {"asOf": START, "direction": "UP", "entryReferencePrice": "100",
               "invalidationPrice": "90"}
        path = path_diagnostic(row, [candle(START, "101", "150", "89")])
        self.assertEqual(path["mfeLowerR"], "0.1")
        self.assertEqual(path["mfeUpperR"], "5")
        self.assertEqual(path["maeLowerR"], "1")
        self.assertFalse(path["censoredAtDatasetEnd"])

    def test_short_scans_only_until_first_stop(self):
        row = {"asOf": START, "direction": "DOWN", "entryReferencePrice": "100",
               "invalidationPrice": "110"}
        path = path_diagnostic(row, [candle(START, "100", "105", "70"),
                                     candle(START + QUARTER, "99", "111", "50"),
                                     candle(START + 2 * QUARTER, "100", "101", "10")])
        self.assertEqual(path["mfeLowerR"], "3")
        self.assertEqual(path["mfeUpperR"], "5")
        self.assertEqual(path["observedBars"], 2)

    def test_unstopped_path_is_right_censored(self):
        row = {"asOf": START, "direction": "UP", "entryReferencePrice": "100",
               "invalidationPrice": "90"}
        path = path_diagnostic(row, [candle(START, "100", "105", "95")])
        self.assertTrue(path["censoredAtDatasetEnd"])
        self.assertIsNone(path["stopObservationTime"])
        self.assertEqual(path["mfeLowerR"], "0.5")

    def test_refuses_reserved_future_bar(self):
        row = {"asOf": START, "direction": "UP", "entryReferencePrice": "100",
               "invalidationPrice": "90"}
        with patch("structural_coverage_diagnostic.CUTOFF", START + QUARTER):
            with self.assertRaisesRegex(ValueError, "Future holdout"):
                path_diagnostic(row, [candle(START, "100", "105", "95"),
                                      candle(START + QUARTER, "100", "105", "95")])


if __name__ == "__main__":
    unittest.main()
