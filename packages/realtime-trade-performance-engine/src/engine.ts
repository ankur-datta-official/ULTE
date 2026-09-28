import type { RealtimeTradeValuationResult } from "@ulte/realtime-trade-valuation-engine";
import { projectTradePerformanceFromValuation } from "@ulte/trade-performance-engine";
import type { RealtimeTradePerformanceResult } from "./types.js";

/** Projects performance from one already-authoritative Task028B result. */
export function projectRealtimeTradePerformance(
  realtimeValuation: RealtimeTradeValuationResult,
): RealtimeTradePerformanceResult {
  if (realtimeValuation.status === "NO_VALUATION_PROJECTION") {
    return Object.freeze({
      status: "NO_PERFORMANCE_PROJECTION",
      sourceKind: realtimeValuation.sourceKind,
      upstreamStatus: realtimeValuation.upstreamStatus,
    });
  }

  if (realtimeValuation.status === "UNREALIZED_VALUATION_REJECTED") {
    return Object.freeze({
      status: "TRADE_PERFORMANCE_REJECTED",
      sourceKind: realtimeValuation.sourceKind,
      upstreamStatus: realtimeValuation.upstreamStatus,
      markPolicy: realtimeValuation.markPolicy,
      reason: "REALTIME_VALUATION_REJECTED",
      realtimeValuation,
    });
  }

  const performanceProjection = projectTradePerformanceFromValuation(realtimeValuation.valuation);
  if (performanceProjection.status === "TRADE_PERFORMANCE_REJECTED") {
    return Object.freeze({
      status: "TRADE_PERFORMANCE_REJECTED",
      sourceKind: realtimeValuation.sourceKind,
      upstreamStatus: realtimeValuation.upstreamStatus,
      markPolicy: realtimeValuation.markPolicy,
      reason: "TRADE_PERFORMANCE_AGGREGATION_REJECTED",
      realtimeValuation,
      performanceProjection,
    });
  }

  return Object.freeze({
    status: "TRADE_PERFORMANCE_PROJECTED",
    sourceKind: realtimeValuation.sourceKind,
    upstreamStatus: realtimeValuation.upstreamStatus,
    markPolicy: realtimeValuation.markPolicy,
    snapshot: performanceProjection.snapshot,
    realtimeValuation,
  });
}

export class RealtimeTradePerformanceEngine {
  project(realtimeValuation: RealtimeTradeValuationResult): RealtimeTradePerformanceResult {
    return projectRealtimeTradePerformance(realtimeValuation);
  }
}
