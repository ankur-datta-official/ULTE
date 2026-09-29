import { subtractDecimal } from "@ulte/exact-decimal";
import {
  projectTradeCostAccounting,
  type TradeCostAccounting,
} from "@ulte/trade-cost-accounting-engine";
import {
  projectTradePerformanceSnapshot,
  type TradePerformanceSnapshot,
} from "@ulte/trade-performance-engine";
import {
  NET_TRADE_PERFORMANCE_SNAPSHOT_SCHEMA_VERSION,
  type NetPerformanceIncoherentResult,
  type NetTradePerformanceAccountingSpec,
  type NetTradePerformanceAttempt,
  type NetTradePerformanceCostEvent,
  type NetTradePerformanceProjectionResult,
  type NetTradePerformanceValuationMark,
} from "./types.js";

function incoherent(): NetPerformanceIncoherentResult {
  return Object.freeze({
    status: "NET_TRADE_PERFORMANCE_REJECTED",
    reason: "NET_PERFORMANCE_INCOHERENT",
  });
}

function positionsAreCoherent(
  gross: TradePerformanceSnapshot["positionExposure"],
  cost: TradeCostAccounting["positionExposure"],
): boolean {
  return gross.executionAttemptId === cost.executionAttemptId
    && gross.executionPlanId === cost.executionPlanId
    && gross.tradeIntentId === cost.tradeIntentId
    && gross.candidateId === cost.candidateId
    && gross.instrumentId === cost.instrumentId
    && gross.direction === cost.direction
    && gross.entrySide === cost.entrySide
    && gross.exitSide === cost.exitSide
    && gross.requestedQuantity === cost.requestedQuantity
    && gross.filledEntryQuantity === cost.filledEntryQuantity
    && gross.exitedQuantity === cost.exitedQuantity
    && gross.openQuantity === cost.openQuantity
    && gross.entryOrderStatus === cost.entryOrderStatus
    && gross.executionState === cost.executionState
    && gross.entryCanIncreaseExposure === cost.entryCanIncreaseExposure
    && gross.exposureState === cost.exposureState
    && gross.executionAsOf === cost.executionAsOf;
}

function authoritiesAreCoherent(
  gross: TradePerformanceSnapshot,
  cost: TradeCostAccounting,
): boolean {
  return gross.executionAttemptId === cost.executionAttemptId
    && gross.executionPlanId === cost.executionPlanId
    && gross.tradeIntentId === cost.tradeIntentId
    && gross.candidateId === cost.candidateId
    && gross.instrumentId === cost.instrumentId
    && gross.pnlCurrency === cost.pnlCurrency
    && gross.realizedAccounting.executionAttemptId === cost.realizedAccounting.executionAttemptId
    && gross.realizedAccounting.instrumentId === cost.realizedAccounting.instrumentId
    && gross.accountingAsOf === cost.executionAccountingAsOf
    && gross.grossRealizedPnl === cost.realizedAccounting.grossRealizedPnl
    && gross.filledEntryQuantity === cost.realizedAccounting.filledEntryQuantity
    && gross.exitedQuantity === cost.realizedAccounting.exitedQuantity
    && gross.openQuantity === cost.realizedAccounting.openQuantity
    && gross.positionExposure === gross.realizedAccounting.positionExposure
    && cost.positionExposure === cost.realizedAccounting.positionExposure
    && positionsAreCoherent(gross.positionExposure, cost.positionExposure);
}

/** Combines complete Task029A and Task030A authorities without rerunning either authority. */
export function projectNetTradePerformanceFromAuthorities(
  grossPerformance: TradePerformanceSnapshot,
  costAccounting: TradeCostAccounting,
): NetTradePerformanceProjectionResult {
  if (!authoritiesAreCoherent(grossPerformance, costAccounting)) return incoherent();

  const snapshot = Object.freeze({
    schemaVersion: NET_TRADE_PERFORMANCE_SNAPSHOT_SCHEMA_VERSION,
    executionAttemptId: grossPerformance.executionAttemptId,
    executionPlanId: grossPerformance.executionPlanId,
    tradeIntentId: grossPerformance.tradeIntentId,
    candidateId: grossPerformance.candidateId,
    instrumentId: grossPerformance.instrumentId,
    direction: grossPerformance.direction,
    valuationModel: grossPerformance.valuationModel,
    pnlCurrency: grossPerformance.pnlCurrency,
    pnlValuePerPriceUnitPerQuantity: grossPerformance.pnlValuePerPriceUnitPerQuantity,
    filledEntryQuantity: grossPerformance.filledEntryQuantity,
    exitedQuantity: grossPerformance.exitedQuantity,
    openQuantity: grossPerformance.openQuantity,
    grossRealizedPnl: grossPerformance.grossRealizedPnl,
    grossUnrealizedPnl: grossPerformance.grossUnrealizedPnl,
    grossTotalPnl: grossPerformance.grossTotalPnl,
    grossDebitCostAmount: costAccounting.grossDebitCostAmount,
    grossCreditCostAmount: costAccounting.grossCreditCostAmount,
    netCostAmount: costAccounting.netCostAmount,
    netTotalPnl: subtractDecimal(grossPerformance.grossTotalPnl, costAccounting.netCostAmount),
    executionAccountingAsOf: costAccounting.executionAccountingAsOf,
    valuationAsOf: grossPerformance.valuationAsOf,
    costAccountingAsOf: costAccounting.costAccountingAsOf,
    positionExposure: grossPerformance.positionExposure,
    grossPerformance,
    costAccounting,
  });
  return Object.freeze({ status: "NET_TRADE_PERFORMANCE_PROJECTED", snapshot });
}

/** Establishes Task029A and Task030A authorities once each, then delegates canonical aggregation. */
export function projectNetTradePerformanceSnapshot(
  executionAttempt: NetTradePerformanceAttempt,
  accountingSpec: NetTradePerformanceAccountingSpec,
  valuationMark: NetTradePerformanceValuationMark,
  costEvents: readonly NetTradePerformanceCostEvent[],
): NetTradePerformanceProjectionResult {
  const grossPerformanceProjection = projectTradePerformanceSnapshot(
    executionAttempt,
    accountingSpec,
    valuationMark,
  );
  if (grossPerformanceProjection.status === "TRADE_PERFORMANCE_REJECTED") {
    return Object.freeze({
      status: "NET_TRADE_PERFORMANCE_REJECTED",
      reason: "GROSS_PERFORMANCE_REJECTED",
      grossPerformanceProjection,
    });
  }

  const costAccountingProjection = projectTradeCostAccounting(
    executionAttempt,
    accountingSpec,
    costEvents,
  );
  if (costAccountingProjection.status === "TRADE_COST_ACCOUNTING_REJECTED") {
    return Object.freeze({
      status: "NET_TRADE_PERFORMANCE_REJECTED",
      reason: "COST_ACCOUNTING_REJECTED",
      costAccountingProjection,
    });
  }

  return projectNetTradePerformanceFromAuthorities(
    grossPerformanceProjection.snapshot,
    costAccountingProjection.accounting,
  );
}

export class NetTradePerformanceEngine {
  project(
    executionAttempt: NetTradePerformanceAttempt,
    accountingSpec: NetTradePerformanceAccountingSpec,
    valuationMark: NetTradePerformanceValuationMark,
    costEvents: readonly NetTradePerformanceCostEvent[],
  ): NetTradePerformanceProjectionResult {
    return projectNetTradePerformanceSnapshot(executionAttempt, accountingSpec, valuationMark, costEvents);
  }
}
