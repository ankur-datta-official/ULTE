import { assertBrokerAdapterConformance, classifyRetryDisposition, createBrokerFailure, fingerprintEntryCancellation,
  fingerprintEntrySubmission, fingerprintProtectionRequest, type BrokerAdapter,
  type BrokerFailure, type RequestFingerprint } from "@ulte/broker-adapters";
import { createCancellationAcknowledgement, createCancellationRejection,
  createEntryAcknowledgement, createEntryRejection, createProtectionAcknowledgement,
  createProtectionRejection, type EntryCancellationRequest, type EntrySubmissionRequest,
  type ProtectionRequest } from "@ulte/execution-engine";
import { createReconciliationRequest, type CanonicalRejectionObservation,
  type ReconciliationProvider } from "@ulte/execution-reconciliation-engine";
import { unixMs, type UnixMs } from "@ulte/instrument-model";
import { createOrchestrationExternalOutcome, orchestrationOutcomeKey,
  type AdoptOutcomeRequest, type ExecutionAuthorityCheckpoint, type OrchestrationRecoveryState,
  type OrchestrationExternalOutcome,
  type OrchestrationPendingEffectIdentity, type OrchestrationSessionId,
  type TerminalNonSubmissionDispositionLogicalPayload } from "@ulte/orchestration-state-store";
import type { MigrationTarget } from "@ulte/migration-coordinator";
import { PostgresOrchestrationCommitService } from "./commit-service.js";
import { PostgresOrchestrationFencedWriterService, type PendingWriterAuthority,
  type PendingWriterFailure } from "./fenced-writer-service.js";
import type { PostgresSnapshotExecutor } from "./postgres.js";
import { PostgresRecoveryBootLoader, type PostgresRecoveryBootResult } from "./recovery-boot-loader.js";
import { PostgresTerminalNonSubmissionCommitService, TerminalCommitError,
  type NormalTerminalNonSubmissionRequest } from
  "./terminal-commit-service.js";

type Submission = EntrySubmissionRequest | ProtectionRequest | EntryCancellationRequest;
type AdapterResponse = Awaited<ReturnType<BrokerAdapter["submitEntry"]>>
  | Awaited<ReturnType<BrokerAdapter["submitProtection"]>>
  | Awaited<ReturnType<BrokerAdapter["cancelEntry"]>>;
type Operation = OrchestrationPendingEffectIdentity["operation"];
type Canonical = Extract<OrchestrationExternalOutcome["observation"],
  { readonly kind: "CANONICAL_EXECUTION_TRANSITION" }>["transition"];
type Reconciliation = Extract<PostgresRecoveryBootResult, { readonly status: "RECONCILIATION_REQUIRED" }>;
type Intent = Extract<PostgresRecoveryBootResult, { readonly status: "INTENT_DISPOSITION_REQUIRED" }>;

/** The runtime has no generic status writer or raw idempotency repository. */
export interface RecoverablePersistencePort {
  readonly boot: Pick<PostgresRecoveryBootLoader, "boot">;
  readonly pending: Pick<PostgresOrchestrationFencedWriterService,
    "claimPendingIdempotency" | "recordPendingIdempotencyOutcome" |
    "persistPendingTerminalOutcome" | "persistPendingReconciliationObservation">;
  readonly terminal: Pick<PostgresTerminalNonSubmissionCommitService,
    "commitNormalTerminalNonSubmissionDisposition">;
  readonly adoption: Pick<PostgresOrchestrationCommitService, "adoptOutcome">;
}

/** All identifiers and observation times come from the caller; no clock or order facts are invented. */
export interface RecoverableSubmissionInput {
  readonly sessionId: OrchestrationSessionId;
  readonly ownerId: string;
  readonly adapter: BrokerAdapter;
  readonly request: Submission;
  readonly claimedAt: UnixMs;
  readonly submittedAt: UnixMs;
  readonly observedAt: UnixMs;
  readonly outcomeKey: string;
  readonly terminalDispositionRef: string;
  readonly failureEventRef: string;
  /** An existing RETRY_AUTHORIZED record needs an explicit same-key retry request. */
  readonly explicitSameKeyRetry?: true;
  readonly currentCheckpoint: ExecutionAuthorityCheckpoint;
  readonly currentRecoveryState: OrchestrationRecoveryState;
  readonly adoptedCheckpoint: AdoptOutcomeRequest["committedCheckpoint"];
  readonly adoptedRecoveryState: AdoptOutcomeRequest["resultingRecoveryState"];
}

export interface RecoverableReconciliationInput {
  readonly sessionId: OrchestrationSessionId;
  readonly ownerId: string;
  readonly provider: ReconciliationProvider;
  readonly observedAt: UnixMs;
  readonly outcomeKey: string;
  /** Optional immediate adoption; a later boot can adopt the durable outcome if omitted or interrupted. */
  readonly adoptedCheckpoint?: AdoptOutcomeRequest["committedCheckpoint"];
  readonly adoptedRecoveryState?: AdoptOutcomeRequest["resultingRecoveryState"];
}
export interface RecoverableAdoptionInput {
  readonly sessionId: OrchestrationSessionId;
  readonly ownerId: string;
  readonly adoptedCheckpoint: AdoptOutcomeRequest["committedCheckpoint"];
  readonly adoptedRecoveryState: AdoptOutcomeRequest["resultingRecoveryState"];
}

export type RecoverableRuntimeResult =
  | Readonly<{ readonly status: "BLOCKED"; readonly boot: PostgresRecoveryBootResult }>
  | Readonly<{ readonly status: "AUTHORITY_LOST"; readonly reason: PendingWriterFailure }>
  | Readonly<{ readonly status: "RECONCILIATION_REQUIRED"; readonly outcome?: OrchestrationExternalOutcome }>
  | Readonly<{ readonly status: "CANONICAL_OUTCOME_REQUIRED"; readonly outcome: OrchestrationExternalOutcome }>
  | Readonly<{ readonly status: "RETRY_AUTHORIZED"; readonly outcome?: OrchestrationExternalOutcome }>
  | Readonly<{ readonly status: "TERMINAL_NON_SUBMISSION" }>
  | Readonly<{ readonly status: "OUTCOME_AVAILABLE"; readonly outcome: OrchestrationExternalOutcome }>
  | Readonly<{ readonly status: "ADOPTED"; readonly outcomeKey: string;
      readonly outcome?: OrchestrationExternalOutcome }>;

function blocked(boot: PostgresRecoveryBootResult): RecoverableRuntimeResult {
  return Object.freeze({ status: "BLOCKED", boot });
}
function lost(reason: PendingWriterFailure): RecoverableRuntimeResult {
  return Object.freeze({ status: "AUTHORITY_LOST", reason });
}
function identity(boot: Intent | Reconciliation): OrchestrationPendingEffectIdentity {
  const effect = boot.pendingEffect;
  return { adapterId: effect.adapterId, environment: effect.environment, operation: effect.operation,
    executionAttemptId: effect.executionAttemptId, idempotencyKey: effect.idempotencyKey,
    requestFingerprint: effect.requestFingerprint };
}
function authority(boot: Intent | Reconciliation): PendingWriterAuthority {
  if (boot.checkpointRef === null) throw new TypeError("Pending execution checkpoint missing");
  return { sessionId: boot.sessionId, ownerId: boot.ownerId, expectedFence: boot.fenceToken,
    expectedRecoveryRevision: boot.recoveryRevision, expectedCheckpointRef: boot.checkpointRef,
    pendingEffectIdentity: identity(boot) };
}
function fingerprint(operation: Operation, request: Submission): RequestFingerprint {
  if (operation === "ENTRY_SUBMISSION") return fingerprintEntrySubmission(request as EntrySubmissionRequest);
  if (operation === "PROTECTION_SUBMISSION") return fingerprintProtectionRequest(request as ProtectionRequest);
  return fingerprintEntryCancellation(request as EntryCancellationRequest);
}
function matches(boot: Intent, adapter: BrokerAdapter, request: Submission): boolean {
  const p = boot.pendingEffect;
  const requestKind = p.operation === "ENTRY_SUBMISSION" ? "ENTRY"
    : p.operation === "PROTECTION_SUBMISSION" ? "PROTECTION" : "ENTRY_CANCELLATION";
  return adapter.descriptor.adapterId === p.adapterId && adapter.descriptor.environment === p.environment
    && p.environment === "SANDBOX" && request.kind === requestKind
    && request.executionAttemptId === p.executionAttemptId
    && request.idempotencyKey === p.idempotencyKey && fingerprint(p.operation, request) === p.requestFingerprint;
}
function typedFailure(value: unknown): BrokerFailure | null {
  if (typeof value !== "object" || value === null || !("category" in value)
      || !("certainty" in value) || !("submissionExposure" in value)) return null;
  try { return createBrokerFailure(value as BrokerFailure); } catch { return null; }
}
function canonical(operation: Operation, response: AdapterResponse, request: Submission): Canonical {
  if (response.executionAttemptId !== request.executionAttemptId
      || response.idempotencyKey !== request.idempotencyKey) throw new TypeError("Adapter response identity mismatch");
  const kind = response.kind;
  if (operation === "ENTRY_SUBMISSION") {
    if (kind === "SUBMISSION_ACCEPTED") { const { kind: _kind, ...acknowledgement } = createEntryAcknowledgement(response);
      return { kind: "ENTRY_SUBMISSION_ACKNOWLEDGED", acknowledgement }; }
    if (kind === "SUBMISSION_REJECTED") { const { kind: _kind, ...rejection } = createEntryRejection(response);
      return { kind: "ENTRY_SUBMISSION_REJECTED", rejection }; }
  }
  if (operation === "PROTECTION_SUBMISSION"
      && "protectionRequestId" in response
      && response.protectionRequestId === (request as ProtectionRequest).protectionRequestId) {
    if (kind === "PROTECTION_ACCEPTED") { const { kind: _kind, ...acknowledgement } = createProtectionAcknowledgement(response);
      return { kind: "PROTECTION_ACKNOWLEDGED", acknowledgement }; }
    if (kind === "PROTECTION_REJECTED") { const { kind: _kind, ...rejection } = createProtectionRejection(response);
      return { kind: "PROTECTION_REJECTED", rejection }; }
  }
  if (operation === "ENTRY_CANCELLATION"
      && "cancellationRequestId" in response && "adapterOrderId" in response
      && response.cancellationRequestId === (request as EntryCancellationRequest).cancellationRequestId
      && response.adapterOrderId === (request as EntryCancellationRequest).adapterOrderId) {
    if (kind === "CANCEL_ACCEPTED") { const { kind: _kind, ...acknowledgement } = createCancellationAcknowledgement(response);
      return { kind: "ENTRY_CANCELLATION_ACKNOWLEDGED", acknowledgement }; }
    if (kind === "CANCEL_REJECTED") { const { kind: _kind, ...rejection } = createCancellationRejection(response);
      return { kind: "ENTRY_CANCELLATION_REJECTED", rejection }; }
  }
  throw new TypeError("Invalid adapter response");
}
function exactCanonicalRejection(observation: CanonicalRejectionObservation,
  boot: Reconciliation): Canonical {
  if (Object.keys(observation).length !== 5
      || !["status", "operation", "instrumentId", "requestFingerprint", "rejection"]
        .every((key) => Object.prototype.hasOwnProperty.call(observation, key))
      || observation.operation !== boot.pendingEffect.operation
      || observation.requestFingerprint !== boot.pendingEffect.requestFingerprint
      || typeof observation.instrumentId !== "string" || observation.instrumentId.length === 0) {
    throw new TypeError("Canonical reconciliation rejection authority mismatch");
  }
  const raw = observation.rejection;
  if (typeof raw !== "object" || raw === null) throw new TypeError("Missing canonical rejection");
  const rejection = observation.operation === "ENTRY_SUBMISSION"
    ? createEntryRejection(raw)
    : observation.operation === "PROTECTION_SUBMISSION"
      ? createProtectionRejection(raw as import("@ulte/execution-engine").ProtectionRejection)
      : createCancellationRejection(raw as import("@ulte/execution-engine").CancellationRejection);
  if (Object.keys(raw).length !== Object.keys(rejection).length
      || Object.keys(rejection).some((key) =>
        (raw as unknown as Record<string, unknown>)[key] !==
          (rejection as unknown as Record<string, unknown>)[key])
      || rejection.executionAttemptId !== boot.pendingEffect.executionAttemptId
      || rejection.idempotencyKey !== boot.pendingEffect.idempotencyKey) {
    throw new TypeError("Noncanonical reconciliation rejection payload");
  }
  if (observation.operation === "ENTRY_SUBMISSION" && rejection.kind === "SUBMISSION_REJECTED") {
    const { kind: _kind, ...payload } = rejection;
    return { kind: "ENTRY_SUBMISSION_REJECTED", rejection: payload };
  }
  if (observation.operation === "PROTECTION_SUBMISSION" && rejection.kind === "PROTECTION_REJECTED") {
    const { kind: _kind, ...payload } = rejection;
    return { kind: "PROTECTION_REJECTED", rejection: payload };
  }
  if (observation.operation === "ENTRY_CANCELLATION" && rejection.kind === "CANCEL_REJECTED") {
    const { kind: _kind, ...payload } = rejection;
    return { kind: "ENTRY_CANCELLATION_REJECTED", rejection: payload };
  }
  throw new TypeError("Canonical rejection operation mismatch");
}
function outcome(boot: Intent | Reconciliation, key: string, at: UnixMs,
  observation: OrchestrationExternalOutcome["observation"]): OrchestrationExternalOutcome {
  return createOrchestrationExternalOutcome({ schemaVersion: "ORCHESTRATION_EXTERNAL_OUTCOME_V1",
    outcomeKey: orchestrationOutcomeKey(key), sessionId: boot.sessionId,
    executionAttemptId: boot.pendingEffect.executionAttemptId, observedAt: unixMs(at),
    observedFence: boot.fenceToken, pendingEffectIdentity: identity(boot), observation });
}
function update(boot: Intent | Reconciliation, status: "SUBMITTED" | "OUTCOME_UNKNOWN"
  | "RETRY_AUTHORIZED" | "CONFIRMED" | "REJECTED", at: UnixMs, adapterOrderId?: string) {
  const p = boot.pendingEffect;
  return { adapterId: p.adapterId, environment: p.environment, idempotencyKey: p.idempotencyKey,
    requestFingerprint: p.requestFingerprint, status, updatedAt: unixMs(at),
    ...(adapterOrderId === undefined ? {} : { adapterOrderId }) };
}
async function invoke(adapter: BrokerAdapter, operation: Operation, request: Submission): Promise<AdapterResponse> {
  if (operation === "ENTRY_SUBMISSION") return adapter.submitEntry(request as EntrySubmissionRequest);
  if (operation === "PROTECTION_SUBMISSION") return adapter.submitProtection(request as ProtectionRequest);
  return adapter.cancelEntry(request as EntryCancellationRequest);
}

export class RecoverableOrchestrationRuntime {
  public constructor(private readonly port: RecoverablePersistencePort) {}

  public boot(sessionId: OrchestrationSessionId, ownerId: string): Promise<PostgresRecoveryBootResult> {
    return this.port.boot.boot(sessionId, ownerId);
  }

  public async submit(input: RecoverableSubmissionInput): Promise<RecoverableRuntimeResult> {
    assertBrokerAdapterConformance(input.adapter);
    const boot = await this.boot(input.sessionId, input.ownerId);
    if (boot.status === "TERMINAL_NON_SUBMISSION") return { status: "TERMINAL_NON_SUBMISSION" };
    if (boot.status !== "INTENT_DISPOSITION_REQUIRED"
        || (boot.idempotency.status !== "ABSENT"
          && !(input.explicitSameKeyRetry === true && boot.idempotency.status === "PRESENT"
            && boot.idempotency.record.status === "RETRY_AUTHORIZED"))
        || !matches(boot, input.adapter, input.request)
        || input.currentCheckpoint.checkpointRef !== boot.checkpointRef
        || input.currentRecoveryState.executionAuthorityCheckpointRef !== boot.checkpointRef)
      return blocked(boot);
    const a = authority(boot);
    const claim = await this.port.pending.claimPendingIdempotency({ ...a, claim: {
      ...identity(boot), claimedAt: unixMs(input.claimedAt) } });
    if (claim.status !== "PERSISTED") return lost(claim);
    if (claim.result.status !== "CLAIMED_NEW"
        && !(input.explicitSameKeyRetry === true && claim.result.status === "EXISTING_SAME_REQUEST"
          && claim.result.record.status === "RETRY_AUTHORIZED"))
      return blocked(await this.boot(input.sessionId, input.ownerId));
    const marker = await this.port.pending.recordPendingIdempotencyOutcome({ ...a,
      update: update(boot, "SUBMITTED", input.submittedAt) });
    if (marker.status !== "PERSISTED") return lost(marker);
    if (marker.result.status !== "APPLIED_TRANSITION") return blocked(await this.boot(input.sessionId, input.ownerId));
    // This separate, committed fenced check reauthorizes the action after the boot snapshot.
    const current = await this.port.pending.recordPendingIdempotencyOutcome({ ...a,
      update: update(boot, "SUBMITTED", input.submittedAt) });
    if (current.status !== "PERSISTED") return lost(current);
    if (current.result.record.status !== "SUBMITTED") return blocked(await this.boot(input.sessionId, input.ownerId));

    let response: AdapterResponse | undefined;
    let failure: BrokerFailure | null = null;
    try { response = await invoke(input.adapter, boot.pendingEffect.operation, input.request); }
    catch (cause) { failure = typedFailure(cause); }
    if (failure !== null && classifyRetryDisposition(failure) === "DO_NOT_RETRY"
        && failure.certainty === "DEFINITE_FAILURE" && failure.submissionExposure === "NOT_SUBMITTED") {
      const d: NormalTerminalNonSubmissionRequest["disposition"] = {
        dispositionRef: input.terminalDispositionRef as NormalTerminalNonSubmissionRequest["disposition"]["dispositionRef"],
        sessionId: boot.sessionId, executionAttemptId: boot.pendingEffect.executionAttemptId,
        pendingEffectIdentity: identity(boot), pendingCreatedRevision: boot.pendingEffect.createdRevision,
        pendingCreatedFence: boot.pendingEffect.createdFence, pendingCreationRef: boot.creationRef,
        expectedRecoveryRevision: boot.recoveryRevision,
        committedRevision: (boot.recoveryRevision + 1) as NormalTerminalNonSubmissionRequest["disposition"]["committedRevision"],
        executionAuthorityCheckpointRefBefore: a.expectedCheckpointRef,
        executionAuthorityCheckpointRefAfter: a.expectedCheckpointRef,
        executionAuthorityIdentity: input.currentCheckpoint.evidence.identity,
        mode: input.currentRecoveryState.mode, instrumentId: input.currentRecoveryState.instrumentId,
        riskBasisCheckpointRef: input.currentRecoveryState.riskBasisCheckpointRef,
        latestROutcomeRef: input.currentRecoveryState.latestROutcomeRef,
        proof: { schemaVersion: "TERMINAL_NON_SUBMISSION_PROOF_V1", sourceKind: "TRUSTED_ADAPTER_FAILURE",
          sourceEventRef: input.failureEventRef, observedAt: unixMs(input.observedAt),
          category: failure.category, certainty: "DEFINITE_FAILURE", submissionExposure: "NOT_SUBMITTED",
          retryDisposition: "DO_NOT_RETRY", pendingEffectIdentity: identity(boot),
          ...(failure.adapterReasonCode === undefined ? {} : { adapterReasonCode: failure.adapterReasonCode }) },
        sessionDisposition: "TERMINAL_NON_SUBMISSION",
        resolution: { kind: "TERMINAL_NON_SUBMISSION",
          resolvedRevision: (boot.recoveryRevision + 1) as NormalTerminalNonSubmissionRequest["disposition"]["committedRevision"] },
      };
      try { await this.port.terminal.commitNormalTerminalNonSubmissionDisposition({ ownerId: boot.ownerId,
        expectedFence: boot.fenceToken, disposition: d, brokerStatusUpdatedAt: unixMs(input.observedAt) }); }
      catch (cause) {
        if (cause instanceof TerminalCommitError) return blocked(await this.boot(input.sessionId, input.ownerId));
        throw cause;
      }
      return { status: "TERMINAL_NON_SUBMISSION" };
    }
    if (failure !== null && classifyRetryDisposition(failure) === "RETRY_SAFE"
        && failure.certainty === "DEFINITE_FAILURE" && failure.submissionExposure === "NOT_SUBMITTED") {
      const persisted = await this.port.pending.recordPendingIdempotencyOutcome({ ...a,
        update: update(boot, "RETRY_AUTHORIZED", input.observedAt) });
      return persisted.status === "PERSISTED" ? { status: "RETRY_AUTHORIZED" } : lost(persisted);
    }
    if (failure !== null || response === undefined) {
      const persisted = await this.port.pending.recordPendingIdempotencyOutcome({ ...a,
        update: update(boot, "OUTCOME_UNKNOWN", input.observedAt) });
      return persisted.status === "PERSISTED" ? { status: "RECONCILIATION_REQUIRED" } : lost(persisted);
    }
    let canonicalOutcome: OrchestrationExternalOutcome;
    try { canonicalOutcome = outcome(boot, input.outcomeKey, input.observedAt,
      { kind: "CANONICAL_EXECUTION_TRANSITION",
        transition: canonical(boot.pendingEffect.operation, response, input.request) }); }
    catch {
      const persisted = await this.port.pending.recordPendingIdempotencyOutcome({ ...a,
        update: update(boot, "OUTCOME_UNKNOWN", input.observedAt) });
      return persisted.status === "PERSISTED" ? { status: "RECONCILIATION_REQUIRED" } : lost(persisted);
    }
    if (canonicalOutcome.observation.kind !== "CANONICAL_EXECUTION_TRANSITION") throw new TypeError("Canonical outcome missing");
    const transition = canonicalOutcome.observation.transition;
    const accepted = transition.kind.endsWith("ACKNOWLEDGED");
    const payload = "acknowledgement" in transition ? transition.acknowledgement
      : "rejection" in transition ? transition.rejection : null;
    const orderId = payload !== null && "adapterOrderId" in payload ? payload.adapterOrderId : undefined;
    const saved = await this.port.pending.persistPendingTerminalOutcome({ ...a,
      update: update(boot, accepted ? "CONFIRMED" : "REJECTED", input.observedAt, orderId),
      outcome: canonicalOutcome });
    if (saved.status !== "PERSISTED") return lost(saved);
    const adopted = await this.port.adoption.adoptOutcome({ sessionId: boot.sessionId,
      ownerId: boot.ownerId, expectedRevision: boot.recoveryRevision, expectedFence: boot.fenceToken,
      previousCheckpointRef: a.expectedCheckpointRef, outcomeKey: canonicalOutcome.outcomeKey,
      committedCheckpoint: input.adoptedCheckpoint, resultingRecoveryState: input.adoptedRecoveryState,
      nextPendingEffectIdentity: null });
    return adopted.status === "ADOPTED" || adopted.status === "ALREADY_ADOPTED"
      ? { status: "ADOPTED", outcomeKey: canonicalOutcome.outcomeKey, outcome: canonicalOutcome }
      : { status: "OUTCOME_AVAILABLE", outcome: canonicalOutcome };
  }

  /** Reboot can adopt an already durable canonical outcome without calling the adapter again. */
  public async adoptAvailable(input: RecoverableAdoptionInput): Promise<RecoverableRuntimeResult> {
    const boot = await this.boot(input.sessionId, input.ownerId);
    if (boot.status === "TERMINAL_NON_SUBMISSION") return { status: "TERMINAL_NON_SUBMISSION" };
    if (boot.status !== "OUTCOME_AVAILABLE" || boot.checkpointRef === null) return blocked(boot);
    const adopted = await this.port.adoption.adoptOutcome({ sessionId: boot.sessionId,
      ownerId: boot.ownerId, expectedRevision: boot.recoveryRevision, expectedFence: boot.fenceToken,
      previousCheckpointRef: boot.checkpointRef, outcomeKey: boot.outcomeKey,
      committedCheckpoint: input.adoptedCheckpoint, resultingRecoveryState: input.adoptedRecoveryState,
      nextPendingEffectIdentity: null });
    return adopted.status === "ADOPTED" || adopted.status === "ALREADY_ADOPTED"
      ? { status: "ADOPTED", outcomeKey: boot.outcomeKey } : blocked(await this.boot(input.sessionId, input.ownerId));
  }

  public async reconcile(input: RecoverableReconciliationInput): Promise<RecoverableRuntimeResult> {
    if ((input.adoptedCheckpoint === undefined) !== (input.adoptedRecoveryState === undefined)) {
      throw new TypeError("Canonical reconciliation adoption authority must be complete");
    }
    const boot = await this.boot(input.sessionId, input.ownerId);
    if (boot.status === "TERMINAL_NON_SUBMISSION") return { status: "TERMINAL_NON_SUBMISSION" };
    if (boot.status !== "RECONCILIATION_REQUIRED" || boot.pendingEffect.environment !== "SANDBOX") return blocked(boot);
    const a = authority(boot);
    const preflight = await this.port.pending.recordPendingIdempotencyOutcome({ ...a,
      update: update(boot, "OUTCOME_UNKNOWN", input.observedAt) });
    if (preflight.status !== "PERSISTED") return lost(preflight);
    let observation: Awaited<ReturnType<ReconciliationProvider["reconcile"]>>;
    try { observation = await input.provider.reconcile(createReconciliationRequest({
      ...identity(boot), ...(boot.idempotency.record.adapterOrderId === undefined ? {}
        : { adapterOrderId: boot.idempotency.record.adapterOrderId }) })); }
    catch { return { status: "RECONCILIATION_REQUIRED" }; }
    if (observation.status === "CONFIRMED_REJECTED_WITH_CANONICAL") {
      const transition = exactCanonicalRejection(observation, boot);
      const canonicalOutcome = outcome(boot, input.outcomeKey, input.observedAt,
        { kind: "CANONICAL_EXECUTION_TRANSITION", transition });
      const orderId = "rejection" in transition && "adapterOrderId" in transition.rejection
        ? transition.rejection.adapterOrderId : undefined;
      const saved = await this.port.pending.persistPendingTerminalOutcome({ ...a,
        update: update(boot, "REJECTED", input.observedAt, orderId), outcome: canonicalOutcome,
        canonicalInstrumentId: observation.instrumentId });
      if (saved.status !== "PERSISTED") return lost(saved);
      if (input.adoptedCheckpoint === undefined || input.adoptedRecoveryState === undefined) {
        return { status: "OUTCOME_AVAILABLE", outcome: canonicalOutcome };
      }
      const adopted = await this.port.adoption.adoptOutcome({ sessionId: boot.sessionId,
        ownerId: boot.ownerId, expectedRevision: boot.recoveryRevision, expectedFence: boot.fenceToken,
        previousCheckpointRef: a.expectedCheckpointRef, outcomeKey: canonicalOutcome.outcomeKey,
        committedCheckpoint: input.adoptedCheckpoint,
        resultingRecoveryState: input.adoptedRecoveryState, nextPendingEffectIdentity: null });
      return adopted.status === "ADOPTED" || adopted.status === "ALREADY_ADOPTED"
        ? { status: "ADOPTED", outcomeKey: canonicalOutcome.outcomeKey, outcome: canonicalOutcome }
        : { status: "OUTCOME_AVAILABLE", outcome: canonicalOutcome };
    }
    const status = observation.status;
    const disposition = outcome(boot, input.outcomeKey, input.observedAt,
      { kind: "BROKER_DISPOSITION", disposition: observation });
    const mapped = status === "CONFIRMED_ACCEPTED" ? "CONFIRMED"
      : status === "CONFIRMED_REJECTED" ? "REJECTED"
        : status === "CONFIRMED_NOT_SUBMITTED" ? "RETRY_AUTHORIZED" : "OUTCOME_UNKNOWN";
    const stored = await this.port.pending.persistPendingReconciliationObservation({ ...a,
      update: update(boot, mapped, input.observedAt,
        "adapterOrderId" in observation ? observation.adapterOrderId : undefined),
      outcome: disposition });
    if (stored.status !== "PERSISTED") return lost(stored);
    if (status === "CONFIRMED_NOT_SUBMITTED") return { status: "RETRY_AUTHORIZED", outcome: disposition };
    if (status === "STILL_UNKNOWN") return { status: "RECONCILIATION_REQUIRED", outcome: disposition };
    return { status: "CANONICAL_OUTCOME_REQUIRED", outcome: disposition };
  }
}

export function createPostgresRecoverableOrchestrationRuntime(executor: PostgresSnapshotExecutor,
  target: MigrationTarget): RecoverableOrchestrationRuntime {
  return new RecoverableOrchestrationRuntime({
    boot: new PostgresRecoveryBootLoader(executor, target),
    pending: new PostgresOrchestrationFencedWriterService(executor),
    terminal: new PostgresTerminalNonSubmissionCommitService(executor, target),
    adoption: new PostgresOrchestrationCommitService(executor),
  });
}
