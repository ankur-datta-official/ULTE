import {
  projectUnrealizedTradeValuation,
  type AuthoritativeValuationAttempt,
  type UnrealizedTradeValuationResult,
} from "@ulte/trade-valuation-engine";
import { resolveLastTradeValuationMark } from "./mark-resolution.js";
import {
  REALTIME_VALUATION_MARK_POLICY_V1,
  type RealtimeTradeValuationInput,
  type RealtimeTradeValuationResult,
  type RealtimeTradeValuationSourceKind,
  type RealtimeTradeValuationUpstreamStatus,
} from "./types.js";

function noProjection(
  sourceKind: RealtimeTradeValuationSourceKind,
  upstreamStatus: RealtimeTradeValuationUpstreamStatus,
): RealtimeTradeValuationResult {
  return Object.freeze({ status: "NO_VALUATION_PROJECTION", sourceKind, upstreamStatus });
}

function projectActionable(
  sourceKind: RealtimeTradeValuationSourceKind,
  upstreamStatus: RealtimeTradeValuationUpstreamStatus,
  attempt: AuthoritativeValuationAttempt,
  input: RealtimeTradeValuationInput,
): RealtimeTradeValuationResult {
  const mark = resolveLastTradeValuationMark(input.markSource);
  if (mark === undefined) {
    return Object.freeze({
      status: "UNREALIZED_VALUATION_REJECTED",
      sourceKind,
      upstreamStatus,
      markPolicy: REALTIME_VALUATION_MARK_POLICY_V1,
      reason: "MARK_SOURCE_INVALID",
    });
  }
  return wrapProjection(
    sourceKind,
    upstreamStatus,
    projectUnrealizedTradeValuation(attempt, input.accountingSpec, mark),
  );
}

function wrapProjection(
  sourceKind: RealtimeTradeValuationSourceKind,
  upstreamStatus: RealtimeTradeValuationUpstreamStatus,
  valuationProjection: UnrealizedTradeValuationResult,
): RealtimeTradeValuationResult {
  if (valuationProjection.status === "UNREALIZED_VALUATION_REJECTED") {
    return Object.freeze({
      status: "UNREALIZED_VALUATION_REJECTED",
      sourceKind,
      upstreamStatus,
      markPolicy: REALTIME_VALUATION_MARK_POLICY_V1,
      reason: valuationProjection.reason,
      valuationProjection,
    });
  }
  return Object.freeze({
    status: "UNREALIZED_VALUATION_PROJECTED",
    sourceKind,
    upstreamStatus,
    markPolicy: REALTIME_VALUATION_MARK_POLICY_V1,
    valuation: valuationProjection.valuation,
  });
}

/** Projects valuation only from an actionable lifecycle's embedded authoritative attempt. */
export function projectRealtimeTradeValuation(
  input: RealtimeTradeValuationInput,
): RealtimeTradeValuationResult {
  if (input.sourceKind === "ENTRY_FILL") {
    const upstream = input.fillLifecycle;
    if (upstream.status !== "FILL_APPLIED" && upstream.status !== "DUPLICATE_FILL") {
      return noProjection(input.sourceKind, upstream.status);
    }
    return projectActionable(input.sourceKind, upstream.status, upstream.executionAttempt, input);
  }

  const upstream = input.exitFillLifecycle;
  if (upstream.status !== "EXIT_FILL_APPLIED" && upstream.status !== "DUPLICATE_EXIT_FILL") {
    return noProjection(input.sourceKind, upstream.status);
  }
  return projectActionable(input.sourceKind, upstream.status, upstream.executionAttempt, input);
}

export class RealtimeTradeValuationEngine {
  project(input: RealtimeTradeValuationInput): RealtimeTradeValuationResult {
    return projectRealtimeTradeValuation(input);
  }
}
