"""Fill documented monthly-source holes from checksum-verified official daily ZIPs."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
import json

from download_core_universe import DATA, POLICY, acquire
from prepare_core_universe import archive_rows, monthly_items

receipt_path = DATA / "download_receipt.json"
receipt = json.loads(receipt_path.read_text(encoding="utf-8"))
if receipt["failures"]:
    raise ValueError("Monthly archive acquisition must be complete")

items = []
for symbol in POLICY["coreUniverse"]:
    if symbol == "BTCUSDT":
        continue
    previous = None
    for item in monthly_items(receipt, symbol, "15m"):
        for row in archive_rows(item):
            opened = int(row[0])
            if previous is not None and opened != previous:
                if opened < previous or previous % 86400000 or opened % 86400000:
                    raise ValueError(f"Non-day-aligned or reversed gap: {symbol} {previous} {opened}")
                day = datetime.fromtimestamp(previous / 1000, timezone.utc)
                end = datetime.fromtimestamp(opened / 1000, timezone.utc)
                while day < end:
                    date = day.strftime("%Y-%m-%d")
                    name = f"{symbol}-15m-{date}.zip"
                    items.append({"symbol": symbol, "kind": "15m", "date": date,
                                  "file": f"archives/{name}",
                                  "sourceUrl": f"https://data.binance.vision/data/futures/um/daily/klines/{symbol}/15m/{name}"})
                    day += timedelta(days=1)
            previous = opened + 900000

records = [acquire(item) for item in items]
receipt["gapFillFiles"] = records
receipt_path.write_text(json.dumps(receipt, indent=2) + "\n", encoding="utf-8")
print(f"Verified {len(records)} official daily gap-fill archives", flush=True)
