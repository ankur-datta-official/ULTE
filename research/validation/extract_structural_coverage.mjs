/** Extract confirmed-candidate evidence without changing shared trading rules. */
import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { compareDecimal } from "../../packages/exact-decimal/dist/index.js";
import { qualifyStructuralRisk } from "../../packages/risk-engine/dist/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "data", "binance_btcusdt_v1");
const cutoff = Date.parse("2026-10-01T00:00:00Z");
const replay = JSON.parse(readFileSync(join(root, "replay.json"), "utf8"));
const profile = JSON.parse(readFileSync(join(here, "REPLAY_CONFIG_EXPLORATORY_V1.json"), "utf8"));
if (replay.candles.at(-1)?.closeTime !== cutoff ||
    replay.metadata.strategyConfigStatus !== profile.status ||
    replay.observations.at(-1)?.analysis.analysisAsOf !== cutoff) {
  throw new Error("Unexpected historical dataset boundary or profile");
}
const costs = profile.costs;
const riskCosts = {
  entryCostBps: costs.entryFeeBps + costs.entrySlippageBps + costs.spreadBps,
  targetExitCostBps: costs.exitFeeBps + costs.exitSlippageBps + costs.spreadBps,
  stopExitCostBps: costs.exitFeeBps + costs.exitSlippageBps + costs.spreadBps,
};
const riskConfig = { minimumNetRewardRiskBps: profile.risk.minimumNetRewardRiskBps };

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
  const sameSide = levels.filter((level) =>
    level.side === (candidate.direction === "UP" ? "BUY_SIDE" : "SELL_SIDE"));
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

const rows = [];
for (const { analysis, decision } of replay.observations) {
  if (analysis.status !== "ANALYZED" || analysis.setup.status !== "READY") continue;
  const confirmed = analysis.setup.candidates.filter((candidate) => candidate.stage === "CONFIRMED");
  if (!confirmed.length) continue;
  if (confirmed.length !== 1) throw new Error("Multiple confirmed candidates require explicit risk diagnostics");
  const candidate = confirmed[0];
  if (!decision.structuralRiskResult || decision.setupCandidate.id !== candidate.id) {
    throw new Error("Confirmed candidate lacks paired structural risk result");
  }
  const setupFrame = analysis.frame.timeframes.find((frame) => frame.timeframe === candidate.setupTimeframe);
  if (!setupFrame) throw new Error("Missing setup frame");
  const recalculated = qualifyStructuralRisk({
    candidate, structure: analysis.structure, setupCandles: setupFrame.candles,
    costs: riskCosts, config: riskConfig,
  });
  if (JSON.stringify(recalculated) !== JSON.stringify(decision.structuralRiskResult)) {
    throw new Error(`Shared risk replay mismatch at ${candidate.asOf}`);
  }
  const risk = recalculated;
  const levels = analysis.structure.liquidityLevels;
  const entry = risk.entryReferencePrice;
  const levelExclusions = entry === undefined ? [] : levels.map((level) => ({
    side: level.side, status: level.status, price: level.price,
    confirmedAt: level.confirmedAt, sourceSwingId: level.sourceSwingId,
    exclusion: exclusion(level, candidate, entry),
  }));
  const reason = risk.reason ?? "QUALIFIED";
  const targetReason = reason === "NO_STRUCTURAL_TARGET"
    ? noTargetReason(levels, candidate, entry) : null;
  if (targetReason === "TARGET_FINDER_MISMATCH") throw new Error(`Target finder missed eligible level at ${candidate.asOf}`);
  if (reason === "NO_STRUCTURAL_TARGET" && levelExclusions.some((level) => level.exclusion === "ELIGIBLE")) {
    throw new Error(`No-target result has eligible structural level at ${candidate.asOf}`);
  }
  rows.push({
    asOf: candidate.asOf, utc: new Date(candidate.asOf).toISOString(),
    candidateId: candidate.id, direction: candidate.direction,
    family: candidate.family, contextTimeframe: candidate.contextTimeframe,
    setupTimeframe: candidate.setupTimeframe, regime: analysis.regime.primaryRegime,
    regimeDirection: analysis.regime.direction, volatilityState: analysis.regime.volatilityState,
    structureState: analysis.structure.structureState,
    entryReferencePrice: entry ?? null, invalidationPrice: risk.invalidationPrice ?? null,
    primaryTargetPrice: risk.primaryTargetPrice ?? null,
    targetPath: risk.targetPath ?? [],
    reason, targetReason, levelExclusions,
    grossRisk: risk.grossRisk ?? null, grossReward: risk.grossReward ?? null,
    netRisk: risk.netRisk ?? null, netReward: risk.netReward ?? null,
    netRewardRiskBps: risk.netRewardRiskBps ?? null,
    entryCost: risk.entryCost ?? null, targetExitCost: risk.targetExitCost ?? null,
    stopExitCost: risk.stopExitCost ?? null,
    decisionStatus: decision.status,
  });
}
if (rows.length !== 205) throw new Error(`Expected 205 confirmed candidates, got ${rows.length}`);
writeFileSync(join(root, "structural_candidates.json"), `${JSON.stringify({
  profileStatus: profile.status, historicalEndExclusive: cutoff, costAssumptions: riskCosts,
  rows,
}, null, 2)}\n`);
console.log(`Verified and extracted ${rows.length} shared-engine structural decisions`);
