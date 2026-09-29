import { projectNetTradePerformanceFromAuthorities } from "@ulte/net-trade-performance-engine";
import type { RealtimeTradeCostAccountingResult } from "@ulte/realtime-trade-cost-accounting-engine";
import type { RealtimeTradePerformanceResult } from "@ulte/realtime-trade-performance-engine";
import type { RealtimeNetTradePerformanceResult } from "./types.js";

/** Composes already-authoritative Task029B and Task030B results without rerunning either upstream. */
export function projectRealtimeNetTradePerformance(
  grossPerformanceResult: RealtimeTradePerformanceResult,
  costAccountingResult: RealtimeTradeCostAccountingResult,
): RealtimeNetTradePerformanceResult {
  const grossUpstreamStatus = grossPerformanceResult.upstreamStatus;
  const costUpstreamStatus = costAccountingResult.upstreamStatus;

  if (grossPerformanceResult.sourceKind !== costAccountingResult.sourceKind) {
    return Object.freeze({
      status: "NET_TRADE_PERFORMANCE_REJECTED",
      reason: "REALTIME_SOURCE_KIND_INCOHERENT",
      grossUpstreamStatus,
      costUpstreamStatus,
      grossPerformanceResult,
      costAccountingResult,
    });
  }

  const sourceKind = grossPerformanceResult.sourceKind;
  const grossHasNoProjection = grossPerformanceResult.status === "NO_PERFORMANCE_PROJECTION";
  const costHasNoProjection = costAccountingResult.status === "NO_COST_ACCOUNTING_PROJECTION";

  if (grossHasNoProjection && costHasNoProjection && grossUpstreamStatus === costUpstreamStatus) {
    return Object.freeze({
      status: "NO_NET_TRADE_PERFORMANCE_PROJECTION",
      sourceKind,
      grossUpstreamStatus,
      costUpstreamStatus,
    });
  }

  if (grossHasNoProjection || costHasNoProjection) {
    return Object.freeze({
      status: "NET_TRADE_PERFORMANCE_REJECTED",
      reason: "REALTIME_PROJECTION_STATE_INCOHERENT",
      sourceKind,
      grossUpstreamStatus,
      costUpstreamStatus,
      grossPerformanceResult,
      costAccountingResult,
    });
  }

  if (grossPerformanceResult.status === "TRADE_PERFORMANCE_REJECTED") {
    return Object.freeze({
      status: "NET_TRADE_PERFORMANCE_REJECTED",
      reason: "REALTIME_GROSS_PERFORMANCE_REJECTED",
      sourceKind,
      grossUpstreamStatus,
      costUpstreamStatus,
      grossPerformanceResult,
      costAccountingResult,
    });
  }

  if (costAccountingResult.status === "TRADE_COST_ACCOUNTING_REJECTED") {
    return Object.freeze({
      status: "NET_TRADE_PERFORMANCE_REJECTED",
      reason: "REALTIME_COST_ACCOUNTING_REJECTED",
      sourceKind,
      grossUpstreamStatus,
      costUpstreamStatus,
      grossPerformanceResult,
      costAccountingResult,
    });
  }

  const netPerformanceProjection = projectNetTradePerformanceFromAuthorities(
    grossPerformanceResult.snapshot,
    costAccountingResult.accounting,
  );
  if (netPerformanceProjection.status === "NET_TRADE_PERFORMANCE_REJECTED") {
    return Object.freeze({
      status: "NET_TRADE_PERFORMANCE_REJECTED",
      reason: "AUTHORITATIVE_NET_PERFORMANCE_REJECTED",
      sourceKind,
      grossUpstreamStatus,
      costUpstreamStatus,
      grossPerformanceResult,
      costAccountingResult,
      netPerformanceProjection,
    });
  }

  return Object.freeze({
    status: "NET_TRADE_PERFORMANCE_PROJECTED",
    sourceKind,
    grossUpstreamStatus,
    costUpstreamStatus,
    markPolicy: grossPerformanceResult.markPolicy,
    snapshot: netPerformanceProjection.snapshot,
    grossPerformanceResult,
    costAccountingResult,
    netPerformanceProjection,
  });
}

export class RealtimeNetTradePerformanceEngine {
  project(
    grossPerformanceResult: RealtimeTradePerformanceResult,
    costAccountingResult: RealtimeTradeCostAccountingResult,
  ): RealtimeNetTradePerformanceResult {
    return projectRealtimeNetTradePerformance(grossPerformanceResult, costAccountingResult);
  }
}
