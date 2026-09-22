import type { UnixMs } from "@ulte/instrument-model";
import type {
  BrokerAdapter,
  BrokerAuditSink,
  BrokerFailure,
  ExecutionEnvironment,
  IdempotencyOperation,
  IdempotencyRecord,
  IdempotencyRepository,
  RequestFingerprint,
} from "@ulte/broker-adapters";
import type {
  CancellationAcknowledgement,
  CancellationRejection,
  EntryAcknowledgement,
  EntryCancellationRequest,
  EntryRejection,
  EntrySubmissionRequest,
  ProtectionAcknowledgement,
  ProtectionRejection,
  ProtectionRequest,
} from "@ulte/execution-engine";

export type ExecutionRequest = EntrySubmissionRequest | ProtectionRequest | EntryCancellationRequest;
export type ExecutionAcknowledgement =
  | EntryAcknowledgement
  | ProtectionAcknowledgement
  | CancellationAcknowledgement;
export type ExecutionRejection = EntryRejection | ProtectionRejection | CancellationRejection;

export type AuditDeliveryStatus = "NOT_CONFIGURED" | "COMPLETE" | "FAILED";

interface ResultBase {
  readonly operation: IdempotencyOperation;
  readonly idempotencyKey: string;
  readonly requestFingerprint: RequestFingerprint;
  readonly auditDelivery: AuditDeliveryStatus;
}

export interface ConfirmedResult<A extends ExecutionAcknowledgement = ExecutionAcknowledgement>
  extends ResultBase {
  readonly status: "CONFIRMED";
  readonly record: IdempotencyRecord;
  readonly acknowledgement?: A;
}

export interface RejectedResult<R extends ExecutionRejection = ExecutionRejection> extends ResultBase {
  readonly status: "REJECTED";
  readonly record: IdempotencyRecord;
  readonly rejection?: R;
}

export type ReconciliationReason =
  | "EXISTING_CLAIMED"
  | "EXISTING_SUBMITTED"
  | "EXISTING_OUTCOME_UNKNOWN"
  | "ADAPTER_OUTCOME_UNKNOWN"
  | "ADAPTER_MAY_HAVE_SUBMITTED"
  | "INVALID_ADAPTER_RESPONSE"
  | "RECONCILIATION_STILL_UNKNOWN";

export interface ReconciliationRequirement {
  readonly adapterId: string;
  readonly environment: ExecutionEnvironment;
  readonly executionAttemptId: string;
  readonly operation: IdempotencyOperation;
  readonly idempotencyKey: string;
  readonly requestFingerprint: RequestFingerprint;
  readonly reason: ReconciliationReason;
  readonly adapterOrderId?: string;
}

export interface ReconciliationRequiredResult extends ResultBase {
  readonly status: "RECONCILIATION_REQUIRED";
  readonly requirement: ReconciliationRequirement;
  readonly record: IdempotencyRecord;
}

export interface RetryAuthorization {
  readonly adapterId: string;
  readonly environment: ExecutionEnvironment;
  readonly executionAttemptId: string;
  readonly operation: IdempotencyOperation;
  readonly idempotencyKey: string;
  readonly requestFingerprint: RequestFingerprint;
  readonly source: "DEFINITE_NOT_SUBMITTED" | "RECONCILIATION_CONFIRMED_NOT_SUBMITTED";
}

export interface RetryAuthorizedResult extends ResultBase {
  readonly status: "RETRY_SAFE_SAME_KEY";
  readonly authorization: RetryAuthorization;
  readonly record: IdempotencyRecord;
  readonly failure?: BrokerFailure;
}

export interface DoNotRetryResult extends ResultBase {
  readonly status: "DO_NOT_RETRY";
  readonly record: IdempotencyRecord;
  readonly failure?: BrokerFailure;
}

export interface IdempotencyConflictResult extends ResultBase {
  readonly status: "IDEMPOTENCY_CONFLICT";
  readonly reason: "IDEMPOTENCY_CONFLICT";
  readonly record: IdempotencyRecord;
}

export type OrchestrationResult<
  A extends ExecutionAcknowledgement = ExecutionAcknowledgement,
  R extends ExecutionRejection = ExecutionRejection,
> =
  | ConfirmedResult<A>
  | RejectedResult<R>
  | ReconciliationRequiredResult
  | RetryAuthorizedResult
  | DoNotRetryResult
  | IdempotencyConflictResult;

export interface OrchestrationInput<Request extends ExecutionRequest> {
  readonly adapter: BrokerAdapter;
  readonly idempotencyRepository: IdempotencyRepository;
  readonly request: Request;
  readonly occurredAt: number;
  readonly auditSink?: BrokerAuditSink;
}

export interface ReconciliationRequest {
  readonly reconciliationRequestId: string;
  readonly adapterId: string;
  readonly environment: ExecutionEnvironment;
  readonly executionAttemptId: string;
  readonly operation: IdempotencyOperation;
  readonly idempotencyKey: string;
  readonly requestFingerprint: RequestFingerprint;
  readonly adapterOrderId?: string;
}

export interface ReconciliationRequestInput extends Omit<ReconciliationRequest, "reconciliationRequestId"> {}

export type ReconciliationObservation =
  | { readonly status: "CONFIRMED_ACCEPTED"; readonly adapterOrderId?: string }
  | { readonly status: "CONFIRMED_REJECTED"; readonly adapterOrderId?: string }
  | { readonly status: "CONFIRMED_NOT_SUBMITTED" }
  | { readonly status: "STILL_UNKNOWN"; readonly adapterOrderId?: string };

export interface ReconciliationProvider {
  reconcile(request: ReconciliationRequest): Promise<ReconciliationObservation>;
}

export interface ReconciliationInput {
  readonly provider: ReconciliationProvider;
  readonly idempotencyRepository: IdempotencyRepository;
  readonly request: ReconciliationRequest;
  readonly occurredAt: number;
  readonly auditSink?: BrokerAuditSink;
}

export type ReconciliationResult =
  | ConfirmedResult
  | RejectedResult
  | ReconciliationRequiredResult
  | RetryAuthorizedResult
  | DoNotRetryResult
  | IdempotencyConflictResult;

export type EntryOrchestrationResult = OrchestrationResult<EntryAcknowledgement, EntryRejection>;
export type ProtectionOrchestrationResult = OrchestrationResult<
  ProtectionAcknowledgement,
  ProtectionRejection
>;
export type CancellationOrchestrationResult = OrchestrationResult<
  CancellationAcknowledgement,
  CancellationRejection
>;

export interface ValidatedOperationContext {
  readonly operation: IdempotencyOperation;
  readonly fingerprint: RequestFingerprint;
  readonly occurredAt: UnixMs;
}
