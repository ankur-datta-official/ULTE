export const ULTE_MINIMUM_NET_RR_BPS = 30_000;

export interface RiskQualificationConfig {
  readonly minimumNetRewardRiskBps: number;
}

export interface RiskCostAssumptions {
  readonly entryCostBps: number;
  readonly targetExitCostBps: number;
  readonly stopExitCostBps: number;
}

function basisPoints(value: unknown, field: string, minimum = 0): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) {
    throw new RangeError(`${field} must be a safe integer greater than or equal to ${minimum}`);
  }
  return value;
}

export function createRiskQualificationConfig(
  input: RiskQualificationConfig,
): Readonly<RiskQualificationConfig> {
  return Object.freeze({
    minimumNetRewardRiskBps: basisPoints(
      input.minimumNetRewardRiskBps,
      "minimumNetRewardRiskBps",
      ULTE_MINIMUM_NET_RR_BPS,
    ),
  });
}

export function createRiskCostAssumptions(
  input: RiskCostAssumptions,
): Readonly<RiskCostAssumptions> {
  return Object.freeze({
    entryCostBps: basisPoints(input.entryCostBps, "entryCostBps"),
    targetExitCostBps: basisPoints(input.targetExitCostBps, "targetExitCostBps"),
    stopExitCostBps: basisPoints(input.stopExitCostBps, "stopExitCostBps"),
  });
}
