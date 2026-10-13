"""Mechanical importer checks; fixture prices are not alpha evidence."""

import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from import_ohlcv import import_csv, instrument_venue, main, parse_time


INSTRUMENT = "ulte:v1:Example:SPOT:TEST"
HEADER = "open_time,open,high,low,close,volume\n"


def rows(times=range(0, 300000, 60000)):
    return (HEADER + "".join(f"{time},100,101,99,100,10\n" for time in times)).encode()


class ImportOhlcvTest(unittest.TestCase):
    def test_contiguous_candles_and_utc_availability(self):
        candles, report = import_csv(rows(), instrument_id=INSTRUMENT, timeframe="1m")
        self.assertEqual(len(candles), 5)
        self.assertEqual(candles[0]["openTime"], 0)
        self.assertEqual(candles[0]["closeTime"], candles[0]["availableAt"])
        self.assertEqual(report["splitBoundaries"], {"trainEnd": 180000, "validationEnd": 240000})
        self.assertEqual(parse_time("1970-01-01T00:01:00Z"), 60000)

    def test_rejects_gaps_duplicates_disorder_future_and_alignment(self):
        for times, message in [
            ([0, 60000, 180000, 240000, 300000], "missing interval"),
            ([0, 60000, 60000, 180000, 240000], "duplicate"),
            ([0, 120000, 60000, 180000, 240000], "missing interval"),
            ([0, 60000, 120001, 180000, 240000], "misaligned"),
        ]:
            with self.subTest(times=times), self.assertRaisesRegex(ValueError, message):
                import_csv(rows(times), instrument_id=INSTRUMENT, timeframe="1m")
        with self.assertRaisesRegex(ValueError, "after retrieval"):
            import_csv(rows(), instrument_id=INSTRUMENT, timeframe="1m", latest_close_ms=240000)

    def test_rejects_bad_ohlcv_and_non_utc_time(self):
        for text, message in [
            ("100,98,99,100,10", "invalid OHLC"),
            ("100,101,99,100,-1", "volume"),
            ("100,101,99,100,NaN", "volume"),
        ]:
            with self.subTest(text=text), self.assertRaisesRegex(ValueError, message):
                import_csv(rows().replace(b"100,101,99,100,10", text.encode(), 1),
                           instrument_id=INSTRUMENT, timeframe="1m")
        with self.assertRaisesRegex(ValueError, "UTC"):
            parse_time("1970-01-01T00:00:00+02:00")
        with self.assertRaisesRegex(ValueError, "millisecond precision"):
            parse_time("1970-01-01T00:00:00.000001Z")
        with self.assertRaisesRegex(ValueError, "canonical"):
            instrument_venue("ulte:v1:Example:SPOT:bad%2fsymbol")

    def test_cli_hashes_source_and_normalized_data(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)
            source, output = path / "official.csv", path / "output"
            source.write_bytes(rows())
            args = ["import_ohlcv.py", "--input", str(source), "--output-dir", str(output),
                    "--source-url", "https://example.org/official.csv",
                    "--retrieved-at-utc", "2026-10-14T12:00:00Z",
                    "--venue", "Example", "--market-type", "SPOT", "--instrument-id", INSTRUMENT,
                    "--timeframe", "1m", "--anchor-ms", "0"]
            with patch.object(sys, "argv", args):
                main()
            first = (output / "candles.json").read_bytes()
            manifest = json.loads((output / "manifest.json").read_text())
            self.assertEqual(manifest["rowCount"], 5)
            self.assertFalse(manifest["sourceVerified"])
            with patch.object(sys, "argv", args):
                main()
            self.assertEqual(first, (output / "candles.json").read_bytes())


if __name__ == "__main__":
    unittest.main()
