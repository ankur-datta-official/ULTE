import { instrumentId, parseTimeframe } from "@ulte/instrument-model";
import { marketDataSource } from "@ulte/market-data";
import { PRIMARY_REGIMES, createRegimeConfig } from "@ulte/regime-engine";
import { createPositionSetupConfig } from "@ulte/setup-engine";
import { createStructureConfig } from "@ulte/structure-engine";
import { createAnalysisProfileId, type AnalysisProfileId } from "./identity.js";
import type { RealtimeAnalysisConfig } from "./types.js";

function positiveSafeInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${field} must be a positive safe integer`);
  }
}

function profileVersion(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) {
    throw new TypeError("profileVersion must be non-empty and have no surrounding whitespace");
  }
  return value;
}

export function createRealtimeAnalysisConfig(input: RealtimeAnalysisConfig): Readonly<RealtimeAnalysisConfig> {
  if (input.timeframes.length === 0) throw new RangeError("At least one analysis timeframe is required");
  const timeframes = input.timeframes.map((item, index) => {
    positiveSafeInteger(item.historyLimit, `timeframes[${index}].historyLimit`);
    return Object.freeze({ timeframe: parseTimeframe(item.timeframe), historyLimit: item.historyLimit });
  });
  if (new Set(timeframes.map((item) => item.timeframe)).size !== timeframes.length) {
    throw new TypeError("Analysis timeframes must be unique");
  }
  const roles = Object.freeze({
    regimeTimeframe: parseTimeframe(input.roles.regimeTimeframe),
    structureTimeframe: parseTimeframe(input.roles.structureTimeframe),
    setupTimeframe: parseTimeframe(input.roles.setupTimeframe),
  });
  const configured = new Set(timeframes.map((item) => item.timeframe));
  for (const [role, timeframe] of Object.entries(roles)) {
    if (!configured.has(timeframe)) throw new TypeError(`${role} must name a configured analysis timeframe`);
  }
  if (roles.structureTimeframe !== roles.setupTimeframe) {
    throw new TypeError("setupTimeframe must equal structureTimeframe for the current setup-engine contract");
  }
  positiveSafeInteger(input.cycleDeduplicationWindowSize, "cycleDeduplicationWindowSize");
  return Object.freeze({
    profileVersion: profileVersion(input.profileVersion),
    instrumentId: instrumentId(input.instrumentId),
    source: marketDataSource(input.source),
    timeframes: Object.freeze(timeframes),
    roles,
    regime: createRegimeConfig(input.regime),
    structure: createStructureConfig(input.structure),
    setup: createPositionSetupConfig(input.setup),
    cycleDeduplicationWindowSize: input.cycleDeduplicationWindowSize,
  });
}

export function analysisProfileId(config: Readonly<RealtimeAnalysisConfig>): AnalysisProfileId {
  const fields = [
    config.profileVersion,
    String(config.cycleDeduplicationWindowSize),
    config.roles.regimeTimeframe,
    config.roles.structureTimeframe,
    config.roles.setupTimeframe,
    String(config.regime.trendLookback),
    String(config.regime.baselineVolatilityBars),
    String(config.regime.recentVolatilityBars),
    String(config.regime.trendEfficiencyMinBps),
    String(config.regime.trendConsistencyMinBps),
    String(config.regime.rangeEfficiencyMaxBps),
    String(config.regime.rangeConsistencyMaxBps),
    String(config.regime.compressionRatioMaxBps),
    String(config.regime.expansionRatioMinBps),
    String(config.structure.lookbackBars),
    String(config.structure.pivotLeftBars),
    String(config.structure.pivotRightBars),
    ...PRIMARY_REGIMES.map((regime) => config.setup.continuationAllowedRegimes.includes(regime) ? "1" : "0"),
    ...PRIMARY_REGIMES.map((regime) => config.setup.breakoutAllowedRegimes.includes(regime) ? "1" : "0"),
    ...PRIMARY_REGIMES.map((regime) => config.setup.reversalAllowedRegimes.includes(regime) ? "1" : "0"),
    String(config.timeframes.length),
  ];
  for (const item of config.timeframes) fields.push(item.timeframe, String(item.historyLimit));
  return createAnalysisProfileId(fields);
}
