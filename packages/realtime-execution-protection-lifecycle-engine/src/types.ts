import type {
  ExecutionAttempt,
  ExecutionRejectionReason,
  ExecutionUpdateResult,
  ProtectionAcknowledgement,
} from "@ulte/execution-engine";
import type { UnixMs } from "@ulte/instrument-model";
import type {
  ProtectionConfirmedResult,
  RealtimeExecutionProtectionResult,
} from "@ulte/realtime-execution-protection-engine";

export type ProtectionLifecycleRejectionReason =
  | "CONFIRMED_PROTECTION_ACKNOWLEDGEMENT_MISSING"
  | "PROTECTION_CONFIRMATION_INCOHERENT"
  | "PROTECTION_ACKNOWLEDGEMENT_CHRONOLOGY_INVALID"
  | "CURRENT_ATTEMPT_MISMATCH"
  | "INVALID_OBSERVATION_TIME"
  | "PROTECTION_ACKNOWLEDGEMENT_OBSERVED_IN_FUTURE";

export interface NoProtectionLifecycleResult {
  readonly status: "NO_PROTECTION_LIFECYCLE";
  readonly preparationCycleId: RealtimeExecutionProtectionResult["preparationCycleId"];
  readonly upstreamStatus: Exclude<RealtimeExecutionProtectionResult["status"], "PROTECTION_CONFIRMED">;
}

export interface ProtectionLifecycleRejectedResult {
  readonly status: "PROTECTION_LIFECYCLE_REJECTED";
  readonly reason: ProtectionLifecycleRejectionReason | ExecutionRejectionReason;
  readonly preparationCycleId: RealtimeExecutionProtectionResult["preparationCycleId"];
  readonly executionAttempt?: ExecutionAttempt;
  readonly observationAsOf?: UnixMs;
  readonly transitionResult?: ExecutionUpdateResult;
}

export interface ProtectionAcknowledgementAppliedResult {
  readonly status: "PROTECTION_ACKNOWLEDGEMENT_APPLIED";
  readonly preparationCycleId: ProtectionConfirmedResult["preparationCycleId"];
  readonly protectionAsOf: UnixMs;
  readonly observationAsOf: UnixMs;
  readonly acknowledgement: ProtectionAcknowledgement;
  readonly executionAttempt: ExecutionAttempt;
  readonly transitionResult: ExecutionUpdateResult;
}

export interface RealtimeExecutionProtectionLifecycleInput {
  readonly protectionResult: RealtimeExecutionProtectionResult;
  /** Required only when protectionResult is PROTECTION_CONFIRMED. */
  readonly executionAttempt?: ExecutionAttempt;
  /** Required only when protectionResult is PROTECTION_CONFIRMED. */
  readonly observationAsOf?: number;
}

export type RealtimeExecutionProtectionLifecycleResult =
  | NoProtectionLifecycleResult
  | ProtectionLifecycleRejectedResult
  | ProtectionAcknowledgementAppliedResult;
