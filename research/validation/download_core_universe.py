"""Fetch the fixed Binance USD-M universe from official monthly S3 archives.

Every ZIP is verified against its adjacent Binance-published SHA-256 file.
The archive listing establishes availability; no pre-listing month is invented.
"""

from __future__ import annotations

import concurrent.futures
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import re
import time
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET

HERE = Path(__file__).resolve().parent
DATA = HERE.parent / "data" / "core_universe_v1"
POLICY = json.loads((HERE / "ALPHA_RESEARCH_POLICY_V1.json").read_text(encoding="utf-8"))
ROOT = "https://data.binance.vision/data/futures/um/monthly"
BUCKET = "https://s3-ap-northeast-1.amazonaws.com/data.binance.vision"
KINDS = ("15m", "1h", "4h", "1d", "fundingRate")
LAST_MONTH = "2026-09"


def get(url: str) -> bytes:
    for attempt in range(4):
        try:
            with urllib.request.urlopen(url, timeout=90) as response:
                return response.read()
        except Exception:
            if attempt == 3:
                raise
            time.sleep(1 + attempt * 2)
    raise AssertionError("unreachable")


def listing(symbol: str, kind: str) -> list[dict]:
    section = f"klines/{symbol}/{kind}" if kind != "fundingRate" else f"fundingRate/{symbol}"
    prefix = f"data/futures/um/monthly/{section}/{symbol}-{kind}-"
    token = None
    keys = []
    ns = {"s": "http://s3.amazonaws.com/doc/2006-03-01/"}
    while True:
        params = {"list-type": "2", "prefix": prefix, "max-keys": "1000"}
        if token:
            params["continuation-token"] = token
        root = ET.fromstring(get(BUCKET + "?" + urllib.parse.urlencode(params)))
        keys.extend(node.text for node in root.findall("s:Contents/s:Key", ns))
        if root.findtext("s:IsTruncated", namespaces=ns) != "true":
            break
        token = root.findtext("s:NextContinuationToken", namespaces=ns)
        if not token:
            raise ValueError("Truncated official archive listing without continuation")
    pattern = re.compile(rf"{re.escape(prefix)}(\d{{4}}-\d{{2}})\.zip$")
    months = sorted(match.group(1) for key in keys if (match := pattern.fullmatch(key)) and match.group(1) <= LAST_MONTH)
    if not months:
        raise ValueError(f"No official monthly {kind} archive for {symbol}")
    if months != [f"{year:04d}-{month:02d}" for year in range(int(months[0][:4]), 2027)
                  for month in range(1, 13) if months[0] <= f"{year:04d}-{month:02d}" <= LAST_MONTH]:
        raise ValueError(f"Missing official monthly {kind} archive for {symbol}")
    return [{"symbol": symbol, "kind": kind, "month": month,
             "file": f"archives/{symbol}-{kind}-{month}.zip",
             "sourceUrl": f"{ROOT}/{section}/{symbol}-{kind}-{month}.zip"}
            for month in months]


def acquire(item: dict) -> dict:
    target = DATA / item["file"]
    name = target.name
    checksum_url = item["sourceUrl"] + ".CHECKSUM"
    checksum = get(checksum_url).decode("ascii").strip()
    match = re.fullmatch(r"([0-9a-f]{64})  (.+\.zip)", checksum)
    if match is None or match.group(2) != name:
        raise ValueError(f"Invalid official checksum: {checksum_url}")
    payload = target.read_bytes() if target.exists() else get(item["sourceUrl"])
    actual = hashlib.sha256(payload).hexdigest()
    if actual != match.group(1):
        raise ValueError(f"Official checksum mismatch: {item['sourceUrl']}")
    if not target.exists():
        target.write_bytes(payload)
    return {**item, "checksumUrl": checksum_url, "sha256": actual, "bytes": len(payload)}


def main() -> None:
    (DATA / "archives").mkdir(parents=True, exist_ok=True)
    items = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=10) as pool:
        futures = {pool.submit(listing, symbol, kind): (symbol, kind)
                   for symbol in POLICY["coreUniverse"] if symbol != "BTCUSDT" for kind in KINDS}
        for future in concurrent.futures.as_completed(futures):
            items.extend(future.result())
    print(f"Official index lists {len(items)} archives", flush=True)
    records = []
    failures = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=20) as pool:
        futures = {pool.submit(acquire, item): item for item in items}
        for future in concurrent.futures.as_completed(futures):
            try:
                records.append(future.result())
            except Exception as exc:
                failures.append({"item": futures[future], "error": str(exc)})
            if (len(records) + len(failures)) % 100 == 0:
                print(f"Verified {len(records)}/{len(items)}; failures {len(failures)}", flush=True)
    receipt = {"source": "Official Binance Public Data USD-M monthly S3 archives",
               "rootUrl": ROOT, "listingUrl": BUCKET,
               "retrievedAtUtc": datetime.now(timezone.utc).isoformat(),
               "policyId": POLICY["id"],
               "files": sorted(records, key=lambda x: (x["symbol"], x["kind"], x["month"])),
               "failures": failures}
    (DATA / "download_receipt.json").write_text(json.dumps(receipt, indent=2) + "\n", encoding="utf-8")
    if failures:
        raise RuntimeError(f"Archive acquisition incomplete: {failures[:5]}")
    print(f"Verified all {len(records)} official archives", flush=True)


if __name__ == "__main__":
    main()
