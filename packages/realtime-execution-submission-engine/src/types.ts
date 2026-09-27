import type {
  BrokerAdapterId,
  BrokerAdapterRegistry,
  BrokerAuditSink,
  CredentialProfileRef,
  ExecutionEnvironment,
  IdempotencyRepository,
} from "@ulte/broker-adapters";
import type {
  EntrySubmissionTransitionResult,
  ExecutionAttempt,
} from "@ulte/execution-engine";
import type {
  EntryOrchestrationResult,
  OrchestrationInput,
} from "@ulte/execution-reconciliation-engine";
import type { UnixMs } from "@ulte/instrument-model";
import type {
  RealtimeExecutionPreparationResult,
} from "@ulte/realtime-execution-preparation-engine";
import type { EntrySubmissionRequest } from "@ulte/execution-engine";

export interface RealtimeExecutionSubmissionConfig {
  /** Inclusive: a plan is accepted when age equals this value. */
  readonly maxPreparedPlanAgeMs: number;
}

export interface RealtimeExecutionSubmissionContext {
  readonly executionEnvironment: ExecutionEnvironment;
  readonly adapterId: BrokerAdapterId;
  readonly credentialProfileRef: CredentialProfileRef;
  readonly submissionAsOf: number;
}

export interface RealtimeExecutionSubmissionInput {
  readonly preparation: RealtimeExecutionPreparationResult;
  readonly context?: RealtimeExecutionSubmissionContext;
}

export type EntrySubmissionOrchestrator = (
  input: OrchestrationInput<EntrySubmissionRequest>,
) => Promise<EntryOrchestrationResult>;

export interface RealtimeExecutionSubmissionDependencies {
  readonly adapterRegistry: BrokerAdapterRegistry;
  readonly idempotencyRepository: IdempotencyRepository;
  readonly auditSink?: BrokerAuditSink;
  readonly orchestrateEntrySubmission?: EntrySubmissionOrchestrator;
}

export interface NoSubmissionResult {
  readonly status: "NO_SUBMISSION";
  readonly preparationCycleId: RealtimeExecutionPreparationResult["preparationCycleId"];
  readonly upstreamStatus: Exclude<RealtimeExecutionPreparationResult["status"], "EXECUTION_PREPARED">;
}

export type SubmissionBlockReason =
  | "LIVE_EXECUTION_DEFERRED"
  | "PREPARED_PLAN_EXPIRED"
  | "ADAPTER_EXECUTION_UNSUPPORTED";

export interface SubmissionBlockedResult {
  readonly status: "SUBMISSION_BLOCKED";
  readonly reason: SubmissionBlockReason;
  readonly preparationCycleId: RealtimeExecutionPreparationResult["preparationCycleId"];
  readonly submissionAsOf: UnixMs;
  readonly executionPolicyResult?: EntrySubmissionTransitionResult;
}

interface DurableSubmissionBase {
  readonly preparationCycleId: RealtimeExecutionPreparationResult["preparationCycleId"];
  readonly submissionAsOf: UnixMs;
  readonly executionAttempt: ExecutionAttempt;
  readonly durableResult: EntryOrchestrationResult;
}

export interface SubmissionConfirmedResult extends DurableSubmissionBase {
  readonly status: "SUBMISSION_CONFIRMED";
  readonly durableResult: Extract<EntryOrchestrationResult, { readonly status: "CONFIRMED" }>;
}

export interface SubmissionRejectedResult extends DurableSubmissionBase {
  readonly status: "SUBMISSION_REJECTED";
  readonly durableResult: Extract<EntryOrchestrationResult, { readonly status: "REJECTED" }>;
}

export interface ReconciliationRequiredSubmissionResult extends DurableSubmissionBase {
  readonly status: "RECONCILIATION_REQUIRED";
  readonly durableResult: Extract<EntryOrchestrationResult, { readonly status: "RECONCILIATION_REQUIRED" }>;
}

export interface DurableControlSubmissionResult extends DurableSubmissionBase {
  readonly status: "DURABLE_SUBMISSION_CONTROL";
  readonly durableResult: Exclude<EntryOrchestrationResult,
    { readonly status: "CONFIRMED" | "REJECTED" | "RECONCILIATION_REQUIRED" }>;
}

export type RealtimeExecutionSubmissionResult =
  | NoSubmissionResult
  | SubmissionBlockedResult
  | SubmissionConfirmedResult
  | SubmissionRejectedResult
  | ReconciliationRequiredSubmissionResult
  | DurableControlSubmissionResult;
