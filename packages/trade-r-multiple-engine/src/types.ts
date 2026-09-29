import type { ExecutionAttempt } from "@ulte/execution-engine";
import type {
  CurrencyCode,
  DecimalString,
  InstrumentId,
  PositiveDecimalString,
  UnixMs,
} from "@ulte/instrument-model";
import type { NetTradePerformanceSnapshot } from "@ulte/net-trade-performance-engine";

export const TRADE_RISK_BASIS_SCHEMA_VERSION = "TRADE_RISK_BASIS_V1" as const;
export const TRADE_R_MULTIPLE_SNAPSHOT_SCHEMA_VERSION = "TRADE_R_MULTIPLE_SNAPSHOT_V1" as const;
export const TRADE_RISK_BASIS_METHOD = "EXECUTION_ACTUAL_RISK_V1" as const;

export interface TradeRiskBasis {
  readonly schemaVersion: typeof TRADE_RISK_BASIS_SCHEMA_VERSION;
  readonly executionAttemptId: string;
  readonly executionPlanId: string;
  readonly tradeIntentId: string;
  readonly candidateId: string;
  readonly instrumentId: InstrumentId;
  readonly riskBasisMethod: typeof TRADE_RISK_BASIS_METHOD;
  readonly initialActualRiskAmount: PositiveDecimalString;
  readonly accountCurrency: CurrencyCode;
  readonly riskBasisAsOf: UnixMs;
}

export interface TradeRiskBasisCreatedResult {
  readonly status: "TRADE_RISK_BASIS_CREATED";
  readonly riskBasis: TradeRiskBasis;
}

export interface TradeRiskBasisRejectedResult {
  readonly status: "TRADE_RISK_BASIS_REJECTED";
  readonly reason: "INVALID_EXECUTION_RISK_BASIS";
}

export type TradeRiskBasisCreationResult =
  | TradeRiskBasisCreatedResult
  | TradeRiskBasisRejectedResult;

export interface ExactTradeRMultipleRatio {
  readonly numerator: DecimalString;
  readonly denominator: PositiveDecimalString;
}

export interface TradeRMultipleSnapshot {
  readonly schemaVersion: typeof TRADE_R_MULTIPLE_SNAPSHOT_SCHEMA_VERSION;
  readonly executionAttemptId: NetTradePerformanceSnapshot["executionAttemptId"];
  readonly executionPlanId: NetTradePerformanceSnapshot["executionPlanId"];
  readonly tradeIntentId: NetTradePerformanceSnapshot["tradeIntentId"];
  readonly candidateId: NetTradePerformanceSnapshot["candidateId"];
  readonly instrumentId: NetTradePerformanceSnapshot["instrumentId"];
  readonly direction: NetTradePerformanceSnapshot["direction"];
  readonly pnlCurrency: NetTradePerformanceSnapshot["pnlCurrency"];
  readonly accountCurrency: TradeRiskBasis["accountCurrency"];
  readonly riskBasisMethod: TradeRiskBasis["riskBasisMethod"];
  readonly initialActualRiskAmount: TradeRiskBasis["initialActualRiskAmount"];
  readonly riskBasisAsOf: TradeRiskBasis["riskBasisAsOf"];
  readonly netTotalPnl: NetTradePerformanceSnapshot["netTotalPnl"];
  readonly netRMultipleRatio: ExactTradeRMultipleRatio;
  readonly executionAccountingAsOf: NetTradePerformanceSnapshot["executionAccountingAsOf"];
  readonly valuationAsOf: NetTradePerformanceSnapshot["valuationAsOf"];
  readonly costAccountingAsOf: NetTradePerformanceSnapshot["costAccountingAsOf"];
  readonly positionExposure: NetTradePerformanceSnapshot["positionExposure"];
  readonly netPerformance: NetTradePerformanceSnapshot;
  readonly riskBasis: TradeRiskBasis;
}

export interface TradeRMultipleProjectedResult {
  readonly status: "TRADE_R_MULTIPLE_PROJECTED";
  readonly snapshot: TradeRMultipleSnapshot;
}

export interface TradeRMultipleInvalidRiskBasisResult {
  readonly status: "TRADE_R_MULTIPLE_REJECTED";
  readonly reason: "RISK_BASIS_INVALID";
}

export interface TradeRMultipleAuthorityIncoherentResult {
  readonly status: "TRADE_R_MULTIPLE_REJECTED";
  readonly reason: "R_MULTIPLE_AUTHORITY_INCOHERENT";
}

export interface TradeRMultipleCurrencyMismatchResult {
  readonly status: "TRADE_R_MULTIPLE_REJECTED";
  readonly reason: "R_MULTIPLE_CURRENCY_MISMATCH";
}

export interface TradeRMultipleRiskBasisRejectedResult {
  readonly status: "TRADE_R_MULTIPLE_REJECTED";
  readonly reason: "RISK_BASIS_REJECTED";
  readonly riskBasisCreation: TradeRiskBasisRejectedResult;
}

export type TradeRMultipleRejectedResult =
  | TradeRMultipleInvalidRiskBasisResult
  | TradeRMultipleAuthorityIncoherentResult
  | TradeRMultipleCurrencyMismatchResult
  | TradeRMultipleRiskBasisRejectedResult;

export type TradeRMultipleProjectionResult =
  | TradeRMultipleProjectedResult
  | TradeRMultipleRejectedResult;

export type TradeRMultipleExecutionAttempt = ExecutionAttempt;
