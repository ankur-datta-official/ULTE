"""Focused alignment, aggregation, and source-discrepancy regressions."""

import unittest
from derive_canonical_timeframes import BASE_MS, canonical_bars, compare


class CanonicalTimeframeTests(unittest.TestCase):
    def setUp(self):
        self.children = []
        for i, (opened, high, low, closed, volume) in enumerate([
            ("10", "12", "9", "11", "1.1"),
            ("11", "14", "10", "13", "2.2"),
            ("13", "15", "12", "14", "0"),
            ("14", "16", "13", "15", "3.3"),
        ]):
            self.children.append({
                "instrumentId": "x", "timeframe": "15m", "openTime": i * BASE_MS,
                "closeTime": (i + 1) * BASE_MS, "availableAt": (i + 1) * BASE_MS,
                "open": opened, "high": high, "low": low, "close": closed,
                "volume": volume, "isClosed": True, "quality": [],
            })

    def test_utc_closed_bar_and_decimal_volume(self):
        bars = canonical_bars(self.children, "1h", 4, start=0, end=4 * BASE_MS)
        self.assertEqual(len(bars), 1)
        self.assertEqual((bars[0]["open"], bars[0]["high"], bars[0]["low"],
                          bars[0]["close"], bars[0]["volume"]),
                         ("10", "16", "9", "15", "6.6"))
        self.assertEqual(bars[0]["availableAt"], 4 * BASE_MS)

    def test_gap_and_partial_bar_fail_closed(self):
        self.children[1]["openTime"] += BASE_MS
        with self.assertRaisesRegex(ValueError, "Invalid, missing"):
            canonical_bars(self.children, "1h", 4, start=0, end=4 * BASE_MS)
        with self.assertRaises(ValueError):
            canonical_bars(self.children[:3], "1h", 4, start=0, end=4 * BASE_MS)

    def test_official_conflict_is_recorded(self):
        bars = canonical_bars(self.children, "1h", 4, start=0, end=4 * BASE_MS)
        official = [{**bars[0], "high": "17"}]
        self.assertEqual(compare(bars, official)[0]["differences"]["high"],
                         {"canonical15m": "16", "official": "17"})


if __name__ == "__main__":
    unittest.main()
