/** Replay the frozen universe through the actual shared analysis and decision engines. */
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createCandle } from "../../packages/market-data/dist/index.js";
import { RealtimeAnalysisEngine } from "../../packages/realtime-analysis-engine/dist/index.js";
import { RealtimeDecisionEngine } from "../../packages/realtime-decision-engine/dist/index.js";
import { qualifyStructuralRisk } from "../../packages/risk-engine/dist/index.js";
import { compareDecimal } from "../../packages/exact-decimal/dist/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const dataRoot = join(here, "..", "data", "core_universe_v1");
const policyBytes = readFileSync(join(here, "ALPHA_RESEARCH_POLICY_V1.json"));
const policy = JSON.parse(policyBytes);
const old = JSON.parse(readFileSync(join(here, "REPLAY_CONFIG_EXPLORATORY_V1.json")));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
if (policy.status !== "UNTUNED_PRE_OPTIMIZATION_BASELINE" ||
    !same({...policy.analysis, profileVersion: old.analysis.profileVersion}, old.analysis) ||
    !same(policy.decision, old.decision) || !same(policy.costs, old.costs) ||
    policy.risk.minimumNetRewardRiskBps !== old.risk.minimumNetRewardRiskBps ||
    policy.historicalEndExclusive !== "2026-10-01T00:00:00Z") {
  throw new Error("Alpha-sensitive policy differs from corrected untuned baseline");
}
const cutoff = Date.parse(policy.historicalEndExclusive);
const policySha256 = createHash("sha256").update(policyBytes).digest("hex");
const manifest = JSON.parse(readFileSync(join(here, "CORE_UNIVERSE_DATA_MANIFEST_V1.json")));
const btcManifest = JSON.parse(readFileSync(join(here, "RESEARCH_TARGET_V1.json")));
const costs = policy.costs;
const riskCosts = {
  entryCostBps: costs.entryFeeBps + costs.entrySlippageBps + costs.spreadBps,
  targetExitCostBps: costs.exitFeeBps + costs.exitSlippageBps + costs.spreadBps,
  stopExitCostBps: costs.exitFeeBps + costs.exitSlippageBps + costs.spreadBps,
};
const snapshot = (candle) => ({candle: createCandle(candle), quality: ["HISTORICAL"]});

function exclusion(level, candidate, entry) {
  if (level.status !== "ACTIVE") return "RESOLVED";
  if (level.confirmedAt > candidate.asOf) return "FUTURE_CONFIRMATION";
  if (level.side !== (candidate.direction === "UP" ? "BUY_SIDE" : "SELL_SIDE")) return "WRONG_SIDE";
  const comparison = compareDecimal(level.price, entry);
  if (candidate.direction === "UP" ? comparison <= 0 : comparison >= 0) return "NOT_BEYOND_ENTRY";
  return "ELIGIBLE";
}

function noTargetReason(levels, candidate, entry) {
  if (!levels.length) return "NO_LEVEL_IN_STRUCTURE_WINDOW";
  const sameSide = levels.filter((level) => level.side === (candidate.direction === "UP" ? "BUY_SIDE" : "SELL_SIDE"));
  if (!sameSide.length) return "NO_SAME_SIDE_LEVEL";
  const active = sameSide.filter((level) => level.status === "ACTIVE");
  if (!active.length) {
    if (sameSide.length === 1 && sameSide[0].status === "BROKEN") return "SOLE_SAME_SIDE_LEVEL_BROKEN";
    return "ALL_SAME_SIDE_LEVELS_RESOLVED";
  }
  if (active.every((level) => level.confirmedAt > candidate.asOf)) return "ACTIVE_SAME_SIDE_LEVELS_FUTURE";
  if (active.every((level) => exclusion(level, candidate, entry) !== "ELIGIBLE")) {
    return "ACTIVE_SAME_SIDE_LEVELS_NOT_BEYOND_ENTRY";
  }
  return "TARGET_FINDER_MISMATCH";
}

function inputRoot(symbol) {
  return symbol === "BTCUSDT" ? join(here, "..", "data", "binance_btcusdt_v1") : join(dataRoot, symbol);
}

function verifiedCandles(symbol, timeframe) {
  const root = inputRoot(symbol);
  const path = symbol === "BTCUSDT" && timeframe === "15m"
    ? join(root, "normalized", "15m", "candles.json")
    : join(root, "canonical", timeframe, "candles.json");
  const bytes = readFileSync(path);
  const expected = symbol === "BTCUSDT"
    ? (timeframe === "15m" ? btcManifest.quality["15m"].normalizedSha256
                          : btcManifest.canonicalPricePolicy.derived[timeframe]?.sha256)
    : manifest.symbols[symbol].canonical[timeframe].sha256;
  if (expected && createHash("sha256").update(bytes).digest("hex") !== expected) {
    throw new Error(`Canonical ${symbol} ${timeframe} checksum mismatch`);
  }
  return JSON.parse(bytes);
}

function researchContext(asOf, instrumentId, symbol) {
  // This context only lets the shared decision engine traverse its contract.
  // Signal eligibility is taken from structural risk, before portfolio/sizing.
  return {
    riskCosts, riskConfig: { minimumNetRewardRiskBps: policy.risk.minimumNetRewardRiskBps },
    account: {asOf, baseCurrency: "USDT", currentEquity: "1000000000",
              dayStartEquity: "1000000000", openPositions: []},
    requestedRiskAmount: "1000", proposedRiskGroupIds: [],
    portfolioRiskConfig: {maxRiskPerTradeBps: 10000, maxTotalOpenRiskBps: 10000,
                          maxConcurrentPositions: 1000000, maxDailyLossBps: 10000, riskGroupLimits: []},
    instrumentSizingSpec: {valuationModel: "LINEAR_PRICE_PNL", instrumentId,
                           pnlCurrency: "USDT", quantityUnit: symbol.slice(0, -4),
                           quantityStep: "0.00000001", minimumQuantity: "0.00000001",
                           maximumQuantity: "1000000000000", pnlValuePerPriceUnitPerQuantity: "1"},
  };
}

async function replay(symbol) {
  const instrumentId = `ulte:v1:BINANCE:PERPETUAL:${symbol}`;
  const root = inputRoot(symbol);
  const candles = Object.fromEntries(["1h", "4h", "1d"].map(tf => [tf, verifiedCandles(symbol, tf)]));
  const raw = verifiedCandles(symbol, "15m");
  if (raw.at(-1)?.closeTime !== cutoff || candles["1h"].at(-1)?.closeTime !== cutoff ||
      raw.length !== 4 * candles["1h"].length ||
      candles["1h"][0].openTime !== raw[0].openTime) {
    throw new Error(`Incomplete cutoff or misaligned detail path for ${symbol}`);
  }
  const fundingPath = symbol === "BTCUSDT"
    ? join(root, "normalized", "fundingRate", "funding.json")
    : join(root, "normalized", "fundingRate", "funding.json");
  const funding = JSON.parse(readFileSync(fundingPath));
  if (funding.some(event => event.time >= cutoff)) throw new Error("Forward funding data entered replay");
  const config = {...policy.analysis, instrumentId, source: "BINANCE_PUBLIC_DATA"};
  const analysisEngine = new RealtimeAnalysisEngine(config);
  const decisionEngine = new RealtimeDecisionEngine({profileVersion: config.profileVersion, ...policy.decision});
  const indices = {"4h": 0, "1d": 0};
  const funnel = {TOTAL_CYCLES: 0, SETUP_CANDIDATES: 0, CONFIRMED_CANDIDATES: 0,
                  NO_STRUCTURAL_TARGET: 0, BELOW_RR: 0, COST_BLOCKED: 0,
                  SIGNAL_ELIGIBLE: 0, MULTIPLE_ACTIONABLE: 0,
                  OTHER_STRUCTURAL_REJECTION: 0};
  const rows = [];
  for (const candle of candles["1h"]) {
    const events = [{type: "CANDLE_CLOSED", timeframe: "1h", snapshot: snapshot(candle)}];
    for (const tf of ["4h", "1d"]) {
      const next = candles[tf][indices[tf]];
      if (next?.closeTime === candle.closeTime) {
        events.push({type: "CANDLE_CLOSED", timeframe: tf, snapshot: snapshot(next)});
        indices[tf] += 1;
      }
    }
    const result = analysisEngine.processCandleEvents(events);
    if (result.status !== "ANALYSIS_CYCLES" || result.cycles.length !== 1) throw new Error("Expected one analysis cycle");
    const analysis = result.cycles[0];
    const decision = decisionEngine.process({analysis, context: researchContext(candle.closeTime, instrumentId, symbol)});
    if (analysis.analysisAsOf !== candle.closeTime || decision.analysisAsOf !== candle.closeTime ||
        analysis.frame.timeframes.some(frame => frame.candles.some(s => !s.candle.isClosed || s.candle.closeTime > candle.closeTime))) {
      throw new Error(`Future or partial analysis frame at ${symbol} ${candle.closeTime}`);
    }
    funnel.TOTAL_CYCLES += 1;
    if (analysis.status !== "ANALYZED" || analysis.setup.status !== "READY") continue;
    const candidates = analysis.setup.candidates;
    funnel.SETUP_CANDIDATES += candidates.length;
    const confirmed = candidates.filter(candidate => candidate.stage === "CONFIRMED");
    funnel.CONFIRMED_CANDIDATES += confirmed.length;
    if (!confirmed.length) continue;
    if (confirmed.length > 1) funnel.MULTIPLE_ACTIONABLE += confirmed.length;
    for (const candidate of confirmed) {
      const setupFrame = analysis.frame.timeframes.find(frame => frame.timeframe === candidate.setupTimeframe);
      const risk = qualifyStructuralRisk({candidate, structure: analysis.structure,
        setupCandles: setupFrame.candles, costs: riskCosts, config: {minimumNetRewardRiskBps: policy.risk.minimumNetRewardRiskBps}});
      if (confirmed.length === 1 && (!decision.structuralRiskResult ||
          !same(risk, decision.structuralRiskResult) || decision.setupCandidate.id !== candidate.id)) {
        throw new Error(`Shared decision/risk mismatch at ${symbol} ${candidate.asOf}`);
      }
      const reason = risk.reason ?? "QUALIFIED";
      if (reason === "NO_STRUCTURAL_TARGET") funnel.NO_STRUCTURAL_TARGET += 1;
      else if (reason === "NET_RR_BELOW_MINIMUM") funnel.BELOW_RR += 1;
      else if (reason === "COSTS_CONSUME_REWARD") funnel.COST_BLOCKED += 1;
      else if (reason === "QUALIFIED" && confirmed.length === 1) {
        funnel.SIGNAL_ELIGIBLE += 1;
        if (decision.status !== "TRADE_INTENT_CREATED") {
          throw new Error(`Research context suppressed qualified signal at ${symbol} ${candidate.asOf}: ${decision.blockingStage}`);
        }
      } else if (reason !== "QUALIFIED") funnel.OTHER_STRUCTURAL_REJECTION += 1;
      const levels = analysis.structure.liquidityLevels;
      const targetReason = reason === "NO_STRUCTURAL_TARGET"
        ? noTargetReason(levels, candidate, risk.entryReferencePrice) : null;
      if (targetReason === "TARGET_FINDER_MISMATCH") throw new Error("Shared target finder missed eligible level");
      rows.push({asOf: candidate.asOf, candidateId: candidate.id, direction: candidate.direction,
        family: candidate.family, regime: analysis.regime.primaryRegime,
        entryReferencePrice: risk.entryReferencePrice ?? null,
        invalidationPrice: risk.invalidationPrice ?? null,
        primaryTargetPrice: risk.primaryTargetPrice ?? null,
        netRewardRiskBps: risk.netRewardRiskBps ?? null,
        reason, targetReason, multipleActionable: confirmed.length > 1,
        decisionStatus: decision.status});
    }
    if (funnel.TOTAL_CYCLES % 10000 === 0) console.log(`${symbol}: ${funnel.TOTAL_CYCLES} cycles`);
  }
  if (indices["4h"] !== candles["4h"].length || indices["1d"] !== candles["1d"].length) {
    throw new Error(`Unreplayed HTF candle for ${symbol}`);
  }
  const output = join(dataRoot, symbol);
  mkdirSync(output, {recursive: true});
  writeFileSync(join(output, "signal_replay.json"), JSON.stringify({
    symbol, instrumentId, policyId: policy.id, policySha256,
    historicalStartInclusive: new Date(raw[0].openTime).toISOString(),
    historicalEndExclusive: policy.historicalEndExclusive,
    canonical15mSha256: createHash("sha256").update(readFileSync(symbol === "BTCUSDT"
      ? join(root, "normalized", "15m", "candles.json")
      : join(root, "canonical", "15m", "candles.json"))).digest("hex"),
    funnel, candidates: rows,
  }, null, 2) + "\n");
  console.log(`${symbol}: ${funnel.TOTAL_CYCLES} cycles, ${funnel.CONFIRMED_CANDIDATES} confirmed, ${funnel.SIGNAL_ELIGIBLE} signals`);
}

for (const symbol of policy.coreUniverse) await replay(symbol);
