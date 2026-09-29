import type { NetTradePerformanceSnapshot } from "@ulte/net-trade-performance-engine";
import {
  TRADE_R_MULTIPLE_SNAPSHOT_SCHEMA_VERSION,
  type TradeRiskBasis,
  type TradeRMultipleExecutionAttempt,
  type TradeRMultipleProjectionResult,
} from "./types.js";
import {
  createTradeRiskBasisFromExecutionAttempt,
  isTradeRiskBasis,
} from "./risk-basis.js";

function rejected(
  reason: "RISK_BASIS_INVALID" | "R_MULTIPLE_AUTHORITY_INCOHERENT" | "R_MULTIPLE_CURRENCY_MISMATCH",
): TradeRMultipleProjectionResult {
  return Object.freeze({ status: "TRADE_R_MULTIPLE_REJECTED", reason });
}

function authoritiesAreCoherent(
  netPerformance: NetTradePerformanceSnapshot,
  riskBasis: TradeRiskBasis,
): boolean {
  return netPerformance.executionAttemptId === riskBasis.executionAttemptId
    && netPerformance.executionPlanId === riskBasis.executionPlanId
    && netPerformance.tradeIntentId === riskBasis.tradeIntentId
    && netPerformance.candidateId === riskBasis.candidateId
    && netPerformance.instrumentId === riskBasis.instrumentId;
}

/** Composes complete Task031A and Task032A authorities without rerunning either authority. */
export function projectTradeRMultipleFromAuthorities(
  netPerformance: NetTradePerformanceSnapshot,
  riskBasis: TradeRiskBasis,
): TradeRMultipleProjectionResult {
  if (!isTradeRiskBasis(riskBasis)) return rejected("RISK_BASIS_INVALID");
  if (!authoritiesAreCoherent(netPerformance, riskBasis)) {
    return rejected("R_MULTIPLE_AUTHORITY_INCOHERENT");
  }
  if (netPerformance.pnlCurrency !== riskBasis.accountCurrency) {
    return rejected("R_MULTIPLE_CURRENCY_MISMATCH");
  }

  const netRMultipleRatio = Object.freeze({
    numerator: netPerformance.netTotalPnl,
    denominator: riskBasis.initialActualRiskAmount,
  });
  const snapshot = Object.freeze({
    schemaVersion: TRADE_R_MULTIPLE_SNAPSHOT_SCHEMA_VERSION,
    executionAttemptId: netPerformance.executionAttemptId,
    executionPlanId: netPerformance.executionPlanId,
    tradeIntentId: netPerformance.tradeIntentId,
    candidateId: netPerformance.candidateId,
    instrumentId: netPerformance.instrumentId,
    direction: netPerformance.direction,
    pnlCurrency: netPerformance.pnlCurrency,
    accountCurrency: riskBasis.accountCurrency,
    riskBasisMethod: riskBasis.riskBasisMethod,
    initialActualRiskAmount: riskBasis.initialActualRiskAmount,
    riskBasisAsOf: riskBasis.riskBasisAsOf,
    netTotalPnl: netPerformance.netTotalPnl,
    netRMultipleRatio,
    executionAccountingAsOf: netPerformance.executionAccountingAsOf,
    valuationAsOf: netPerformance.valuationAsOf,
    costAccountingAsOf: netPerformance.costAccountingAsOf,
    positionExposure: netPerformance.positionExposure,
    netPerformance,
    riskBasis,
  });
  return Object.freeze({ status: "TRADE_R_MULTIPLE_PROJECTED", snapshot });
}

/** Establishes the immutable execution risk basis once, then composes it with Task031A authority. */
export function projectTradeRMultipleSnapshot(
  executionAttempt: TradeRMultipleExecutionAttempt,
  netPerformance: NetTradePerformanceSnapshot,
): TradeRMultipleProjectionResult {
  const riskBasisCreation = createTradeRiskBasisFromExecutionAttempt(executionAttempt);
  if (riskBasisCreation.status === "TRADE_RISK_BASIS_REJECTED") {
    return Object.freeze({
      status: "TRADE_R_MULTIPLE_REJECTED",
      reason: "RISK_BASIS_REJECTED",
      riskBasisCreation,
    });
  }
  return projectTradeRMultipleFromAuthorities(netPerformance, riskBasisCreation.riskBasis);
}

export class TradeRMultipleEngine {
  project(
    executionAttempt: TradeRMultipleExecutionAttempt,
    netPerformance: NetTradePerformanceSnapshot,
  ): TradeRMultipleProjectionResult {
    return projectTradeRMultipleSnapshot(executionAttempt, netPerformance);
  }
}
