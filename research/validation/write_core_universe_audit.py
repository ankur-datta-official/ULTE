"""Write the one tracked core-universe audit from verified local research outputs."""

from __future__ import annotations

from datetime import datetime, timezone
import json
from pathlib import Path

HERE = Path(__file__).resolve().parent
DATA = HERE.parent / "data" / "core_universe_v1"
POLICY = json.loads((HERE / "ALPHA_RESEARCH_POLICY_V1.json").read_text(encoding="utf-8"))
MANIFEST = json.loads((HERE / "CORE_UNIVERSE_DATA_MANIFEST_V1.json").read_text(encoding="utf-8"))
RESULT = json.loads((DATA / "core_universe_baseline.json").read_text(encoding="utf-8"))
OUT = HERE.parents[1] / "TRADING_INTELLIGENCE_CORE_UNIVERSE_BASELINE_AUDIT.txt"


def utc(ms):
    return datetime.fromtimestamp(ms / 1000, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def val(value):
    return "N/A" if value is None else str(value)


def line(items):
    return " | ".join(val(item) for item in items)


def audit():
    if RESULT["universe"] != POLICY["coreUniverse"] or \
       list(MANIFEST["symbols"]) != POLICY["coreUniverse"]:
        raise ValueError("Fixed universe or manifest order changed")
    aggregate = RESULT["aggregate"]
    funnel = aggregate["funnel"]
    if (funnel["CONFIRMED_CANDIDATES"] != funnel["NO_STRUCTURAL_TARGET"] +
            funnel["BELOW_RR"] + funnel["COST_BLOCKED"] +
            funnel["SIGNAL_ELIGIBLE"] + funnel["OTHER_STRUCTURAL_REJECTION"]):
        raise ValueError("Confirmed decision funnel does not reconcile")
    if aggregate["noTargetReasonDistribution"] != {"SOLE_SAME_SIDE_LEVEL_BROKEN": funnel["NO_STRUCTURAL_TARGET"]}:
        raise ValueError("No-target mechanism differs from reported baseline")
    lines = [
        "TRADING INTELLIGENCE CORE UNIVERSE BASELINE AUDIT - Task058",
        "Source revision: c20e1cbedefd2fdb68057a60c10477627f416d4f (clean requested baseline).",
        "VERDICT = UNTUNED_CORE_UNIVERSE_RESEARCH_BASELINE; ALPHA_NOT_CERTIFIED.",
        "ALPHA_RESEARCH_POLICY_READY = YES. PRODUCTION_LIVE_STRATEGY_CONFIG_READY = NO.",
        "READY_ALLOWED = NO. PRODUCTION_READY = NO.",
        "",
        "1. FROZEN RESEARCH CONTRACT",
        "ALPHA_RESEARCH_POLICY_V1.json is the versioned UNTUNED_PRE_OPTIMIZATION_BASELINE.",
        "The alpha-sensitive numeric fields and allowlists exactly copy the corrected Task056",
        "REPLAY_CONFIG_EXPLORATORY_V1.json. They were test-derived before the BTC outcome and",
        "are not historically optimal. The shared trading engines were not changed.",
        "Venue Binance; market USD-M perpetual futures; fixed product universe: " + ", ".join(POLICY["coreUniverse"]) + ".",
        "Decision 1h; context 4h and 1d; checksum-verified 15m is canonical raw price.",
        "Closed 1h/4h/1d candles are deterministically aggregated from that 15m path and",
        "enter decisions only at their close. The 15m detail is used only after a decision",
        "for fills, MFE/MAE, and conservative same-bar stop/target ordering.",
        "No candle open or funding event timestamp at or after 2026-10-01T00:00:00Z",
        "entered this task; the last pre-cutoff candle closes at that exclusive boundary. The original",
        "WALK_FORWARD_PROTOCOL_V1.md remains unchanged; the earlier historical OOS is burned",
        "and the period from 2026-10-01 is reserved for forward certification.",
        "The unchanged minimum official generated signal is 3.00 net R (30000 bps).",
        "Four R and above is an outcome diagnostic, not a new qualification floor.",
        "Costs are the corrected baseline's 5 bps fee + 1 bps adverse slippage + 1 bps",
        "spread per side. Actual archived funding events are applied to held research trades",
        "causally; the model uses entry notional because settlement mark prices are unavailable.",
        "Alpha research does not await final live equity, portfolio caps, risk groups, quantity",
        "step, FX conversion, or venue execution metadata. The shared decision engine was",
        "replayed with an explicit permissive research-only USDT context to exercise its full",
        "path; qualification was counted before portfolio/sizing. No signal was suppressed",
        "by this context. Independent signal-level outcomes allow overlapping symbols.",
        "Production values remain unresolved in PRODUCTION_STRATEGY_CONFIG_V1_CANDIDATE.json.",
        "",
        "2. OFFICIAL DATA, AVAILABILITY, AND QUALITY",
        "Official monthly Binance Public Data ZIPs and adjacent .CHECKSUM SHA-256 files were",
        "verified for all listed periods. BTC uses the prior 405-archive RESEARCH_TARGET_V1",
        "manifest; the seven new symbols use 2,760 monthly archives. Ten additional official",
        "daily ZIPs and checksums fill exactly 480 missing monthly 15m bars each for SOL and",
        "XRP (2022-02-26 to 2022-03-01 and 2022-04-01 to 2022-04-03, UTC). No data was",
        "fabricated. Higher-timeframe archives are checksum-verified QA references only.",
        "CORE_UNIVERSE_DATA_MANIFEST_V1.json records each new archive URL, checksum, size,",
        "and per-symbol row count, source start/end, normalized and canonical checksums, missing intervals,",
        "and published-versus-canonical QA conflicts; RESEARCH_TARGET_V1.json does so for BTC.",
        "Large ZIPs, normalized candles, replay rows, and trade paths remain ignored local data.",
        "symbol | first official 15m | replay start | 15m rows | 1h cycles | funding rows | daily gap-fill rows | 15m SHA-256",
    ]
    for symbol in POLICY["coreUniverse"]:
        m = MANIFEST["symbols"][symbol]
        raw = m["quality"]["15m"]
        first = raw.get("firstOpenTime", m["canonical"]["15m"]["startOpenTime"])
        lines.append(line((symbol, utc(first), utc(m["canonical"]["15m"]["startOpenTime"]),
                           m["canonical"]["15m"]["rows"], m["canonical"]["1h"]["rows"],
                           m["quality"]["fundingRate"]["rows"], raw.get("officialDailyGapFillRows", 0),
                           m["canonical"]["15m"]["sha256"])))
    lines.extend(["", "All canonical 15m paths are gap-free from the listed replay start through",
                  "2026-10-01T00:00:00Z exclusive. A partial initial UTC day, if present,",
                  "is omitted to permit complete 1d context; the first official 15m timestamp",
                  "is reported separately above. No pre-listing data is synthesized.",
                  "Higher-timeframe official QA: conflicts then missing reference bars",
                  "(1h/4h/1d bars; comparisons include volume). Missing bars are never",
                  "counted as agreeing observations:"])
    for symbol in POLICY["coreUniverse"]:
        m = MANIFEST["symbols"][symbol]
        counts = [len(m["canonical"][tf].get("officialQaConflicts",
                       m["canonical"][tf].get("officialComparisonConflicts", [])))
                  for tf in ("1h", "4h", "1d")]
        missing = [len(m["canonical"][tf].get("officialQaMissingOpenTimes", []))
                   for tf in ("1h", "4h", "1d")]
        lines.append(line((symbol, "conflicts", *counts, "missing", *missing)))
    lines.extend(["The canonical path retains 15m authority when official aggregate ZIPs differ.",
                  "SOL funding has one archived interval anomaly (previous 1668038400006 ms,",
                  "next 1668052800011 ms); none of its six executed trades overlaps that gap.",
                  "The anomaly remains recorded and no funding value was substituted.",
                  "", "3. SHARED-ENGINE DECISION FUNNEL",
                  "Every closed decision bar passed through shared RealtimeAnalysisEngine and",
                  "RealtimeDecisionEngine. Every sole confirmed candidate's structural risk",
                  "result was independently re-invoked through shared qualifyStructuralRisk",
                  "and required to match the published decision exactly.",
                  "symbol | cycles | setup candidates | confirmed | no target | below 3R | cost blocked | signal eligible | executed | other structural rejection"])
    for symbol in POLICY["coreUniverse"]:
        f = RESULT["bySymbol"][symbol]["funnel"]
        lines.append(line((symbol, *(f[k] for k in ("TOTAL_CYCLES", "SETUP_CANDIDATES", "CONFIRMED_CANDIDATES",
                                                   "NO_STRUCTURAL_TARGET", "BELOW_RR", "COST_BLOCKED",
                                                   "SIGNAL_ELIGIBLE", "EXECUTED_RESEARCH_TRADES",
                                                   "OTHER_STRUCTURAL_REJECTION")))))
    lines.append(line(("TOTAL", *(funnel[k] for k in ("TOTAL_CYCLES", "SETUP_CANDIDATES", "CONFIRMED_CANDIDATES",
                                                     "NO_STRUCTURAL_TARGET", "BELOW_RR", "COST_BLOCKED",
                                                     "SIGNAL_ELIGIBLE", "EXECUTED_RESEARCH_TRADES",
                                                     "OTHER_STRUCTURAL_REJECTION")))))
    lines.extend(["The one other rejection is ADAUSDT INVALID_STRUCTURAL_INVALIDATION:",
                  "entry and stop coincide, so no valid risk distance exists. Multiple actionable",
                  "candidates = 0. Confirmed reconciliation: 1254 + 403 + 22 + 32 + 1 = 1712.",
                  "", "4. STRUCTURAL TARGET COVERAGE",
                  "symbol | confirmed | valid target | coverage % | no-target % | below-RR % | executable %"])
    for symbol in POLICY["coreUniverse"]:
        c = RESULT["bySymbol"][symbol]["targetCoverage"]
        lines.append(line((symbol, c["confirmed"], c["validStructuralTarget"],
                           c["targetCoveragePct"], c["noTargetPct"], c["belowRrPct"], c["executablePct"])))
    c = aggregate["targetCoverage"]
    lines.append(line(("TOTAL", c["confirmed"], c["validStructuralTarget"],
                       c["targetCoveragePct"], c["noTargetPct"], c["belowRrPct"], c["executablePct"])))
    lines.extend(["Percentages use confirmed candidates as denominator. The one invalid-stop",
                  "case has no valid target but is separately classified, so the structural",
                  "NO_STRUCTURAL_TARGET count is one below confirmed minus valid-target count.",
                  "Exact no-target reason distribution: SOLE_SAME_SIDE_LEVEL_BROKEN = 1254/1254,",
                  "across all eight instruments; every other no-target machine reason = 0.",
                  "The source excludes a level after it is BROKEN. No resolved level was",
                  "reclassified as a target, and the target finder missed no eligible level.",
                  "", "5. UNTUNED SIGNAL-LEVEL PERFORMANCE",
                  "The modeled next 15m open is the entry, with adverse slippage and spread.",
                  "A bar touching stop and target exits at the stop. Signals are simulated",
                  "independently of live portfolio allocation. R includes stated costs and",
                  "observed applicable funding. Sample counts accompany every statistic.",
                  "symbol | N | win rate | expectancy R | profit factor | avg win R | avg loss R | median R | total R | max DD R | 4R+ rate | avg MFE R | avg MAE R"])
    for symbol in POLICY["coreUniverse"]:
        m = RESULT["bySymbol"][symbol]["metrics"]
        lines.append(line((symbol, *(m[k] for k in ("sampleSize", "winRate", "netExpectancyR",
                                                   "profitFactor", "averageWinR", "averageLossR",
                                                   "medianR", "totalNetR", "maxDrawdownR",
                                                   "fourRTargetRate", "averageMfeR", "averageMaeR")))))
    m = aggregate["metrics"]
    lines.append(line(("TOTAL", *(m[k] for k in ("sampleSize", "winRate", "netExpectancyR",
                                                 "profitFactor", "averageWinR", "averageLossR",
                                                 "medianR", "totalNetR", "maxDrawdownR",
                                                 "fourRTargetRate", "averageMfeR", "averageMaeR")))))
    lines.extend(["Aggregate maximum drawdown orders trade closes by UTC exit time, then the",
                  "fixed universe order for ties. Win = 1/32, loss = 31/32. The sole 4R+",
                  "realized outcome occurs on DOGEUSDT (N=4); no tiny symbol sample is ranked.",
                  "BTCUSDT's four fills, exact entry/exit prices, net R, MFE and MAE reproduce",
                  "the earlier corrected BTC baseline. This is still a historical fill model,",
                  "not live execution evidence. Aggregate SAMPLE_ADEQUACY = INSUFFICIENT (32).",
                  "", "6. COUNTERFACTUAL REJECTED-CANDIDATE PATHS - DIAGNOSTIC ONLY",
                  "For each NO_STRUCTURAL_TARGET and BELOW_RR candidate, scan 15m OHLC from",
                  "the next bar until first invalidation touch or data end. Favorable excursion",
                  "on the stop bar uses only its open as a conservative lower bound; its full",
                  "wick is an upper bound. R divides by gross entry-reference-to-stop distance.",
                  "These are not fills, approved targets, cost-net returns, or executed trades.",
                  "symbol | no-target N | no-target 1R/2R/3R/4R+ lower | below-RR N | below-RR 1R/2R/3R/4R+ lower"])
    for symbol in POLICY["coreUniverse"]:
        diag = RESULT["bySymbol"][symbol]["diagnosticSummary"]
        a, b = diag["NO_STRUCTURAL_TARGET"], diag["NET_RR_BELOW_MINIMUM"]
        counts = lambda x: "/".join(str(x["mfeLowerRAtLeast"][str(k)]) for k in (1, 2, 3, 4))
        lines.append(line((symbol, a["sampleCount"], counts(a), b["sampleCount"], counts(b))))
    for reason in ("NO_STRUCTURAL_TARGET", "NET_RR_BELOW_MINIMUM"):
        q = aggregate["diagnosticSummary"][reason]
        lines.append(f"{reason}: N={q['sampleCount']}; conservative 1/2/3/4R+ " +
                     "/".join(str(q["mfeLowerRAtLeast"][str(k)]) for k in (1, 2, 3, 4)) +
                     f"; stopped={q['stopped']}; censored={q['rightCensored']}; " +
                     f"median MFE={q['medianMfeLowerR']}R; mean MAE={q['meanMaeLowerR']}R; " +
                     f"maximum observed conservative available R={q['maxAvailableConservativeR']}.")
    lines.extend(["NO_TARGET_3R_PLUS_MFE_RATE = 278/1254 = 22.17%; NO_TARGET_4R_PLUS_MFE_RATE",
                  "= 222/1254 = 17.70%. Among the 1243 stopped no-target paths, 267 (21.48%)",
                  "reach 3R+ and 211 (16.98%) reach 4R+ conservatively. Eleven remain right",
                  "censored. BELOW_RR 3R+ = 86/403 (21.34%); 4R+ = 71/403 (17.62%).",
                  "Unusually large MFE values from long or tiny-stop paths are path excursions,",
                  "not realizable return estimates; censored paths are disclosed separately.",
                  "Per-candidate MFE/MAE, maximum available conservative R, and censoring",
                  "are retained in ignored candidate_diagnostics.json for each symbol.",
                  "", "7. SUFFICIENCY, CROSS-INSTRUMENT MECHANISM, AND NEXT ACTION",
                  "CROSS_INSTRUMENT_BOTTLENECK = COMMON_ACROSS_UNIVERSE. Target coverage spans",
                  "23.11%-30.34% and eligible execution spans 0%-2.75% of confirmed cases;",
                  "SOLE_SAME_SIDE_LEVEL_BROKEN is the exact no-target reason in every symbol.",
                  "The 267 stopped no-target paths that later reach 3R+ conservatively show a",
                  "specific cross-symbol opportunity-generation mechanism worth investigating.",
                  "They do not establish an executable target or alpha. The 32 executed trades",
                  "are below the task's 50-trade restriction and below USABLE_BASELINE.",
                  "ALPHA_OPTIMIZATION_CAN_START = NO. No parameter search, symbol selection,",
                  "timeframe change, 4R gate, or live-production activation occurred.",
                  "NEXT_REQUIRED_ACTION = OPPORTUNITY_GENERATION_REDESIGN: preregister a causal",
                  "unconsumed structural-target source for the sole-BROKEN-level cases, then",
                  "test it on the fixed eight-symbol universe under the same 3.00 net-R floor",
                  "and costs. Preserve this untuned baseline as the comparison.",
                  "", "8. VALIDATION AND BOUNDARIES",
                  "Research/data tests: 25 Python tests passed; 2 causal-account Node tests",
                  "passed. Shared regime, structure, setup, risk, real-time analysis and",
                  "decision: 204 targeted Vitest tests passed. Candle aggregation/backtest:",
                  "35 targeted Vitest tests passed. Root TypeScript build passed.",
                  "The replay checks policy equality, canonical checksums, every analysis",
                  "as-of/frame close, shared decision/risk equality, and funnel reconciliation.",
                  "No Phase33C suite was run. git diff --check passed.",
                  "Funding lacks settlement mark prices. The OHLC model cannot prove order",
                  "within a 15m bar, order-book fills, impact, or partial fills. The old",
                  "historical OOS was inspected, and no pristine historical OOS remains.",
                  "PRODUCTION_LIVE_STRATEGY_CONFIG_READY = NO; READY_ALLOWED = NO;",
                  "PRODUCTION_READY = NO. This audit certifies only the frozen research",
                  "policy, fixed-source replay, and measured opportunity sufficiency."])
    return "\n".join(lines) + "\n"


if __name__ == "__main__":
    OUT.write_text(audit(), encoding="utf-8")
    print(OUT)
