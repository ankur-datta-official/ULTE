import {
  projectRealizedTradeAccounting,
  type RealizedTradeAccountingResult,
} from "@ulte/trade-accounting-engine";
import type {
  RealtimeTradeAccountingInput,
  RealtimeTradeAccountingResult,
  RealtimeTradeAccountingSourceKind,
  RealtimeTradeAccountingUpstreamStatus,
} from "./types.js";

function noProjection(
  sourceKind: RealtimeTradeAccountingSourceKind,
  upstreamStatus: RealtimeTradeAccountingUpstreamStatus,
): RealtimeTradeAccountingResult {
  return Object.freeze({ status: "NO_ACCOUNTING_PROJECTION", sourceKind, upstreamStatus });
}

function wrapProjection(
  sourceKind: RealtimeTradeAccountingSourceKind,
  upstreamStatus: RealtimeTradeAccountingUpstreamStatus,
  accountingProjection: RealizedTradeAccountingResult,
): RealtimeTradeAccountingResult {
  if (accountingProjection.status === "REALIZED_ACCOUNTING_REJECTED") {
    return Object.freeze({
      status: "REALIZED_ACCOUNTING_REJECTED",
      sourceKind,
      upstreamStatus,
      reason: accountingProjection.reason,
      accountingProjection,
    });
  }
  return Object.freeze({
    status: "REALIZED_ACCOUNTING_PROJECTED",
    sourceKind,
    upstreamStatus,
    accounting: accountingProjection.accounting,
  });
}

/** Replays accounting only from the authoritative attempt carried by an actionable realtime result. */
export function projectRealtimeTradeAccounting(
  input: RealtimeTradeAccountingInput,
): RealtimeTradeAccountingResult {
  if (input.sourceKind === "ENTRY_FILL") {
    const upstream = input.fillLifecycle;
    if (upstream.status !== "FILL_APPLIED" && upstream.status !== "DUPLICATE_FILL") {
      return noProjection(input.sourceKind, upstream.status);
    }
    return wrapProjection(
      input.sourceKind,
      upstream.status,
      projectRealizedTradeAccounting(upstream.executionAttempt, input.accountingSpec),
    );
  }

  const upstream = input.exitFillLifecycle;
  if (upstream.status !== "EXIT_FILL_APPLIED" && upstream.status !== "DUPLICATE_EXIT_FILL") {
    return noProjection(input.sourceKind, upstream.status);
  }
  return wrapProjection(
    input.sourceKind,
    upstream.status,
    projectRealizedTradeAccounting(upstream.executionAttempt, input.accountingSpec),
  );
}

export class RealtimeTradeAccountingEngine {
  project(input: RealtimeTradeAccountingInput): RealtimeTradeAccountingResult {
    return projectRealtimeTradeAccounting(input);
  }
}
