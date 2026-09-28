import type { LinearInstrumentSizingSpec } from "@ulte/position-sizing-engine";
import type { RealtimeExecutionExitFillResult } from "@ulte/realtime-execution-exit-fill-engine";
import type { RealtimeExecutionFillResult } from "@ulte/realtime-execution-fill-engine";
import type {
  RealizedAccountingRejectedResult,
  RealizedAccountingRejectionReason,
  RealizedTradeAccounting,
} from "@ulte/trade-accounting-engine";

export type RealtimeTradeAccountingSourceKind = "ENTRY_FILL" | "EXIT_FILL";

export interface EntryFillRealtimeAccountingInput {
  readonly sourceKind: "ENTRY_FILL";
  readonly fillLifecycle: RealtimeExecutionFillResult;
  readonly accountingSpec: LinearInstrumentSizingSpec;
}

export interface ExitFillRealtimeAccountingInput {
  readonly sourceKind: "EXIT_FILL";
  readonly exitFillLifecycle: RealtimeExecutionExitFillResult;
  readonly accountingSpec: LinearInstrumentSizingSpec;
}

export type RealtimeTradeAccountingInput =
  | EntryFillRealtimeAccountingInput
  | ExitFillRealtimeAccountingInput;

export type RealtimeTradeAccountingUpstreamStatus =
  | RealtimeExecutionFillResult["status"]
  | RealtimeExecutionExitFillResult["status"];

export interface NoAccountingProjectionResult {
  readonly status: "NO_ACCOUNTING_PROJECTION";
  readonly sourceKind: RealtimeTradeAccountingSourceKind;
  readonly upstreamStatus: RealtimeTradeAccountingUpstreamStatus;
}

export interface RealizedAccountingProjectedRealtimeResult {
  readonly status: "REALIZED_ACCOUNTING_PROJECTED";
  readonly sourceKind: RealtimeTradeAccountingSourceKind;
  readonly upstreamStatus: RealtimeTradeAccountingUpstreamStatus;
  readonly accounting: RealizedTradeAccounting;
}

export interface RealizedAccountingRejectedRealtimeResult {
  readonly status: "REALIZED_ACCOUNTING_REJECTED";
  readonly sourceKind: RealtimeTradeAccountingSourceKind;
  readonly upstreamStatus: RealtimeTradeAccountingUpstreamStatus;
  readonly reason: RealizedAccountingRejectionReason;
  readonly accountingProjection: RealizedAccountingRejectedResult;
}

export type RealtimeTradeAccountingResult =
  | NoAccountingProjectionResult
  | RealizedAccountingProjectedRealtimeResult
  | RealizedAccountingRejectedRealtimeResult;
