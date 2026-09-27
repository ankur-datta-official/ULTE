import type {
  BrokerAdapterId,
  BrokerAdapterRegistry,
  BrokerAuditSink,
  CredentialProfileRef,
  ExecutionEnvironment,
  IdempotencyRepository,
} from "@ulte/broker-adapters";
import type {
  ExecutionAttempt,
  ProtectionRequest,
  ProtectionRequestTransitionResult,
} from "@ulte/execution-engine";
import type {
  OrchestrationInput,
  ProtectionOrchestrationResult,
} from "@ulte/execution-reconciliation-engine";
import type { UnixMs } from "@ulte/instrument-model";
import type { RealtimeExecutionFillResult } from "@ulte/realtime-execution-fill-engine";

export interface RealtimeExecutionProtectionContext {
  readonly executionEnvironment: ExecutionEnvironment;
  readonly adapterId: BrokerAdapterId;
  readonly credentialProfileRef: CredentialProfileRef;
  readonly protectionAsOf: number;
}

export interface RealtimeExecutionProtectionInput {
  readonly fillLifecycle: RealtimeExecutionFillResult;
  readonly context?: RealtimeExecutionProtectionContext;
}

export type ProtectionSubmissionOrchestrator = (
  input: OrchestrationInput<ProtectionRequest>,
) => Promise<ProtectionOrchestrationResult>;

export interface RealtimeExecutionProtectionDependencies {
  readonly adapterRegistry: BrokerAdapterRegistry;
  readonly idempotencyRepository: IdempotencyRepository;
  readonly auditSink?: BrokerAuditSink;
  readonly orchestrateProtectionSubmission?: ProtectionSubmissionOrchestrator;
}

export type NoProtectionActionReason =
  | "UPSTREAM_NOT_ACTIONABLE"
  | "DUPLICATE_FILL_NO_ACTION"
  | "PROTECTION_POLICY_NOT_ACTIONABLE";

export interface NoProtectionActionResult {
  readonly status: "NO_PROTECTION_ACTION";
  readonly reason: NoProtectionActionReason;
  readonly preparationCycleId: RealtimeExecutionFillResult["preparationCycleId"];
  readonly upstreamStatus: RealtimeExecutionFillResult["status"];
  readonly executionAttempt?: ExecutionAttempt;
  readonly executionPolicyResult?: ProtectionRequestTransitionResult;
}

export type ProtectionSubmissionBlockReason =
  | "LIVE_EXECUTION_DEFERRED"
  | "ADAPTER_PROTECTION_UNSUPPORTED";

export interface ProtectionSubmissionBlockedResult {
  readonly status: "PROTECTION_SUBMISSION_BLOCKED";
  readonly reason: ProtectionSubmissionBlockReason;
  readonly preparationCycleId: RealtimeExecutionFillResult["preparationCycleId"];
  readonly protectionAsOf: UnixMs;
  readonly executionAttempt: ExecutionAttempt;
  readonly executionPolicyResult: ProtectionRequestTransitionResult;
}

interface DurableProtectionBase {
  readonly preparationCycleId: RealtimeExecutionFillResult["preparationCycleId"];
  readonly protectionAsOf: UnixMs;
  readonly executionAttempt: ExecutionAttempt;
  readonly protectionRequest: ProtectionRequest;
  readonly executionPolicyResult: Extract<
    ProtectionRequestTransitionResult,
    { readonly status: "PROTECTION_REQUEST_READY" }
  >;
  readonly durableResult: ProtectionOrchestrationResult;
}

export interface ProtectionConfirmedResult extends DurableProtectionBase {
  readonly status: "PROTECTION_CONFIRMED";
  readonly durableResult: Extract<ProtectionOrchestrationResult, { readonly status: "CONFIRMED" }>;
}

export interface ProtectionRejectedResult extends DurableProtectionBase {
  readonly status: "PROTECTION_REJECTED";
  readonly durableResult: Extract<ProtectionOrchestrationResult, { readonly status: "REJECTED" }>;
}

export interface ReconciliationRequiredProtectionResult extends DurableProtectionBase {
  readonly status: "RECONCILIATION_REQUIRED";
  readonly durableResult: Extract<
    ProtectionOrchestrationResult,
    { readonly status: "RECONCILIATION_REQUIRED" }
  >;
}

export interface DurableProtectionControlResult extends DurableProtectionBase {
  readonly status: "DURABLE_PROTECTION_CONTROL";
  readonly durableResult: Exclude<
    ProtectionOrchestrationResult,
    { readonly status: "CONFIRMED" | "REJECTED" | "RECONCILIATION_REQUIRED" }
  >;
}

export type RealtimeExecutionProtectionResult =
  | NoProtectionActionResult
  | ProtectionSubmissionBlockedResult
  | ProtectionConfirmedResult
  | ProtectionRejectedResult
  | ReconciliationRequiredProtectionResult
  | DurableProtectionControlResult;
