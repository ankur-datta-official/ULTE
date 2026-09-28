import type {
  AuthoritativeValuationAttempt,
  UnrealizedTradeValuation,
  UnrealizedValuationAccountingSpec,
  UnrealizedValuationRejectedResult,
  ValuationMark,
} from "@ulte/trade-valuation-engine";

export const TRADE_PERFORMANCE_SNAPSHOT_SCHEMA_VERSION = "TRADE_PERFORMANCE_SNAPSHOT_V1" as const;

export interface TradePerformanceSnapshot {
  readonly schemaVersion: typeof TRADE_PERFORMANCE_SNAPSHOT_SCHEMA_VERSION;
  readonly executionAttemptId: UnrealizedTradeValuation["executionAttemptId"];
  readonly executionPlanId: UnrealizedTradeValuation["executionPlanId"];
  readonly tradeIntentId: UnrealizedTradeValuation["tradeIntentId"];
  readonly candidateId: UnrealizedTradeValuation["candidateId"];
  readonly instrumentId: UnrealizedTradeValuation["instrumentId"];
  readonly direction: UnrealizedTradeValuation["direction"];
  readonly valuationModel: UnrealizedTradeValuation["valuationModel"];
  readonly pnlCurrency: UnrealizedTradeValuation["pnlCurrency"];
  readonly pnlValuePerPriceUnitPerQuantity: UnrealizedTradeValuation["pnlValuePerPriceUnitPerQuantity"];
  readonly filledEntryQuantity: UnrealizedTradeValuation["realizedAccounting"]["filledEntryQuantity"];
  readonly exitedQuantity: UnrealizedTradeValuation["realizedAccounting"]["exitedQuantity"];
  readonly openQuantity: UnrealizedTradeValuation["openQuantity"];
  readonly grossRealizedPnl: UnrealizedTradeValuation["realizedAccounting"]["grossRealizedPnl"];
  readonly grossUnrealizedPnl: UnrealizedTradeValuation["grossUnrealizedPnl"];
  readonly grossTotalPnl: UnrealizedTradeValuation["grossUnrealizedPnl"];
  readonly accountingAsOf: UnrealizedTradeValuation["accountingAsOf"];
  readonly valuationAsOf: UnrealizedTradeValuation["markAsOf"];
  readonly positionExposure: UnrealizedTradeValuation["realizedAccounting"]["positionExposure"];
  readonly realizedAccounting: UnrealizedTradeValuation["realizedAccounting"];
  readonly unrealizedValuation: UnrealizedTradeValuation;
}

export type TradePerformanceRejectionReason =
  | "UNREALIZED_VALUATION_REJECTED"
  | "PERFORMANCE_AGGREGATION_INCOHERENT";

export interface TradePerformanceProjectedResult {
  readonly status: "TRADE_PERFORMANCE_PROJECTED";
  readonly snapshot: TradePerformanceSnapshot;
}

export interface TradePerformanceRejectedResult {
  readonly status: "TRADE_PERFORMANCE_REJECTED";
  readonly reason: TradePerformanceRejectionReason;
  readonly valuationProjection?: UnrealizedValuationRejectedResult;
}

export type TradePerformanceProjectionResult =
  | TradePerformanceProjectedResult
  | TradePerformanceRejectedResult;

export type AuthoritativePerformanceAttempt = AuthoritativeValuationAttempt;
export type TradePerformanceAccountingSpec = UnrealizedValuationAccountingSpec;
export type TradePerformanceValuationMark = ValuationMark;
