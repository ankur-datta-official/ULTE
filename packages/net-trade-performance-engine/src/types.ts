import type {
  TradeCostAccounting,
  TradeCostAccountingRejectedResult,
  TradeCostEvent,
} from "@ulte/trade-cost-accounting-engine";
import type {
  AuthoritativePerformanceAttempt,
  TradePerformanceAccountingSpec,
  TradePerformanceRejectedResult,
  TradePerformanceSnapshot,
  TradePerformanceValuationMark,
} from "@ulte/trade-performance-engine";

export const NET_TRADE_PERFORMANCE_SNAPSHOT_SCHEMA_VERSION =
  "NET_TRADE_PERFORMANCE_SNAPSHOT_V1" as const;

export interface NetTradePerformanceSnapshot {
  readonly schemaVersion: typeof NET_TRADE_PERFORMANCE_SNAPSHOT_SCHEMA_VERSION;
  readonly executionAttemptId: TradePerformanceSnapshot["executionAttemptId"];
  readonly executionPlanId: TradePerformanceSnapshot["executionPlanId"];
  readonly tradeIntentId: TradePerformanceSnapshot["tradeIntentId"];
  readonly candidateId: TradePerformanceSnapshot["candidateId"];
  readonly instrumentId: TradePerformanceSnapshot["instrumentId"];
  readonly direction: TradePerformanceSnapshot["direction"];
  readonly valuationModel: TradePerformanceSnapshot["valuationModel"];
  readonly pnlCurrency: TradePerformanceSnapshot["pnlCurrency"];
  readonly pnlValuePerPriceUnitPerQuantity: TradePerformanceSnapshot["pnlValuePerPriceUnitPerQuantity"];
  readonly filledEntryQuantity: TradePerformanceSnapshot["filledEntryQuantity"];
  readonly exitedQuantity: TradePerformanceSnapshot["exitedQuantity"];
  readonly openQuantity: TradePerformanceSnapshot["openQuantity"];
  readonly grossRealizedPnl: TradePerformanceSnapshot["grossRealizedPnl"];
  readonly grossUnrealizedPnl: TradePerformanceSnapshot["grossUnrealizedPnl"];
  readonly grossTotalPnl: TradePerformanceSnapshot["grossTotalPnl"];
  readonly grossDebitCostAmount: TradeCostAccounting["grossDebitCostAmount"];
  readonly grossCreditCostAmount: TradeCostAccounting["grossCreditCostAmount"];
  readonly netCostAmount: TradeCostAccounting["netCostAmount"];
  readonly netTotalPnl: TradePerformanceSnapshot["grossTotalPnl"];
  readonly executionAccountingAsOf: TradeCostAccounting["executionAccountingAsOf"];
  readonly valuationAsOf: TradePerformanceSnapshot["valuationAsOf"];
  readonly costAccountingAsOf: TradeCostAccounting["costAccountingAsOf"];
  readonly positionExposure: TradePerformanceSnapshot["positionExposure"];
  readonly grossPerformance: TradePerformanceSnapshot;
  readonly costAccounting: TradeCostAccounting;
}

export interface NetTradePerformanceProjectedResult {
  readonly status: "NET_TRADE_PERFORMANCE_PROJECTED";
  readonly snapshot: NetTradePerformanceSnapshot;
}

export interface GrossPerformanceRejectedResult {
  readonly status: "NET_TRADE_PERFORMANCE_REJECTED";
  readonly reason: "GROSS_PERFORMANCE_REJECTED";
  readonly grossPerformanceProjection: TradePerformanceRejectedResult;
}

export interface CostAccountingRejectedResult {
  readonly status: "NET_TRADE_PERFORMANCE_REJECTED";
  readonly reason: "COST_ACCOUNTING_REJECTED";
  readonly costAccountingProjection: TradeCostAccountingRejectedResult;
}

export interface NetPerformanceIncoherentResult {
  readonly status: "NET_TRADE_PERFORMANCE_REJECTED";
  readonly reason: "NET_PERFORMANCE_INCOHERENT";
}

export type NetTradePerformanceRejectedResult =
  | GrossPerformanceRejectedResult
  | CostAccountingRejectedResult
  | NetPerformanceIncoherentResult;

export type NetTradePerformanceProjectionResult =
  | NetTradePerformanceProjectedResult
  | NetTradePerformanceRejectedResult;

export type NetTradePerformanceAttempt = AuthoritativePerformanceAttempt;
export type NetTradePerformanceAccountingSpec = TradePerformanceAccountingSpec;
export type NetTradePerformanceValuationMark = TradePerformanceValuationMark;
export type NetTradePerformanceCostEvent = TradeCostEvent;
