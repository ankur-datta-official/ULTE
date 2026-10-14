"""Reconcile the fixed-universe artifact with source manifests and BTC baseline."""

import hashlib
import json
from pathlib import Path

HERE = Path(__file__).resolve().parent
DATA = HERE.parent / "data" / "core_universe_v1"
BTC = HERE.parent / "data" / "binance_btcusdt_v1"
policy = json.loads((HERE / "ALPHA_RESEARCH_POLICY_V1.json").read_text(encoding="utf-8"))
manifest = json.loads((HERE / "CORE_UNIVERSE_DATA_MANIFEST_V1.json").read_text(encoding="utf-8"))
baseline = json.loads((DATA / "core_universe_baseline.json").read_text(encoding="utf-8"))
old_btc = json.loads((BTC / "baseline" / "alpha_baseline.json").read_text(encoding="utf-8"))

assert baseline["universe"] == policy["coreUniverse"] == list(manifest["symbols"])
assert baseline["historicalEndExclusive"] == policy["historicalEndExclusive"]
assert baseline["aggregate"]["funnel"]["EXECUTED_RESEARCH_TRADES"] == len(baseline["aggregate"]["tradeLedger"])
for symbol in policy["coreUniverse"]:
    result = baseline["bySymbol"][symbol]
    source = manifest["symbols"][symbol]
    path = (BTC / "normalized" / "15m" / "candles.json") if symbol == "BTCUSDT" else \
           (DATA / symbol / "canonical" / "15m" / "candles.json")
    assert hashlib.sha256(path.read_bytes()).hexdigest() == source["canonical"]["15m"]["sha256"]
    assert result["funnel"]["TOTAL_CYCLES"] == source["canonical"]["1h"]["rows"]
    assert result["funnel"]["EXECUTED_RESEARCH_TRADES"] == len(result["tradeLedger"])
    assert all(trade["entryTime"] < 1790812800000 and trade["exitTime"] <= 1790812800000
               for trade in result["tradeLedger"])
    diagnostics = json.loads((DATA / symbol / "candidate_diagnostics.json").read_text(encoding="utf-8"))
    assert len(diagnostics) == result["funnel"]["NO_STRUCTURAL_TARGET"] + result["funnel"]["BELOW_RR"]
    assert all(row["asOf"] < 1790812800000 for row in diagnostics)

fresh = baseline["bySymbol"]["BTCUSDT"]["tradeLedger"]
earlier = old_btc["tradeLedger"]
assert len(fresh) == len(earlier) == 4
for a, b in zip(fresh, earlier, strict=True):
    assert all(a[field] == b[field] for field in
               ("candidateId", "entryTime", "exitTime", "entryPrice", "exitPrice",
                "exitReason", "netR", "mfeR", "maeR"))
print("PASS: eight source-backed symbols, candidate diagnostics, cutoff, and exact BTC baseline parity")
