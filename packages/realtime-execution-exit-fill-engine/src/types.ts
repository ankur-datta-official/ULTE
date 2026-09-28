import type {
  ExecutionAttempt,
  ExecutionRejectionReason,
  ExecutionUpdateResult,
  ExitFillEvent,
} from "@ulte/execution-engine";
import type { UnixMs } from "@ulte/instrument-model";
import type {
  ProtectionAcknowledgementAppliedResult,
  RealtimeExecutionProtectionLifecycleResult,
} from "@ulte/realtime-execution-protection-lifecycle-engine";

export type ExitFillProjectionRejectionReason =
  | "EXIT_FILL_MISSING"
  | "EXIT_FILL_EVENT_NOT_NORMALIZED"
  | "CURRENT_ATTEMPT_MISMATCH"
  | "INVALID_OBSERVATION_TIME"
  | "EXIT_FILL_OBSERVED_IN_FUTURE";

export interface NoExitFillProcessingResult {
  readonly status: "NO_EXIT_FILL_PROCESSING";
  readonly preparationCycleId: RealtimeExecutionProtectionLifecycleResult["preparationCycleId"];
  readonly upstreamStatus: Exclude<
    RealtimeExecutionProtectionLifecycleResult["status"],
    "PROTECTION_ACKNOWLEDGEMENT_APPLIED"
  >;
}

export interface ExitFillRejectedResult {
  readonly status: "EXIT_FILL_REJECTED";
  readonly reason: ExitFillProjectionRejectionReason | ExecutionRejectionReason;
  readonly preparationCycleId: RealtimeExecutionProtectionLifecycleResult["preparationCycleId"];
  readonly executionAttempt?: ExecutionAttempt;
  readonly observationAsOf?: UnixMs;
  readonly transitionResult?: ExecutionUpdateResult;
}

export interface ExitFillAppliedResult {
  readonly status: "EXIT_FILL_APPLIED" | "DUPLICATE_EXIT_FILL";
  readonly preparationCycleId: ProtectionAcknowledgementAppliedResult["preparationCycleId"];
  readonly protectionAsOf: UnixMs;
  readonly observationAsOf: UnixMs;
  readonly exitFill: ExitFillEvent;
  readonly executionAttempt: ExecutionAttempt;
  readonly transitionResult: ExecutionUpdateResult;
}

export interface RealtimeExecutionExitFillInput {
  readonly protectionLifecycle: RealtimeExecutionProtectionLifecycleResult;
  /** Required only when protectionLifecycle is PROTECTION_ACKNOWLEDGEMENT_APPLIED. */
  readonly executionAttempt?: ExecutionAttempt;
  /** Required only when protectionLifecycle is PROTECTION_ACKNOWLEDGEMENT_APPLIED. */
  readonly exitFill?: ExitFillEvent;
  /** Required only when protectionLifecycle is PROTECTION_ACKNOWLEDGEMENT_APPLIED. */
  readonly observationAsOf?: number;
}

export type RealtimeExecutionExitFillResult =
  | NoExitFillProcessingResult
  | ExitFillRejectedResult
  | ExitFillAppliedResult;
