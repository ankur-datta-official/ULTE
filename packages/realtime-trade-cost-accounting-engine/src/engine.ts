import {
  projectTradeCostAccounting,
  type AuthoritativeCostAccountingAttempt,
} from "@ulte/trade-cost-accounting-engine";
import { normalizeCostEventDeliveries } from "./delivery-normalization.js";
import type {
  RealtimeTradeCostAccountingInput,
  RealtimeTradeCostAccountingResult,
  RealtimeTradeCostAccountingSourceKind,
  RealtimeTradeCostAccountingUpstreamStatus,
} from "./types.js";

function noProjection(
  sourceKind: RealtimeTradeCostAccountingSourceKind,
  upstreamStatus: RealtimeTradeCostAccountingUpstreamStatus,
): RealtimeTradeCostAccountingResult {
  return Object.freeze({ status: "NO_COST_ACCOUNTING_PROJECTION", sourceKind, upstreamStatus });
}

function projectActionable(
  input: RealtimeTradeCostAccountingInput,
  upstreamStatus: RealtimeTradeCostAccountingUpstreamStatus,
  executionAttempt: AuthoritativeCostAccountingAttempt,
): RealtimeTradeCostAccountingResult {
  const normalized = normalizeCostEventDeliveries(input.observedCostEvents);
  if (normalized.status === "INVALID") {
    return Object.freeze({
      status: "TRADE_COST_ACCOUNTING_REJECTED",
      sourceKind: input.sourceKind,
      upstreamStatus,
      reason: "COST_EVENT_DELIVERY_INVALID",
    });
  }
  if (normalized.status === "CONFLICTING_DUPLICATE") {
    return Object.freeze({
      status: "TRADE_COST_ACCOUNTING_REJECTED",
      sourceKind: input.sourceKind,
      upstreamStatus,
      reason: "CONFLICTING_DUPLICATE_COST_EVENT_ID",
    });
  }

  const costAccountingProjection = projectTradeCostAccounting(
    executionAttempt,
    input.accountingSpec,
    normalized.uniqueCostEvents,
  );
  if (costAccountingProjection.status === "TRADE_COST_ACCOUNTING_REJECTED") {
    return Object.freeze({
      status: "TRADE_COST_ACCOUNTING_REJECTED",
      sourceKind: input.sourceKind,
      upstreamStatus,
      reason: "AUTHORITATIVE_COST_ACCOUNTING_REJECTED",
      costAccountingProjection,
    });
  }

  return Object.freeze({
    status: "TRADE_COST_ACCOUNTING_PROJECTED",
    sourceKind: input.sourceKind,
    upstreamStatus,
    observedDeliveryCount: normalized.observedDeliveryCount,
    uniqueCostEventCount: normalized.uniqueCostEvents.length,
    duplicateDeliveryCount: normalized.duplicateDeliveryCount,
    accounting: costAccountingProjection.accounting,
  });
}

/** Projects already-observed cost deliveries from an actionable authoritative realtime lifecycle. */
export function projectRealtimeTradeCostAccounting(
  input: RealtimeTradeCostAccountingInput,
): RealtimeTradeCostAccountingResult {
  if (input.sourceKind === "ENTRY_FILL") {
    const upstream = input.fillLifecycle;
    if (upstream.status !== "FILL_APPLIED" && upstream.status !== "DUPLICATE_FILL") {
      return noProjection(input.sourceKind, upstream.status);
    }
    return projectActionable(input, upstream.status, upstream.executionAttempt);
  }

  const upstream = input.exitFillLifecycle;
  if (upstream.status !== "EXIT_FILL_APPLIED" && upstream.status !== "DUPLICATE_EXIT_FILL") {
    return noProjection(input.sourceKind, upstream.status);
  }
  return projectActionable(input, upstream.status, upstream.executionAttempt);
}

export class RealtimeTradeCostAccountingEngine {
  project(input: RealtimeTradeCostAccountingInput): RealtimeTradeCostAccountingResult {
    return projectRealtimeTradeCostAccounting(input);
  }
}
