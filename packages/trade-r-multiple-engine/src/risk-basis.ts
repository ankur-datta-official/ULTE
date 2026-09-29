import { compareDecimal } from "@ulte/exact-decimal";
import {
  currencyCode,
  instrumentId,
  positiveDecimalString,
  unixMs,
} from "@ulte/instrument-model";
import { EXECUTION_ATTEMPT_SCHEMA_VERSION } from "@ulte/execution-engine";
import {
  TRADE_RISK_BASIS_METHOD,
  TRADE_RISK_BASIS_SCHEMA_VERSION,
  type TradeRiskBasis,
  type TradeRiskBasisCreationResult,
  type TradeRiskBasisRejectedResult,
  type TradeRMultipleExecutionAttempt,
} from "./types.js";

function hasNonEmptyId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.trim() === value;
}

function rejected(): TradeRiskBasisRejectedResult {
  return Object.freeze({
    status: "TRADE_RISK_BASIS_REJECTED",
    reason: "INVALID_EXECUTION_RISK_BASIS",
  });
}

export function isTradeRiskBasis(value: unknown): value is TradeRiskBasis {
  if (typeof value !== "object" || value === null) return false;
  const basis = value as Partial<TradeRiskBasis>;
  try {
    instrumentId(basis.instrumentId);
    positiveDecimalString(basis.initialActualRiskAmount);
    currencyCode(basis.accountCurrency);
    unixMs(basis.riskBasisAsOf);
    return basis.schemaVersion === TRADE_RISK_BASIS_SCHEMA_VERSION
      && basis.riskBasisMethod === TRADE_RISK_BASIS_METHOD
      && hasNonEmptyId(basis.executionAttemptId)
      && hasNonEmptyId(basis.executionPlanId)
      && hasNonEmptyId(basis.tradeIntentId)
      && hasNonEmptyId(basis.candidateId);
  } catch {
    return false;
  }
}

/** Freezes the execution preparation boundary at which actual risk was frozen for execution. */
export function createTradeRiskBasisFromExecutionAttempt(
  executionAttempt: TradeRMultipleExecutionAttempt,
): TradeRiskBasisCreationResult {
  try {
    instrumentId(executionAttempt.instrumentId);
    const actualRiskAmount = positiveDecimalString(executionAttempt.actualRiskAmount);
    const approvedRiskAmount = positiveDecimalString(executionAttempt.approvedRiskAmount);
    currencyCode(executionAttempt.accountCurrency);
    unixMs(executionAttempt.preparedAsOf);
    if (
      executionAttempt.status !== "EXECUTION_ATTEMPT_READY"
      || executionAttempt.schemaVersion !== EXECUTION_ATTEMPT_SCHEMA_VERSION
      || !hasNonEmptyId(executionAttempt.executionAttemptId)
      || !hasNonEmptyId(executionAttempt.executionPlanId)
      || !hasNonEmptyId(executionAttempt.tradeIntentId)
      || !hasNonEmptyId(executionAttempt.candidateId)
      || compareDecimal(actualRiskAmount, approvedRiskAmount) > 0
    ) return rejected();

    const riskBasis = Object.freeze({
      schemaVersion: TRADE_RISK_BASIS_SCHEMA_VERSION,
      executionAttemptId: executionAttempt.executionAttemptId,
      executionPlanId: executionAttempt.executionPlanId,
      tradeIntentId: executionAttempt.tradeIntentId,
      candidateId: executionAttempt.candidateId,
      instrumentId: executionAttempt.instrumentId,
      riskBasisMethod: TRADE_RISK_BASIS_METHOD,
      initialActualRiskAmount: actualRiskAmount,
      accountCurrency: executionAttempt.accountCurrency,
      riskBasisAsOf: executionAttempt.preparedAsOf,
    });
    return Object.freeze({ status: "TRADE_RISK_BASIS_CREATED", riskBasis });
  } catch {
    return rejected();
  }
}
