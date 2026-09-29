import type { RealtimeNetTradePerformanceResult } from "@ulte/realtime-net-trade-performance-engine";
import {
  projectTradeRMultipleFromAuthorities,
  type TradeRiskBasis,
} from "@ulte/trade-r-multiple-engine";
import type { RealtimeTradeRMultipleResult } from "./types.js";

/** Projects net R from complete Task031B and Task032A authorities without recreating either. */
export function projectRealtimeTradeRMultiple(
  realtimeNetPerformance: RealtimeNetTradePerformanceResult,
  riskBasis: TradeRiskBasis,
): RealtimeTradeRMultipleResult {
  if (realtimeNetPerformance.status === "NO_NET_TRADE_PERFORMANCE_PROJECTION") {
    return Object.freeze({
      status: "NO_TRADE_R_MULTIPLE_PROJECTION",
      sourceKind: realtimeNetPerformance.sourceKind,
      grossUpstreamStatus: realtimeNetPerformance.grossUpstreamStatus,
      costUpstreamStatus: realtimeNetPerformance.costUpstreamStatus,
    });
  }

  if (realtimeNetPerformance.status === "NET_TRADE_PERFORMANCE_REJECTED") {
    if (realtimeNetPerformance.reason === "REALTIME_SOURCE_KIND_INCOHERENT") {
      return Object.freeze({
        status: "TRADE_R_MULTIPLE_REJECTED",
        reason: "REALTIME_NET_PERFORMANCE_REJECTED",
        grossUpstreamStatus: realtimeNetPerformance.grossUpstreamStatus,
        costUpstreamStatus: realtimeNetPerformance.costUpstreamStatus,
        realtimeNetPerformance,
      });
    }
    return Object.freeze({
      status: "TRADE_R_MULTIPLE_REJECTED",
      reason: "REALTIME_NET_PERFORMANCE_REJECTED",
      sourceKind: realtimeNetPerformance.sourceKind,
      grossUpstreamStatus: realtimeNetPerformance.grossUpstreamStatus,
      costUpstreamStatus: realtimeNetPerformance.costUpstreamStatus,
      realtimeNetPerformance,
    });
  }

  const rMultipleProjection = projectTradeRMultipleFromAuthorities(
    realtimeNetPerformance.snapshot,
    riskBasis,
  );
  if (rMultipleProjection.status === "TRADE_R_MULTIPLE_REJECTED") {
    return Object.freeze({
      status: "TRADE_R_MULTIPLE_REJECTED",
      reason: "AUTHORITATIVE_R_MULTIPLE_REJECTED",
      sourceKind: realtimeNetPerformance.sourceKind,
      grossUpstreamStatus: realtimeNetPerformance.grossUpstreamStatus,
      costUpstreamStatus: realtimeNetPerformance.costUpstreamStatus,
      markPolicy: realtimeNetPerformance.markPolicy,
      realtimeNetPerformance,
      rMultipleProjection,
    });
  }
  return Object.freeze({
    status: "TRADE_R_MULTIPLE_PROJECTED",
    sourceKind: realtimeNetPerformance.sourceKind,
    grossUpstreamStatus: realtimeNetPerformance.grossUpstreamStatus,
    costUpstreamStatus: realtimeNetPerformance.costUpstreamStatus,
    markPolicy: realtimeNetPerformance.markPolicy,
    snapshot: rMultipleProjection.snapshot,
    realtimeNetPerformance,
    rMultipleProjection,
  });
}

export class RealtimeTradeRMultipleEngine {
  project(
    realtimeNetPerformance: RealtimeNetTradePerformanceResult,
    riskBasis: TradeRiskBasis,
  ): RealtimeTradeRMultipleResult {
    return projectRealtimeTradeRMultiple(realtimeNetPerformance, riskBasis);
  }
}
