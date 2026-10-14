"""Inspect the verified official monthly 15m source before canonicalization."""
import json
from prepare_core_universe import DATA, POLICY, archive_rows, monthly_items

receipt = json.loads((DATA / "download_receipt.json").read_text(encoding="utf-8"))
for symbol in POLICY["coreUniverse"]:
    if symbol == "BTCUSDT":
        continue
    previous = None
    gaps = []
    for item in monthly_items(receipt, symbol, "15m"):
        for row in archive_rows(item):
            opened = int(row[0])
            if previous is not None and opened != previous:
                gaps.append({"from": previous, "to": opened,
                             "missing15m": (opened - previous) // 900000})
            previous = opened + 900000
    print(symbol, json.dumps(gaps), flush=True)
