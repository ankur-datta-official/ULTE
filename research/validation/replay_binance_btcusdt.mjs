/** Data-corrected exploratory export through shared ULTE analysis and decision engines. */
import { createWriteStream, readFileSync } from "node:fs";
import { once } from "node:events";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { createCandle } from "../../packages/market-data/dist/index.js";
import { RealtimeAnalysisEngine } from "../../packages/realtime-analysis-engine/dist/index.js";
import { RealtimeDecisionEngine } from "../../packages/realtime-decision-engine/dist/index.js";
import { CausalResearchAccount } from "./causal_account.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "data", "binance_btcusdt_v1");
const instrumentId = "ulte:v1:BINANCE:PERPETUAL:BTCUSDT";
const source = "BINANCE_PUBLIC_DATA";
const candles = Object.fromEntries(["1h", "4h", "1d"].map((timeframe) => [
  timeframe,
  JSON.parse(readFileSync(join(root, "canonical", timeframe, "candles.json"), "utf8")),
]));
const manifest = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "RESEARCH_TARGET_V1.json"), "utf8"));
const profile = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "REPLAY_CONFIG_EXPLORATORY_V1.json"), "utf8"));
if (profile.status !== "EXPLORATORY_TEST_SETTINGS_NO_PRODUCTION_COMPOSITION") throw new Error("Unexpected strategy profile");
const deepFreeze = (value) => {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
};
deepFreeze(profile);
const config = { ...profile.analysis, instrumentId, source };
const analysisEngine = new RealtimeAnalysisEngine(config);
const decisionEngine = new RealtimeDecisionEngine({
  profileVersion: config.profileVersion, ...profile.decision,
});
const costs = profile.costs;
const account = new CausalResearchAccount({ initialEquity: profile.risk.initialEquity, instrumentId,
  riskFraction: profile.risk.riskFraction, costs });
const executionCandles = JSON.parse(readFileSync(join(root, "normalized", "15m", "candles.json"), "utf8"));
const fundingEvents = JSON.parse(readFileSync(join(root, "normalized", "fundingRate", "funding.json"), "utf8"));
const context = (asOf) => ({
  riskCosts: {
    entryCostBps: costs.entryFeeBps + costs.entrySlippageBps + costs.spreadBps,
    targetExitCostBps: costs.exitFeeBps + costs.exitSlippageBps + costs.spreadBps,
    stopExitCostBps: costs.exitFeeBps + costs.exitSlippageBps + costs.spreadBps,
  },
  riskConfig: { minimumNetRewardRiskBps: profile.risk.minimumNetRewardRiskBps },
  account: account.snapshot(asOf),
  requestedRiskAmount: account.requestedRiskAmount(),
  proposedRiskGroupIds: [],
  portfolioRiskConfig: profile.risk.portfolioRiskConfig,
  instrumentSizingSpec: {
    ...profile.risk.instrumentSizingSpec, instrumentId,
  },
});
const snapshot = (candle) => ({
  candle: createCandle(candle), quality: ["HISTORICAL"],
});
const output = createWriteStream(join(root, "replay.json"), { encoding: "utf8" });
async function write(text) {
  if (!output.write(text)) await once(output, "drain");
}
await write(JSON.stringify({
  metadata: {
    datasetId: "RESEARCH_TARGET_V1", instrumentId, timeframe: "1h",
    source: manifest.source, codeRevision: "7fcbf5e11f814b6fa3de38a6243803b9abae2128",
    pricePolicy: "CANONICAL_CHECKSUM_VERIFIED_15M_DERIVED_HTF",
    accountPolicy: "CAUSAL_RESEARCH_ACCOUNT_V1",
    strategyConfigStatus: profile.status,
    strategyConfigSnapshot: profile,
  },
  config: {
    trainEnd: Date.parse("2024-01-01T00:00:00Z"),
    validationEnd: Date.parse("2025-07-01T00:00:00Z"),
    ...costs, fundingBpsPerCandle: 0,
  },
  candles: candles["1h"],
  executionCandles,
  fundingEvents,
}).slice(0, -1) + ',"observations":[');
const indices = { "4h": 0, "1d": 0 };
let count = 0;
let created = 0;
for (const [hourIndex, candle] of candles["1h"].entries()) {
  account.advance(candle.closeTime,
    hourIndex === 0 ? [] : executionCandles.slice(hourIndex * 4, hourIndex * 4 + 4),
    fundingEvents);
  const events = [{ type: "CANDLE_CLOSED", timeframe: "1h", snapshot: snapshot(candle) }];
  for (const timeframe of ["4h", "1d"]) {
    const next = candles[timeframe][indices[timeframe]];
    if (next?.closeTime === candle.closeTime) {
      events.push({ type: "CANDLE_CLOSED", timeframe, snapshot: snapshot(next) });
      indices[timeframe] += 1;
    }
  }
  const result = analysisEngine.processCandleEvents(events);
  if (result.status !== "ANALYSIS_CYCLES" || result.cycles.length !== 1) {
    throw new Error(`Expected exactly one analysis cycle at ${candle.closeTime}`);
  }
  const analysis = result.cycles[0];
  const decisionContext = context(analysis.analysisAsOf);
  const decision = decisionEngine.process({ analysis, context: decisionContext });
  if (decision.status === "TRADE_INTENT_CREATED") {
    created += 1;
    if (hourIndex + 1 < candles["1h"].length) account.accept(decision);
  }
  await write((count ? "," : "") + JSON.stringify({ analysis, decision,
    ...(decision.status === "NO_DECISION" ? {} : { accountAtDecision: {
      ...decisionContext.account, requestedRiskAmount: decisionContext.requestedRiskAmount,
    } }),
  }));
  count += 1;
  if (count % 10000 === 0) console.log(`Replayed ${count} hours, ${created} intents`);
}
if (indices["4h"] !== candles["4h"].length || indices["1d"] !== candles["1d"].length) {
  throw new Error("Higher-timeframe candle left unreplayed");
}
await write(`],"causalAccount":${JSON.stringify({
  initialEquity: account.initialEquity,
  finalEquity: account.currentEquity,
  closedTrades: account.completed,
  unresolvedPositions: account.positions,
})}}\n`);
output.end();
await once(output, "finish");
console.log(`Exported ${count} paired cycles and ${created} intents`);
