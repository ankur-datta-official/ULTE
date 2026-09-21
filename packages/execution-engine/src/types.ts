import type {
  InstrumentId,
  NonNegativeDecimalString,
  PositiveDecimalString,
  UnixMs,
} from "@ulte/instrument-model";
import type {
  ExecutionPreparationResult,
  ExecutionSide,
} from "@ulte/execution-preparation-engine";

export const EXECUTION_ATTEMPT_SCHEMA_VERSION = "EXECUTION_ATTEMPT_V1" as const;

export type ExecutionState =
  | "READY_FOR_ENTRY_SUBMISSION"
  | "ENTRY_SUBMISSION_PENDING"
  | "ENTRY_WORKING"
  | "ENTRY_PARTIALLY_FILLED"
  | "ENTRY_FILLED"
  | "PROTECTION_PENDING"
  | "PROTECTED"
  | "CANCEL_PENDING"
  | "CANCELED"
  | "ENTRY_CANCELED_WITH_EXPOSURE"
  | "REJECTED"
  | "FAILED";

export type EntryOrderStatus =
  | "NOT_SUBMITTED"
  | "SUBMISSION_PENDING"
  | "WORKING"
  | "FILLED"
  | "CANCELED"
  | "REJECTED";

export type ProtectionMode = "NATIVE_BRACKET" | "MANAGED_PROTECTION";

export interface AdapterCapabilitiesInput {
  readonly supportsClientIdempotency: boolean;
  readonly supportsCloseOnlyExit: boolean;
  readonly supportsNativeBracketProtection: boolean;
  readonly supportsProtectionModification: boolean;
  readonly supportsOrderCancellation: boolean;
  readonly supportsPartialFillReporting: boolean;
}

export interface AdapterCapabilities extends AdapterCapabilitiesInput {}

export interface EntrySubmissionRequest {
  readonly kind: "ENTRY";
  readonly executionAttemptId: string;
  readonly idempotencyKey: string;
  readonly instrumentId: InstrumentId;
  readonly side: ExecutionSide;
  readonly quantity: PositiveDecimalString;
  readonly limitPrice: PositiveDecimalString;
}

export interface ProtectionRequest {
  readonly kind: "PROTECTION";
  readonly executionAttemptId: string;
  readonly protectionRequestId: string;
  readonly idempotencyKey: string;
  readonly instrumentId: InstrumentId;
  readonly mode: ProtectionMode;
  readonly exitSide: ExecutionSide;
  /** Incremental quantity covered by this request. */
  readonly protectedQuantity: PositiveDecimalString;
  /** Cumulative coverage after acknowledgement; this is part of operation identity. */
  readonly targetCumulativeProtectedQuantity: PositiveDecimalString;
  readonly stopTriggerPrice: PositiveDecimalString;
  readonly targetPrice: PositiveDecimalString;
}

export interface EntryCancellationRequest {
  readonly kind: "ENTRY_CANCELLATION";
  readonly executionAttemptId: string;
  readonly cancellationRequestId: string;
  readonly idempotencyKey: string;
  readonly adapterOrderId: string;
}

export interface EntryAcknowledgementInput {
  readonly executionAttemptId: string;
  readonly idempotencyKey: string;
  readonly adapterOrderId: string;
  readonly acknowledgedAt: number;
}
export interface EntryAcknowledgement extends Omit<EntryAcknowledgementInput, "acknowledgedAt"> {
  readonly kind: "SUBMISSION_ACCEPTED";
  readonly acknowledgedAt: UnixMs;
}

export interface EntryRejectionInput {
  readonly executionAttemptId: string;
  readonly idempotencyKey: string;
  readonly adapterReasonCode: string;
  readonly rejectedAt: number;
}
export interface EntryRejection extends Omit<EntryRejectionInput, "rejectedAt"> {
  readonly kind: "SUBMISSION_REJECTED";
  readonly rejectedAt: UnixMs;
}

export interface FillEventInput {
  readonly executionAttemptId: string;
  readonly adapterOrderId: string;
  readonly fillId: string;
  readonly filledQuantity: string;
  readonly fillPrice: string;
  readonly filledAt: number;
}
export interface FillEvent extends Omit<FillEventInput, "filledQuantity" | "fillPrice" | "filledAt"> {
  readonly kind: "FILL";
  readonly filledQuantity: PositiveDecimalString;
  readonly fillPrice: PositiveDecimalString;
  readonly filledAt: UnixMs;
}

export interface ProtectionAcknowledgementInput {
  readonly executionAttemptId: string;
  readonly protectionRequestId: string;
  readonly idempotencyKey: string;
  readonly protectedQuantity: string;
  readonly acknowledgedAt: number;
}
export interface ProtectionAcknowledgement extends Omit<ProtectionAcknowledgementInput, "protectedQuantity" | "acknowledgedAt"> {
  readonly kind: "PROTECTION_ACCEPTED";
  readonly protectedQuantity: PositiveDecimalString;
  readonly acknowledgedAt: UnixMs;
}

export interface ProtectionRejectionInput {
  readonly executionAttemptId: string;
  readonly protectionRequestId: string;
  readonly idempotencyKey: string;
  readonly adapterReasonCode: string;
  readonly rejectedAt: number;
}
export interface ProtectionRejection extends Omit<ProtectionRejectionInput, "rejectedAt"> {
  readonly kind: "PROTECTION_REJECTED";
  readonly rejectedAt: UnixMs;
}

export interface CancellationAcknowledgementInput {
  readonly executionAttemptId: string;
  readonly cancellationRequestId: string;
  readonly idempotencyKey: string;
  readonly adapterOrderId: string;
  readonly acknowledgedAt: number;
}
export interface CancellationAcknowledgement extends Omit<CancellationAcknowledgementInput, "acknowledgedAt"> {
  readonly kind: "CANCEL_ACCEPTED";
  readonly acknowledgedAt: UnixMs;
}

export interface CancellationRejectionInput {
  readonly executionAttemptId: string;
  readonly cancellationRequestId: string;
  readonly idempotencyKey: string;
  readonly adapterOrderId: string;
  readonly adapterReasonCode: string;
  readonly rejectedAt: number;
}
export interface CancellationRejection extends Omit<CancellationRejectionInput, "rejectedAt"> {
  readonly kind: "CANCEL_REJECTED";
  readonly rejectedAt: UnixMs;
}

export interface ExecutionAttempt {
  readonly status: "EXECUTION_ATTEMPT_READY";
  readonly schemaVersion: typeof EXECUTION_ATTEMPT_SCHEMA_VERSION;
  readonly executionAttemptId: string;
  readonly executionPlanId: string;
  readonly tradeIntentId: string;
  readonly candidateId: string;
  readonly instrumentId: InstrumentId;
  readonly preparedAsOf: UnixMs;
  readonly entrySide: ExecutionSide;
  readonly exitSide: ExecutionSide;
  readonly quantity: PositiveDecimalString;
  readonly quantityUnit: string;
  readonly entryPrice: PositiveDecimalString;
  readonly stopTriggerPrice: PositiveDecimalString;
  readonly targetPrice: PositiveDecimalString;
  readonly approvedRiskAmount: PositiveDecimalString;
  readonly actualRiskAmount: PositiveDecimalString;
  readonly netRewardRiskBps: string;
  readonly state: ExecutionState;
  readonly entryOrderStatus: EntryOrderStatus;
  readonly submissionIdempotencyKey: string;
  readonly protectionMode?: ProtectionMode;
  readonly adapterCapabilities?: AdapterCapabilities;
  readonly adapterOrderId?: string;
  readonly filledEntryQuantity: NonNegativeDecimalString;
  readonly protectedQuantity: NonNegativeDecimalString;
  readonly unprotectedFilledQuantity: NonNegativeDecimalString;
  readonly lastFillPrice?: PositiveDecimalString;
  readonly processedFills: readonly FillEvent[];
  readonly pendingProtectionRequest?: ProtectionRequest;
  readonly pendingCancellationRequest?: EntryCancellationRequest;
  readonly lastExecutionEventAt?: UnixMs;
  readonly entryRejectionReason?: string;
  readonly protectionFailureReason?: string;
  readonly cancellationRejectionReason?: string;
}

export interface UpstreamNotReadyExecutionAttemptResult {
  readonly status: "UPSTREAM_NOT_READY";
  readonly executionPlanStatus: Exclude<ExecutionPreparationResult["status"], "EXECUTION_PLAN_READY">;
  readonly candidateId: string;
}

export interface RejectedExecutionAttemptResult {
  readonly status: "DATA_REJECTED";
  readonly reason: "INVALID_EXECUTION_PLAN";
  readonly candidateId: string;
}

export type ExecutionAttemptCreationResult =
  | ExecutionAttempt
  | UpstreamNotReadyExecutionAttemptResult
  | RejectedExecutionAttemptResult;

export interface ProtectionModeSelectedResult {
  readonly status: "PROTECTION_MODE_SELECTED";
  readonly protectionMode: ProtectionMode;
}
export interface ExecutionNotSupportedResult {
  readonly status: "EXECUTION_NOT_SUPPORTED";
  readonly reason: "ADAPTER_NOT_SAFE_FOR_PROTECTION" | "ADAPTER_DOES_NOT_SUPPORT_CANCELLATION";
  readonly attempt?: ExecutionAttempt;
}
export type ProtectionModeSelectionResult = ProtectionModeSelectedResult | ExecutionNotSupportedResult;

export type ExecutionRejectionReason =
  | "INVALID_ADAPTER_CAPABILITIES"
  | "ADAPTER_CAPABILITIES_MISMATCH"
  | "INVALID_TRANSITION"
  | "INVALID_EVENT"
  | "EVENT_ATTEMPT_MISMATCH"
  | "IDEMPOTENCY_KEY_MISMATCH"
  | "ADAPTER_ORDER_ID_MISMATCH"
  | "PROTECTION_REQUEST_MISMATCH"
  | "CANCELLATION_REQUEST_MISMATCH"
  | "OUT_OF_ORDER_EXECUTION_EVENT"
  | "OVERFILL_DETECTED"
  | "DUPLICATE_FILL_CONFLICT"
  | "NO_UNPROTECTED_FILLED_QUANTITY"
  | "PROTECTED_QUANTITY_EXCEEDS_FILLED";

export interface TransitionRejectedResult {
  readonly status: "TRANSITION_REJECTED" | "DATA_REJECTED";
  readonly reason: ExecutionRejectionReason;
  readonly attempt: ExecutionAttempt;
}
export interface ExecutionAttemptUpdatedResult {
  readonly status: "EXECUTION_ATTEMPT_UPDATED" | "DUPLICATE_EVENT_IGNORED";
  readonly attempt: ExecutionAttempt;
}
export interface EntrySubmissionReadyResult {
  readonly status: "ENTRY_SUBMISSION_READY";
  readonly attempt: ExecutionAttempt;
  readonly request: EntrySubmissionRequest;
}
export interface ProtectionRequestReadyResult {
  readonly status: "PROTECTION_REQUEST_READY";
  readonly attempt: ExecutionAttempt;
  readonly request: ProtectionRequest;
}
export interface CancellationRequestReadyResult {
  readonly status: "CANCELLATION_REQUEST_READY";
  readonly attempt: ExecutionAttempt;
  readonly request: EntryCancellationRequest;
}

export type EntrySubmissionTransitionResult =
  | EntrySubmissionReadyResult
  | ExecutionNotSupportedResult
  | TransitionRejectedResult;
export type ProtectionRequestTransitionResult =
  | ProtectionRequestReadyResult
  | ExecutionNotSupportedResult
  | TransitionRejectedResult;
export type CancellationRequestTransitionResult =
  | CancellationRequestReadyResult
  | ExecutionNotSupportedResult
  | TransitionRejectedResult;
export type ExecutionUpdateResult = ExecutionAttemptUpdatedResult | TransitionRejectedResult;

export type EntrySubmissionResponse = EntryAcknowledgement | EntryRejection;
export type ProtectionSubmissionResponse = ProtectionAcknowledgement | ProtectionRejection;
export type CancellationSubmissionResponse = CancellationAcknowledgement | CancellationRejection;

/**
 * Contract only. Implementations must map every stable key to venue client identity,
 * or provide durable local deduplication when the venue cannot do so.
 */
export interface ExecutionAdapter {
  readonly capabilities: AdapterCapabilities;
  submitEntry(request: EntrySubmissionRequest): Promise<EntrySubmissionResponse>;
  submitProtection(request: ProtectionRequest): Promise<ProtectionSubmissionResponse>;
  cancelEntry(request: EntryCancellationRequest): Promise<CancellationSubmissionResponse>;
}
