/** Verify the complete ignored replay export against the frozen dataset. */
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "data", "binance_btcusdt_v1");
const replay = JSON.parse(readFileSync(join(root, "replay.json"), "utf8"));
const manifest = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "RESEARCH_TARGET_V1.json"), "utf8"));
const hours = replay.candles;
if (replay.metadata.pricePolicy !== "CANONICAL_CHECKSUM_VERIFIED_15M_DERIVED_HTF" ||
    replay.metadata.accountPolicy !== "CAUSAL_RESEARCH_ACCOUNT_V1" ||
    replay.metadata.strategyConfigStatus !== "EXPLORATORY_TEST_SETTINGS_NO_PRODUCTION_COMPOSITION") {
  throw new Error("Replay provenance or certification label changed");
}
for (const timeframe of ["1h", "4h", "1d"]) {
  const payload = readFileSync(join(root, "canonical", timeframe, "candles.json"));
  const digest = createHash("sha256").update(payload).digest("hex");
  if (digest !== manifest.canonicalPricePolicy.derived[timeframe].sha256) {
    throw new Error(`Canonical ${timeframe} candles changed after manifest creation`);
  }
}
if (replay.metadata.datasetId !== manifest.id || replay.observations.length !== hours.length ||
    hours.length !== manifest.quality["1h"].rows) {
  throw new Error("Replay does not cover the frozen hourly dataset");
}
let intents = 0;
for (let index = 0; index < hours.length; index++) {
  const hour = hours[index];
  const { analysis, decision } = replay.observations[index];
  const asOf = hour.closeTime;
  if (analysis.analysisAsOf !== asOf || decision.analysisAsOf !== asOf ||
      analysis.triggerCloseTime !== asOf || decision.triggerCloseTime !== asOf ||
      decision.analysisCycleId !== analysis.analysisCycleId) {
    throw new Error(`Paired cycle mismatch at hourly index ${index}`);
  }
  const frames = analysis.frame.timeframes;
  if (frames.map((frame) => frame.timeframe).join(",") !== "1h,4h,1d") {
    throw new Error(`Unexpected analysis timeframes at hourly index ${index}`);
  }
  for (const frame of frames) {
    if (frame.candles.some((snapshot) => !snapshot.candle.isClosed ||
        snapshot.candle.closeTime > asOf || snapshot.candle.timeframe !== frame.timeframe)) {
      throw new Error(`Future or open frame candle at hourly index ${index}`);
    }
  }
  if (frames[0].candles.at(-1)?.candle.closeTime !== asOf) {
    throw new Error(`Hourly trigger candle missing at index ${index}`);
  }
  if (decision.status === "TRADE_INTENT_CREATED") intents += 1;
  if (decision.status !== "NO_DECISION") {
    const account = replay.observations[index].accountAtDecision;
    if (account?.asOf !== asOf || !account.requestedRiskAmount ||
        !account.currentEquity || !account.dayStartEquity) {
      throw new Error(`Missing causal account state at actionable boundary ${index}`);
    }
  }
}
if (replay.causalAccount.closedTrades.length !== intents || replay.causalAccount.unresolvedPositions.length) {
  throw new Error("Intent count does not reconcile to closed causal positions");
}
console.log(`PASS: ${hours.length} paired hourly cycles, no future frame candles, ${intents} intents and causal closes`);
