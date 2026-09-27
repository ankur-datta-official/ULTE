import type {
  EntryAcknowledgement,
  ExecutionAttempt,
  ExecutionRejectionReason,
  ExecutionUpdateResult,
  FillEvent,
} from "@ulte/execution-engine";
import type { UnixMs } from "@ulte/instrument-model";
import type {
  RealtimeExecutionSubmissionResult,
} from "@ulte/realtime-execution-submission-engine";

export type FillOrchestrationRejectionReason =
  | "CONFIRMED_ACKNOWLEDGEMENT_MISSING"
  | "SUBMISSION_STATE_INCOHERENT"
  | "ACKNOWLEDGEMENT_CHRONOLOGY_INVALID"
  | "CURRENT_ATTEMPT_MISMATCH"
  | "FILL_EVENT_NOT_NORMALIZED"
  | "INVALID_OBSERVATION_TIME"
  | "FILL_OBSERVED_IN_FUTURE";

export interface NoFillProcessingResult {
  readonly status: "NO_FILL_PROCESSING";
  readonly preparationCycleId: RealtimeExecutionSubmissionResult["preparationCycleId"];
  readonly upstreamStatus: Exclude<RealtimeExecutionSubmissionResult["status"], "SUBMISSION_CONFIRMED">;
}

export interface FillLifecycleInitializedResult {
  readonly status: "FILL_LIFECYCLE_INITIALIZED";
  readonly preparationCycleId: RealtimeExecutionSubmissionResult["preparationCycleId"];
  readonly submissionAsOf: UnixMs;
  readonly acknowledgement: EntryAcknowledgement;
  readonly executionAttempt: ExecutionAttempt;
}

export interface FillRejectedResult {
  readonly status: "FILL_REJECTED";
  readonly reason: FillOrchestrationRejectionReason | ExecutionRejectionReason;
  readonly preparationCycleId: RealtimeExecutionSubmissionResult["preparationCycleId"];
  readonly executionAttempt?: ExecutionAttempt;
  readonly observationAsOf?: UnixMs;
  readonly transitionResult?: ExecutionUpdateResult;
}

export type FillLifecycleInitializationResult =
  | NoFillProcessingResult
  | FillLifecycleInitializedResult
  | FillRejectedResult;

export interface RealtimeExecutionFillInput {
  readonly submission: RealtimeExecutionSubmissionResult;
  readonly executionAttempt: ExecutionAttempt;
  /** An existing provider-neutral event produced by createFillEvent. */
  readonly fill: FillEvent;
  readonly observationAsOf: number;
}

export interface FillAppliedResult {
  readonly status: "FILL_APPLIED" | "DUPLICATE_FILL";
  readonly preparationCycleId: RealtimeExecutionSubmissionResult["preparationCycleId"];
  readonly submissionAsOf: UnixMs;
  readonly observationAsOf: UnixMs;
  readonly fill: FillEvent;
  readonly executionAttempt: ExecutionAttempt;
  readonly transitionResult: ExecutionUpdateResult;
}

export type RealtimeExecutionFillResult =
  | NoFillProcessingResult
  | FillAppliedResult
  | FillRejectedResult;
