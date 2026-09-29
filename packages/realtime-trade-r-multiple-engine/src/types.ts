import type {
  NetTradePerformanceProjectedRealtimeResult,
  NoNetTradePerformanceProjectionResult,
  RealtimeNetTradePerformanceRejectedResult,
  RealtimeNetTradePerformanceResult,
  RealtimeNetTradePerformanceSourceKind,
  RealtimeSourceKindIncoherentResult,
} from "@ulte/realtime-net-trade-performance-engine";
import type {
  TradeRiskBasis,
  TradeRMultipleProjectedResult,
  TradeRMultipleRejectedResult,
  TradeRMultipleSnapshot,
} from "@ulte/trade-r-multiple-engine";

export interface NoTradeRMultipleProjectionResult {
  readonly status: "NO_TRADE_R_MULTIPLE_PROJECTION";
  readonly sourceKind: NoNetTradePerformanceProjectionResult["sourceKind"];
  readonly grossUpstreamStatus: NoNetTradePerformanceProjectionResult["grossUpstreamStatus"];
  readonly costUpstreamStatus: NoNetTradePerformanceProjectionResult["costUpstreamStatus"];
}

interface RealtimeNetPerformanceRejectedBase {
  readonly status: "TRADE_R_MULTIPLE_REJECTED";
  readonly reason: "REALTIME_NET_PERFORMANCE_REJECTED";
  readonly grossUpstreamStatus: RealtimeNetTradePerformanceRejectedResult["grossUpstreamStatus"];
  readonly costUpstreamStatus: RealtimeNetTradePerformanceRejectedResult["costUpstreamStatus"];
}

export interface RealtimeNetPerformanceRejectedWithoutSourceResult
  extends RealtimeNetPerformanceRejectedBase {
  readonly realtimeNetPerformance: RealtimeSourceKindIncoherentResult;
}

export interface RealtimeNetPerformanceRejectedWithSourceResult
  extends RealtimeNetPerformanceRejectedBase {
  readonly sourceKind: RealtimeNetTradePerformanceSourceKind;
  readonly realtimeNetPerformance: Exclude<
    RealtimeNetTradePerformanceRejectedResult,
    RealtimeSourceKindIncoherentResult
  >;
}

export type RealtimeNetPerformanceRejectedResult =
  | RealtimeNetPerformanceRejectedWithoutSourceResult
  | RealtimeNetPerformanceRejectedWithSourceResult;

export interface AuthoritativeRMultipleRejectedResult {
  readonly status: "TRADE_R_MULTIPLE_REJECTED";
  readonly reason: "AUTHORITATIVE_R_MULTIPLE_REJECTED";
  readonly sourceKind: NetTradePerformanceProjectedRealtimeResult["sourceKind"];
  readonly grossUpstreamStatus: NetTradePerformanceProjectedRealtimeResult["grossUpstreamStatus"];
  readonly costUpstreamStatus: NetTradePerformanceProjectedRealtimeResult["costUpstreamStatus"];
  readonly markPolicy: NetTradePerformanceProjectedRealtimeResult["markPolicy"];
  readonly realtimeNetPerformance: NetTradePerformanceProjectedRealtimeResult;
  readonly rMultipleProjection: TradeRMultipleRejectedResult;
}

export interface TradeRMultipleProjectedRealtimeResult {
  readonly status: "TRADE_R_MULTIPLE_PROJECTED";
  readonly sourceKind: NetTradePerformanceProjectedRealtimeResult["sourceKind"];
  readonly grossUpstreamStatus: NetTradePerformanceProjectedRealtimeResult["grossUpstreamStatus"];
  readonly costUpstreamStatus: NetTradePerformanceProjectedRealtimeResult["costUpstreamStatus"];
  readonly markPolicy: NetTradePerformanceProjectedRealtimeResult["markPolicy"];
  readonly snapshot: TradeRMultipleSnapshot;
  readonly realtimeNetPerformance: NetTradePerformanceProjectedRealtimeResult;
  readonly rMultipleProjection: TradeRMultipleProjectedResult;
}

export type RealtimeTradeRMultipleRejectedResult =
  | RealtimeNetPerformanceRejectedResult
  | AuthoritativeRMultipleRejectedResult;

export type RealtimeTradeRMultipleResult =
  | NoTradeRMultipleProjectionResult
  | TradeRMultipleProjectedRealtimeResult
  | RealtimeTradeRMultipleRejectedResult;

export type AuthoritativeRealtimeNetPerformanceResult = RealtimeNetTradePerformanceResult;
export type AuthoritativeTradeRiskBasis = TradeRiskBasis;
