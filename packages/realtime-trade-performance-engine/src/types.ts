import type {
  NoValuationProjectionResult,
  RealtimeTradeValuationResult,
  UnrealizedValuationProjectedRealtimeResult,
  UnrealizedValuationRejectedRealtimeResult,
} from "@ulte/realtime-trade-valuation-engine";
import type {
  TradePerformanceRejectedResult,
  TradePerformanceSnapshot,
} from "@ulte/trade-performance-engine";

export interface NoPerformanceProjectionResult {
  readonly status: "NO_PERFORMANCE_PROJECTION";
  readonly sourceKind: NoValuationProjectionResult["sourceKind"];
  readonly upstreamStatus: NoValuationProjectionResult["upstreamStatus"];
}

export interface TradePerformanceProjectedRealtimeResult {
  readonly status: "TRADE_PERFORMANCE_PROJECTED";
  readonly sourceKind: UnrealizedValuationProjectedRealtimeResult["sourceKind"];
  readonly upstreamStatus: UnrealizedValuationProjectedRealtimeResult["upstreamStatus"];
  readonly markPolicy: UnrealizedValuationProjectedRealtimeResult["markPolicy"];
  readonly snapshot: TradePerformanceSnapshot;
  readonly realtimeValuation: UnrealizedValuationProjectedRealtimeResult;
}

export interface RealtimeValuationRejectedPerformanceResult {
  readonly status: "TRADE_PERFORMANCE_REJECTED";
  readonly sourceKind: UnrealizedValuationRejectedRealtimeResult["sourceKind"];
  readonly upstreamStatus: UnrealizedValuationRejectedRealtimeResult["upstreamStatus"];
  readonly markPolicy: UnrealizedValuationRejectedRealtimeResult["markPolicy"];
  readonly reason: "REALTIME_VALUATION_REJECTED";
  readonly realtimeValuation: UnrealizedValuationRejectedRealtimeResult;
}

export interface PerformanceAggregationRejectedRealtimeResult {
  readonly status: "TRADE_PERFORMANCE_REJECTED";
  readonly sourceKind: UnrealizedValuationProjectedRealtimeResult["sourceKind"];
  readonly upstreamStatus: UnrealizedValuationProjectedRealtimeResult["upstreamStatus"];
  readonly markPolicy: UnrealizedValuationProjectedRealtimeResult["markPolicy"];
  readonly reason: "TRADE_PERFORMANCE_AGGREGATION_REJECTED";
  readonly realtimeValuation: UnrealizedValuationProjectedRealtimeResult;
  readonly performanceProjection: TradePerformanceRejectedResult;
}

export type TradePerformanceRejectedRealtimeResult =
  | RealtimeValuationRejectedPerformanceResult
  | PerformanceAggregationRejectedRealtimeResult;

export type RealtimeTradePerformanceResult =
  | NoPerformanceProjectionResult
  | TradePerformanceProjectedRealtimeResult
  | TradePerformanceRejectedRealtimeResult;

export type AuthoritativeRealtimeValuationResult = RealtimeTradeValuationResult;
