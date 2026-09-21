export interface RiskGroupLimit {
  readonly groupId: string;
  readonly maxRiskBps: number;
}

export interface PortfolioRiskConfig {
  readonly maxRiskPerTradeBps: number;
  readonly maxTotalOpenRiskBps: number;
  readonly maxConcurrentPositions: number;
  readonly maxDailyLossBps: number;
  readonly riskGroupLimits: readonly RiskGroupLimit[];
}

function positiveBasisPoints(value: unknown, field: string, maximum = 10_000): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new RangeError(`${field} must be a positive safe integer no greater than ${maximum}`);
  }
  return value;
}

function nonEmptyId(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) {
    throw new TypeError(`${field} must be non-empty and have no surrounding whitespace`);
  }
  return value;
}

export function createPortfolioRiskConfig(input: PortfolioRiskConfig): Readonly<PortfolioRiskConfig> {
  const maxRiskPerTradeBps = positiveBasisPoints(input.maxRiskPerTradeBps, "maxRiskPerTradeBps");
  const maxTotalOpenRiskBps = positiveBasisPoints(input.maxTotalOpenRiskBps, "maxTotalOpenRiskBps");
  if (maxRiskPerTradeBps > maxTotalOpenRiskBps) {
    throw new RangeError("maxRiskPerTradeBps must not exceed maxTotalOpenRiskBps");
  }
  if (typeof input.maxConcurrentPositions !== "number" ||
      !Number.isSafeInteger(input.maxConcurrentPositions) || input.maxConcurrentPositions <= 0) {
    throw new RangeError("maxConcurrentPositions must be a positive safe integer");
  }
  const groupIds = new Set<string>();
  const riskGroupLimits = input.riskGroupLimits.map((entry) => {
    const groupId = nonEmptyId(entry.groupId, "riskGroupLimits.groupId");
    if (groupIds.has(groupId)) throw new TypeError(`Duplicate risk group limit: ${groupId}`);
    groupIds.add(groupId);
    return Object.freeze({
      groupId,
      maxRiskBps: positiveBasisPoints(entry.maxRiskBps, `riskGroupLimits[${groupId}].maxRiskBps`, maxTotalOpenRiskBps),
    });
  });
  return Object.freeze({
    maxRiskPerTradeBps,
    maxTotalOpenRiskBps,
    maxConcurrentPositions: input.maxConcurrentPositions,
    maxDailyLossBps: positiveBasisPoints(input.maxDailyLossBps, "maxDailyLossBps"),
    riskGroupLimits: Object.freeze(riskGroupLimits),
  });
}
