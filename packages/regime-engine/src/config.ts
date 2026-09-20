export interface RegimeConfig {
  readonly trendLookback: number;
  readonly baselineVolatilityBars: number;
  readonly recentVolatilityBars: number;
  readonly trendEfficiencyMinBps: number;
  readonly trendConsistencyMinBps: number;
  readonly rangeEfficiencyMaxBps: number;
  readonly rangeConsistencyMaxBps: number;
  readonly compressionRatioMaxBps: number;
  readonly expansionRatioMinBps: number;
}

function positiveSafeInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${field} must be a positive safe integer`);
  }
}

function ratioBps(value: number, field: string, maximum?: number): void {
  if (!Number.isSafeInteger(value) || value < 0 || (maximum !== undefined && value > maximum)) {
    throw new RangeError(`${field} must be a non-negative safe-integer basis-point value`);
  }
}

export function createRegimeConfig(input: RegimeConfig): Readonly<RegimeConfig> {
  positiveSafeInteger(input.trendLookback, "trendLookback");
  if (input.trendLookback < 2) throw new RangeError("trendLookback must contain at least two candles");
  positiveSafeInteger(input.baselineVolatilityBars, "baselineVolatilityBars");
  positiveSafeInteger(input.recentVolatilityBars, "recentVolatilityBars");
  ratioBps(input.trendEfficiencyMinBps, "trendEfficiencyMinBps", 10_000);
  ratioBps(input.trendConsistencyMinBps, "trendConsistencyMinBps", 10_000);
  ratioBps(input.rangeEfficiencyMaxBps, "rangeEfficiencyMaxBps", 10_000);
  ratioBps(input.rangeConsistencyMaxBps, "rangeConsistencyMaxBps", 10_000);
  ratioBps(input.compressionRatioMaxBps, "compressionRatioMaxBps");
  ratioBps(input.expansionRatioMinBps, "expansionRatioMinBps");
  if (input.compressionRatioMaxBps >= input.expansionRatioMinBps) {
    throw new RangeError("compressionRatioMaxBps must be less than expansionRatioMinBps");
  }
  if (input.rangeEfficiencyMaxBps >= input.trendEfficiencyMinBps &&
      input.rangeConsistencyMaxBps >= input.trendConsistencyMinBps) {
    throw new RangeError("Range thresholds must not wholly overlap trend thresholds");
  }
  return Object.freeze({ ...input });
}

export function requiredCandleCount(config: RegimeConfig): number {
  const validated = createRegimeConfig(config);
  if (validated.baselineVolatilityBars > Number.MAX_SAFE_INTEGER - validated.recentVolatilityBars - 1) {
    throw new RangeError("Volatility lookback exceeds safe integer range");
  }
  const volatilityCandles = validated.baselineVolatilityBars + validated.recentVolatilityBars + 1;
  return Math.max(validated.trendLookback, volatilityCandles);
}
