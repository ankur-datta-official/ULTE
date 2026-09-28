import { addDecimal } from "@ulte/exact-decimal";
import {
  projectUnrealizedTradeValuation,
  type UnrealizedTradeValuation,
} from "@ulte/trade-valuation-engine";
import {
  TRADE_PERFORMANCE_SNAPSHOT_SCHEMA_VERSION,
  type AuthoritativePerformanceAttempt,
  type TradePerformanceAccountingSpec,
  type TradePerformanceProjectionResult,
  type TradePerformanceRejectedResult,
  type TradePerformanceValuationMark,
} from "./types.js";

function rejectedIncoherent(): TradePerformanceRejectedResult {
  return Object.freeze({
    status: "TRADE_PERFORMANCE_REJECTED",
    reason: "PERFORMANCE_AGGREGATION_INCOHERENT",
  });
}

function isCoherent(valuation: UnrealizedTradeValuation): boolean {
  const accounting = valuation.realizedAccounting;
  return accounting.executionAttemptId === valuation.executionAttemptId
    && accounting.instrumentId === valuation.instrumentId
    && accounting.openQuantity === valuation.openQuantity
    && accounting.accountingAsOf === valuation.accountingAsOf
    && accounting.positionExposure.openQuantity === valuation.openQuantity;
}

/** Aggregates Task028A's authoritative realized and unrealized gross PnL for one attempt. */
export function projectTradePerformanceSnapshot(
  attempt: AuthoritativePerformanceAttempt,
  accountingSpec: TradePerformanceAccountingSpec,
  valuationMark: TradePerformanceValuationMark,
): TradePerformanceProjectionResult {
  const valuationProjection = projectUnrealizedTradeValuation(attempt, accountingSpec, valuationMark);
  if (valuationProjection.status === "UNREALIZED_VALUATION_REJECTED") {
    return Object.freeze({
      status: "TRADE_PERFORMANCE_REJECTED",
      reason: "UNREALIZED_VALUATION_REJECTED",
      valuationProjection,
    });
  }

  const valuation = valuationProjection.valuation;
  if (!isCoherent(valuation)) return rejectedIncoherent();
  const accounting = valuation.realizedAccounting;
  const grossTotalPnl = addDecimal(accounting.grossRealizedPnl, valuation.grossUnrealizedPnl);

  const snapshot = Object.freeze({
    schemaVersion: TRADE_PERFORMANCE_SNAPSHOT_SCHEMA_VERSION,
    executionAttemptId: valuation.executionAttemptId,
    executionPlanId: valuation.executionPlanId,
    tradeIntentId: valuation.tradeIntentId,
    candidateId: valuation.candidateId,
    instrumentId: valuation.instrumentId,
    direction: valuation.direction,
    valuationModel: valuation.valuationModel,
    pnlCurrency: valuation.pnlCurrency,
    pnlValuePerPriceUnitPerQuantity: valuation.pnlValuePerPriceUnitPerQuantity,
    filledEntryQuantity: accounting.filledEntryQuantity,
    exitedQuantity: accounting.exitedQuantity,
    openQuantity: valuation.openQuantity,
    grossRealizedPnl: accounting.grossRealizedPnl,
    grossUnrealizedPnl: valuation.grossUnrealizedPnl,
    grossTotalPnl,
    accountingAsOf: valuation.accountingAsOf,
    valuationAsOf: valuation.markAsOf,
    positionExposure: accounting.positionExposure,
    realizedAccounting: accounting,
    unrealizedValuation: valuation,
  });
  return Object.freeze({ status: "TRADE_PERFORMANCE_PROJECTED", snapshot });
}

export class TradePerformanceEngine {
  project(
    attempt: AuthoritativePerformanceAttempt,
    accountingSpec: TradePerformanceAccountingSpec,
    valuationMark: TradePerformanceValuationMark,
  ): TradePerformanceProjectionResult {
    return projectTradePerformanceSnapshot(attempt, accountingSpec, valuationMark);
  }
}
