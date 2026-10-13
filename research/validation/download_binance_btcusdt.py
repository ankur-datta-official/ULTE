"""Acquire the frozen BTCUSDT USD-M monthly archives from Binance Public Data.

Archives and the receipt are local research inputs under the ignored data tree.
Every archive is checked against its adjacent official CHECKSUM file.
"""

from __future__ import annotations

import concurrent.futures
import hashlib
import json
import re
import urllib.request
from datetime import datetime, timezone
from pathlib import Path


ROOT = "https://data.binance.vision/data/futures/um/monthly"
MONTHS = [(year, month) for year in range(2020, 2027)
          for month in range(1, 13) if (year, month) <= (2026, 9)]
KINDS = ("15m", "1h", "4h", "1d", "fundingRate")
DEST = Path(__file__).resolve().parents[1] / "data" / "binance_btcusdt_v1" / "archives"
CHECKSUM = re.compile(r"^([0-9a-f]{64})  (BTCUSDT-(?:15m|1h|4h|1d|fundingRate)-\d{4}-\d{2}\.zip)\s*$")


def source(kind: str, year: int, month: int) -> tuple[str, str]:
    name = f"BTCUSDT-{kind}-{year:04d}-{month:02d}.zip"
    section = f"klines/BTCUSDT/{kind}" if kind != "fundingRate" else "fundingRate/BTCUSDT"
    return name, f"{ROOT}/{section}/{name}"


def get(url: str) -> bytes:
    with urllib.request.urlopen(url, timeout=60) as response:
        return response.read()


def acquire(item: tuple[str, int, int]) -> dict:
    kind, year, month = item
    name, url = source(kind, year, month)
    checksum_text = get(url + ".CHECKSUM").decode("ascii")
    match = CHECKSUM.fullmatch(checksum_text)
    if match is None or match.group(2) != name:
        raise ValueError(f"Invalid official checksum: {url}.CHECKSUM")
    path = DEST / name
    if path.exists():
        payload = path.read_bytes()
    else:
        payload = get(url)
    actual = hashlib.sha256(payload).hexdigest()
    if actual != match.group(1):
        raise ValueError(f"Checksum mismatch: {url}: {actual} != {match.group(1)}")
    if not path.exists():
        path.write_bytes(payload)
    return {"kind": kind, "month": f"{year:04d}-{month:02d}", "file": str(path.relative_to(DEST.parent)),
            "sourceUrl": url, "checksumUrl": url + ".CHECKSUM", "sha256": actual, "bytes": len(payload)}


def main() -> None:
    DEST.mkdir(parents=True, exist_ok=True)
    items = [(kind, year, month) for kind in KINDS for year, month in MONTHS]
    records = []
    failures = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
        future_items = {pool.submit(acquire, item): item for item in items}
        for future in concurrent.futures.as_completed(future_items):
            try:
                records.append(future.result())
            except Exception as exc:
                failures.append({"item": future_items[future], "error": str(exc)})
            if (len(records) + len(failures)) % 25 == 0:
                print(f"Archives checked: {len(records) + len(failures)}/{len(items)}; failures: {len(failures)}", flush=True)
    receipt = {"source": "Binance Public Data USD-M monthly archive", "rootUrl": ROOT,
               "retrievedAtUtc": datetime.now(timezone.utc).isoformat(),
               "target": "BTCUSDT USD-M perpetual 2020-01 through 2026-09",
               "files": sorted(records, key=lambda item: (item["kind"], item["month"])),
               "failures": sorted(failures, key=lambda item: str(item["item"]))}
    (DEST.parent / "download_receipt.json").write_text(json.dumps(receipt, indent=2) + "\n", encoding="utf-8")
    print(f"Verified {len(records)}/{len(items)} archives; failures: {len(failures)}", flush=True)
    if failures:
        raise RuntimeError(f"Official archive acquisition failed: {failures[:5]}")


if __name__ == "__main__":
    main()
