import {
  nonNegativeDecimalString,
  positiveDecimalString,
  type NonNegativeDecimalString,
} from "@ulte/instrument-model";
import { createPortfolioRiskConfig } from "./config.js";
import {
  ZERO,
  add,
  amountWithinBpsLimit,
  compare,
  limitAmount,
  minimum,
  ratioAtOrAboveBps,
  subtractNonNegative,
} from "./internal/decimal.js";
import type {
  AccountRiskSnapshot,
  PortfolioRiskBlockReason,
  PortfolioRiskDataRejectionReason,
  PortfolioRiskEvaluationInput,
  PortfolioRiskResult,
  PortfolioRiskSummary,
  ProposedRiskGroupSummary,
} from "./types.js";

type Identity = Pick<PortfolioRiskSummary, "candidateId" | "instrumentId" | "asOf">;

function identity(input: PortfolioRiskEvaluationInput): Identity {
  const upstream = input.structuralRiskResult;
  return { candidateId: upstream.candidateId, instrumentId: upstream.instrumentId, asOf: upstream.asOf };
}

function rejected(
  input: PortfolioRiskEvaluationInput,
  reason: PortfolioRiskDataRejectionReason,
  unknownRiskGroupId?: string,
): PortfolioRiskResult {
  return Object.freeze({
    status: "DATA_REJECTED",
    ...identity(input),
    reason,
    ...(unknownRiskGroupId === undefined ? {} : { unknownRiskGroupId }),
  });
}

function validateAccountAndRequest(input: PortfolioRiskEvaluationInput): PortfolioRiskResult | undefined {
  try {
    positiveDecimalString(input.account.currentEquity);
  } catch {
    return rejected(input, "INVALID_ACCOUNT_EQUITY");
  }
  try {
    positiveDecimalString(input.account.dayStartEquity);
  } catch {
    return rejected(input, "INVALID_DAY_START_EQUITY");
  }
  try {
    positiveDecimalString(input.requestedRiskAmount);
  } catch {
    return rejected(input, "INVALID_REQUESTED_RISK");
  }
  if (input.account.asOf !== input.structuralRiskResult.asOf) return rejected(input, "AS_OF_MISMATCH");

  const positionIds = new Set<string>();
  for (const position of input.account.openPositions) {
    if (typeof position.positionId !== "string" ||
        position.positionId.length === 0 || position.positionId.trim() !== position.positionId) {
      return rejected(input, "INVALID_POSITION_ID");
    }
    if (positionIds.has(position.positionId)) return rejected(input, "DUPLICATE_POSITION_ID");
    positionIds.add(position.positionId);
    try {
      nonNegativeDecimalString(position.riskAmountAtStop);
    } catch {
      return rejected(input, "INVALID_OPEN_POSITION_RISK");
    }
    if (position.riskGroupIds.length === 0) return rejected(input, "EMPTY_RISK_GROUP");
    const positionGroups = new Set<string>();
    for (const groupId of position.riskGroupIds) {
      if (typeof groupId !== "string" || groupId.length === 0 || groupId.trim() !== groupId) {
        return rejected(input, "EMPTY_RISK_GROUP");
      }
      if (positionGroups.has(groupId)) return rejected(input, "DUPLICATE_POSITION_RISK_GROUP");
      positionGroups.add(groupId);
    }
  }
  const proposedGroups = new Set<string>();
  for (const groupId of input.proposedRiskGroupIds) {
    if (typeof groupId !== "string" || groupId.length === 0 || groupId.trim() !== groupId) {
      return rejected(input, "EMPTY_RISK_GROUP");
    }
    if (proposedGroups.has(groupId)) return rejected(input, "DUPLICATE_PROPOSED_RISK_GROUP");
    proposedGroups.add(groupId);
  }
  return undefined;
}

function sumOpenRisk(account: AccountRiskSnapshot): NonNegativeDecimalString {
  let total = ZERO;
  for (const position of account.openPositions) total = add(total, position.riskAmountAtStop);
  return total;
}

function currentGroupRisk(account: AccountRiskSnapshot, groupId: string): NonNegativeDecimalString {
  let total = ZERO;
  for (const position of account.openPositions) {
    if (position.riskGroupIds.includes(groupId)) total = add(total, position.riskAmountAtStop);
  }
  return total;
}

function capacity(limit: NonNegativeDecimalString, used: NonNegativeDecimalString): NonNegativeDecimalString {
  return compare(limit, used) <= 0 ? ZERO : subtractNonNegative(limit, used);
}

function blocked(
  summary: PortfolioRiskSummary,
  reason: PortfolioRiskBlockReason,
  blockingRiskGroupId?: string,
): PortfolioRiskResult {
  return Object.freeze({
    status: "BLOCKED",
    ...summary,
    reason,
    ...(blockingRiskGroupId === undefined ? {} : { blockingRiskGroupId }),
  });
}

export function evaluatePortfolioRisk(input: PortfolioRiskEvaluationInput): PortfolioRiskResult {
  const upstream = input.structuralRiskResult;
  if (upstream.status !== "QUALIFIED") {
    return Object.freeze({
      status: "UPSTREAM_NOT_QUALIFIED",
      upstreamStatus: upstream.status,
      upstreamReason: upstream.reason,
      candidateId: upstream.candidateId,
      instrumentId: upstream.instrumentId,
      asOf: upstream.asOf,
    });
  }

  const config = createPortfolioRiskConfig(input.config);
  const rejection = validateAccountAndRequest(input);
  if (rejection !== undefined) return rejection;

  const configuredGroups = new Map(config.riskGroupLimits.map((entry) => [entry.groupId, entry]));
  for (const position of input.account.openPositions) {
    for (const groupId of position.riskGroupIds) {
      if (!configuredGroups.has(groupId)) return rejected(input, "UNKNOWN_RISK_GROUP", groupId);
    }
  }
  for (const groupId of input.proposedRiskGroupIds) {
    if (!configuredGroups.has(groupId)) return rejected(input, "UNKNOWN_RISK_GROUP", groupId);
  }

  const currentEquity = positiveDecimalString(input.account.currentEquity);
  const dayStartEquity = positiveDecimalString(input.account.dayStartEquity);
  const requestedRiskAmount = positiveDecimalString(input.requestedRiskAmount);
  const dailyLossAmount = compare(currentEquity, dayStartEquity) >= 0
    ? ZERO
    : subtractNonNegative(dayStartEquity, currentEquity);
  const perTradeRiskLimitAmount = limitAmount(currentEquity, config.maxRiskPerTradeBps);
  const totalOpenRiskLimitAmount = limitAmount(currentEquity, config.maxTotalOpenRiskBps);
  const currentTotalOpenRisk = sumOpenRisk(input.account);
  const postTradeTotalOpenRisk = add(currentTotalOpenRisk, requestedRiskAmount);
  const remainingTotalOpenRiskCapacity = capacity(totalOpenRiskLimitAmount, currentTotalOpenRisk);
  const proposedRiskGroups: ProposedRiskGroupSummary[] = input.proposedRiskGroupIds.map((groupId) => {
    const groupConfig = configuredGroups.get(groupId)!;
    const groupRiskLimitAmount = limitAmount(currentEquity, groupConfig.maxRiskBps);
    const currentRisk = currentGroupRisk(input.account, groupId);
    return Object.freeze({
      groupId,
      groupRiskLimitAmount,
      currentGroupRisk: currentRisk,
      postTradeGroupRisk: add(currentRisk, requestedRiskAmount),
      remainingGroupRiskCapacity: capacity(groupRiskLimitAmount, currentRisk),
    });
  });
  const dailyLimitReached = ratioAtOrAboveBps(dailyLossAmount, dayStartEquity, config.maxDailyLossBps);
  const concurrentLimitReached = input.account.openPositions.length >= config.maxConcurrentPositions;
  const ordinaryCapacities = [
    perTradeRiskLimitAmount,
    remainingTotalOpenRiskCapacity,
    ...proposedRiskGroups.map((group) => group.remainingGroupRiskCapacity),
  ];
  const maximumAdditionalRiskAmount = dailyLimitReached || concurrentLimitReached
    ? ZERO
    : minimum(ordinaryCapacities);
  const summary: PortfolioRiskSummary = {
    ...identity(input),
    baseCurrency: input.account.baseCurrency,
    requestedRiskAmount,
    currentEquity,
    dayStartEquity,
    dailyLossAmount,
    perTradeRiskLimitAmount,
    currentTotalOpenRisk,
    totalOpenRiskLimitAmount,
    postTradeTotalOpenRisk,
    remainingTotalOpenRiskCapacity,
    proposedRiskGroups: Object.freeze(proposedRiskGroups),
    maximumAdditionalRiskAmount,
  };

  if (dailyLimitReached) return blocked(summary, "DAILY_LOSS_LIMIT_REACHED");
  if (concurrentLimitReached) return blocked(summary, "MAX_CONCURRENT_POSITIONS_REACHED");
  if (!amountWithinBpsLimit(requestedRiskAmount, currentEquity, config.maxRiskPerTradeBps)) {
    return blocked(summary, "PER_TRADE_RISK_LIMIT_EXCEEDED");
  }
  if (!amountWithinBpsLimit(postTradeTotalOpenRisk, currentEquity, config.maxTotalOpenRiskBps)) {
    return blocked(summary, "TOTAL_OPEN_RISK_LIMIT_EXCEEDED");
  }
  for (const group of proposedRiskGroups) {
    const groupConfig = configuredGroups.get(group.groupId)!;
    if (!amountWithinBpsLimit(group.postTradeGroupRisk, currentEquity, groupConfig.maxRiskBps)) {
      return blocked(summary, "RISK_GROUP_LIMIT_EXCEEDED", group.groupId);
    }
  }
  return Object.freeze({ status: "CAPITAL_ELIGIBLE", ...summary });
}
