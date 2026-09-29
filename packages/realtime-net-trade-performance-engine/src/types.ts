import type {
  NetTradePerformanceProjectedResult,
  NetTradePerformanceRejectedResult,
  NetTradePerformanceSnapshot,
} from "@ulte/net-trade-performance-engine";
import type {
  RealtimeTradeCostAccountingResult,
  RealtimeTradeCostAccountingProjectedResult,
  RealtimeTradeCostAccountingUpstreamStatus,
} from "@ulte/realtime-trade-cost-accounting-engine";
import type {
  RealtimeTradePerformanceResult,
  TradePerformanceProjectedRealtimeResult,
} from "@ulte/realtime-trade-performance-engine";

export type RealtimeNetTradePerformanceSourceKind =
  RealtimeTradePerformanceResult["sourceKind"];

export interface NoNetTradePerformanceProjectionResult {
  readonly status: "NO_NET_TRADE_PERFORMANCE_PROJECTION";
  readonly sourceKind: RealtimeNetTradePerformanceSourceKind;
  readonly grossUpstreamStatus: RealtimeTradePerformanceResult["upstreamStatus"];
  readonly costUpstreamStatus: RealtimeTradeCostAccountingUpstreamStatus;
}

export interface NetTradePerformanceProjectedRealtimeResult {
  readonly status: "NET_TRADE_PERFORMANCE_PROJECTED";
  readonly sourceKind: RealtimeNetTradePerformanceSourceKind;
  readonly grossUpstreamStatus: RealtimeTradePerformanceResult["upstreamStatus"];
  readonly costUpstreamStatus: RealtimeTradeCostAccountingUpstreamStatus;
  readonly markPolicy: TradePerformanceProjectedRealtimeResult["markPolicy"];
  readonly snapshot: NetTradePerformanceSnapshot;
  readonly grossPerformanceResult: TradePerformanceProjectedRealtimeResult;
  readonly costAccountingResult: RealtimeTradeCostAccountingProjectedResult;
  readonly netPerformanceProjection: NetTradePerformanceProjectedResult;
}

export type RealtimeNetTradePerformanceRejectionReason =
  | "REALTIME_SOURCE_KIND_INCOHERENT"
  | "REALTIME_PROJECTION_STATE_INCOHERENT"
  | "REALTIME_GROSS_PERFORMANCE_REJECTED"
  | "REALTIME_COST_ACCOUNTING_REJECTED"
  | "AUTHORITATIVE_NET_PERFORMANCE_REJECTED";

interface RealtimeNetTradePerformanceRejectedBase {
  readonly status: "NET_TRADE_PERFORMANCE_REJECTED";
  readonly grossUpstreamStatus: RealtimeTradePerformanceResult["upstreamStatus"];
  readonly costUpstreamStatus: RealtimeTradeCostAccountingUpstreamStatus;
  readonly grossPerformanceResult: RealtimeTradePerformanceResult;
  readonly costAccountingResult: RealtimeTradeCostAccountingResult;
}

export interface RealtimeSourceKindIncoherentResult
  extends RealtimeNetTradePerformanceRejectedBase {
  readonly reason: "REALTIME_SOURCE_KIND_INCOHERENT";
}

export interface RealtimeProjectionStateIncoherentResult
  extends RealtimeNetTradePerformanceRejectedBase {
  readonly reason: "REALTIME_PROJECTION_STATE_INCOHERENT";
  readonly sourceKind: RealtimeNetTradePerformanceSourceKind;
}

export interface RealtimeGrossPerformanceRejectedResult
  extends RealtimeNetTradePerformanceRejectedBase {
  readonly reason: "REALTIME_GROSS_PERFORMANCE_REJECTED";
  readonly sourceKind: RealtimeNetTradePerformanceSourceKind;
}

export interface RealtimeCostAccountingRejectedResult
  extends RealtimeNetTradePerformanceRejectedBase {
  readonly reason: "REALTIME_COST_ACCOUNTING_REJECTED";
  readonly sourceKind: RealtimeNetTradePerformanceSourceKind;
}

export interface AuthoritativeNetPerformanceRejectedResult
  extends RealtimeNetTradePerformanceRejectedBase {
  readonly reason: "AUTHORITATIVE_NET_PERFORMANCE_REJECTED";
  readonly sourceKind: RealtimeNetTradePerformanceSourceKind;
  readonly netPerformanceProjection: NetTradePerformanceRejectedResult;
}

export type RealtimeNetTradePerformanceRejectedResult =
  | RealtimeSourceKindIncoherentResult
  | RealtimeProjectionStateIncoherentResult
  | RealtimeGrossPerformanceRejectedResult
  | RealtimeCostAccountingRejectedResult
  | AuthoritativeNetPerformanceRejectedResult;

export type RealtimeNetTradePerformanceResult =
  | NoNetTradePerformanceProjectionResult
  | NetTradePerformanceProjectedRealtimeResult
  | RealtimeNetTradePerformanceRejectedResult;

export type AuthoritativeRealtimeGrossPerformanceResult = RealtimeTradePerformanceResult;
export type AuthoritativeRealtimeCostAccountingResult = RealtimeTradeCostAccountingResult;
