import {
  claimIdempotencyInTransaction, recordIdempotencyOutcomeInTransaction,
  PersistenceConflictError as IdempotencyPersistenceConflictError,
  PersistenceCorruptionError as IdempotencyPersistenceCorruptionError,
} from "@ulte/execution-store-postgres";
import {
  createOrchestrationExternalOutcome, createOrchestrationPendingEffectIdentity,
  equalCanonicalJson, executionAuthorityCheckpointId, orchestrationFenceToken,
  orchestrationLeaseOwnerId, orchestrationRevision, orchestrationSessionId,
  type ExecutionAuthorityCheckpoint, type ExecutionAuthorityCheckpointId, type OrchestrationExternalOutcome,
  type OrchestrationFenceToken, type OrchestrationLeaseOwnerId,
  type OrchestrationPendingEffect, type OrchestrationPendingEffectIdentity,
  type OrchestrationRevision, type OrchestrationSessionId,
} from "@ulte/orchestration-state-store";
import { loadExecutionAuthorityCheckpointInTransaction } from "./checkpoint-store.js";
import { appendOutcomeInTransaction, listExecutionOutcomesInTransaction,
  loadPendingEffectForUpdateInTransaction } from "./effect-store.js";
import { PersistenceConflictError, PersistenceCorruptionError, PersistenceInfrastructureError } from "./errors.js";
import { assertActiveRecoveryLeaseInTransaction } from "./lease-store.js";
import { loadRecoveryStateForUpdateInTransaction } from "./recovery-store.js";
import { loadAdoptionCreationProofInTransaction,
  loadPendingIntentCommitReceiptInTransaction } from "./receipt-store.js";
import type { PostgresExecutor, PostgresTransaction } from "./postgres.js";

type ClaimInput = Parameters<typeof claimIdempotencyInTransaction>[1];
type StatusInput = Parameters<typeof recordIdempotencyOutcomeInTransaction>[1];
type ClaimResult = Awaited<ReturnType<typeof claimIdempotencyInTransaction>>;
type StatusResult = Awaited<ReturnType<typeof recordIdempotencyOutcomeInTransaction>>;
type OutcomeResult = Awaited<ReturnType<typeof appendOutcomeInTransaction>>;

/** Fresh recoverable mutations require these current facts; creation revision/fence come from the locked row. */
export interface PendingWriterAuthority {
  readonly sessionId: OrchestrationSessionId;
  readonly ownerId: OrchestrationLeaseOwnerId;
  readonly expectedFence: OrchestrationFenceToken;
  readonly expectedRecoveryRevision: OrchestrationRevision;
  readonly expectedCheckpointRef: ExecutionAuthorityCheckpointId;
  readonly pendingEffectIdentity: OrchestrationPendingEffectIdentity;
}
export type PendingWriterFailure =
  | Readonly<{ readonly status: "LEASE_LOST" | "RECOVERY_NOT_FOUND" | "CHECKPOINT_CONFLICT"
      | "TERMINAL_STATE_CONFLICT"
      | "PENDING_NOT_FOUND" | "PENDING_IDENTITY_CONFLICT" | "PENDING_CREATION_PROOF_MISSING"
      | "IDEMPOTENCY_CONFLICT" | "OUTCOME_CONFLICT" }>
  | Readonly<{ readonly status: "FENCE_CONFLICT"; readonly currentFence: OrchestrationFenceToken }>
  | Readonly<{ readonly status: "REVISION_CONFLICT"; readonly currentRevision: OrchestrationRevision }>;
export type PendingWriterResult<T> = Readonly<{ readonly status: "PERSISTED"; readonly result: T }> | PendingWriterFailure;
export interface PendingClaimRequest extends PendingWriterAuthority { readonly claim: ClaimInput }
export interface PendingStatusRequest extends PendingWriterAuthority { readonly update: StatusInput }
export interface PendingOutcomeRequest extends PendingWriterAuthority { readonly outcome: OrchestrationExternalOutcome }
export interface PendingTerminalRequest extends PendingWriterAuthority {
  readonly update: StatusInput;
  readonly outcome: OrchestrationExternalOutcome;
}
export interface PendingReconciliationRequest extends PendingWriterAuthority {
  readonly update: StatusInput;
  readonly outcome: OrchestrationExternalOutcome | null;
}

class RollbackResult extends Error {
  public constructor(public readonly result: PendingWriterFailure) { super("Rollback fenced pending writer"); }
}
function rollback(result: PendingWriterFailure): never { throw new RollbackResult(result); }
function failure(status: Exclude<PendingWriterFailure["status"], "FENCE_CONFLICT" | "REVISION_CONFLICT">): PendingWriterFailure {
  return { status } as PendingWriterFailure;
}
function identity(effect: OrchestrationPendingEffect): OrchestrationPendingEffectIdentity {
  const { adapterId, environment, operation, executionAttemptId, idempotencyKey, requestFingerprint } = effect;
  return { adapterId, environment, operation, executionAttemptId, idempotencyKey, requestFingerprint };
}
function sameIdentity(left: OrchestrationPendingEffectIdentity, right: OrchestrationPendingEffectIdentity): boolean {
  return equalCanonicalJson(left, right);
}
function authority(input: PendingWriterAuthority): PendingWriterAuthority {
  return { sessionId: orchestrationSessionId(input.sessionId), ownerId: orchestrationLeaseOwnerId(input.ownerId),
    expectedFence: orchestrationFenceToken(input.expectedFence),
    expectedRecoveryRevision: orchestrationRevision(input.expectedRecoveryRevision),
    expectedCheckpointRef: executionAuthorityCheckpointId(input.expectedCheckpointRef),
    pendingEffectIdentity: createOrchestrationPendingEffectIdentity(input.pendingEffectIdentity) };
}

async function creationProof(tx: PostgresTransaction, request: PendingWriterAuthority,
  pending: OrchestrationPendingEffect, currentCheckpoint: ExecutionAuthorityCheckpoint): Promise<PendingWriterFailure | null> {
  const checkHistory = async (createdRef: ExecutionAuthorityCheckpointId): Promise<void> => {
    const created = await loadExecutionAuthorityCheckpointInTransaction(tx, createdRef);
    if (created === null) throw new PersistenceCorruptionError("Creation receipt references a missing checkpoint");
    const first = created.evidence, latest = currentCheckpoint.evidence;
    if (first.schemaVersion !== latest.schemaVersion || !equalCanonicalJson(first.identity, latest.identity)
        || !equalCanonicalJson(first.initialization, latest.initialization)
        || first.transitions.length > latest.transitions.length
        || !first.transitions.every((transition, index) => equalCanonicalJson(transition, latest.transitions[index]))) {
      throw new PersistenceCorruptionError("Current execution checkpoint does not descend from pending creation");
    }
  };
  const standalone = await loadPendingIntentCommitReceiptInTransaction(tx,
    pending.adapterId, pending.idempotencyKey);
  if (standalone !== null) {
    if (standalone.sessionId !== request.sessionId || standalone.committedRevision !== pending.createdRevision
        || standalone.committedFence !== pending.createdFence
        || !equalCanonicalJson(standalone.pendingEffect, pending)
        || standalone.resultingRecoveryState.executionAuthorityCheckpointRef !== standalone.committedCheckpointRef) {
      throw new PersistenceCorruptionError("Standalone pending creation proof contradicts pending effect");
    }
    if (pending.createdRevision === request.expectedRecoveryRevision
        && standalone.committedCheckpointRef !== request.expectedCheckpointRef) {
      throw new PersistenceCorruptionError("Creation checkpoint contradicts current recovery checkpoint");
    }
    await checkHistory(standalone.committedCheckpointRef);
    return null;
  }
  const nested = await loadAdoptionCreationProofInTransaction(tx, request.sessionId,
    pending.createdRevision, request.pendingEffectIdentity);
  if (nested.status === "MISSING") return failure("PENDING_CREATION_PROOF_MISSING");
  const receipt = nested.receipt;
  if (receipt.nextPendingEffect === null || receipt.nextPendingCommit === null
      || receipt.adoptedFence !== pending.createdFence
      || !equalCanonicalJson(receipt.nextPendingEffect, pending)
      || !equalCanonicalJson(receipt.nextPendingCommit.pendingEffect, pending)
      || receipt.nextPendingCommit.committedCheckpointRef !== receipt.committedCheckpointRef
      || receipt.resultingRecoveryState.executionAuthorityCheckpointRef !== receipt.committedCheckpointRef) {
    throw new PersistenceCorruptionError("Adoption pending creation proof contradicts pending effect");
  }
  if (pending.createdRevision === request.expectedRecoveryRevision
      && receipt.committedCheckpointRef !== request.expectedCheckpointRef) {
    throw new PersistenceCorruptionError("Adoption checkpoint contradicts current recovery checkpoint");
  }
  await checkHistory(receipt.committedCheckpointRef);
  return null;
}

async function prefix(tx: PostgresTransaction, request: PendingWriterAuthority): Promise<PendingWriterFailure | null> {
  const lease = await assertActiveRecoveryLeaseInTransaction(tx, request);
  if (lease.status !== "ACTIVE") return lease;
  const recovery = await loadRecoveryStateForUpdateInTransaction(tx, request.sessionId);
  if (recovery === null) return failure("RECOVERY_NOT_FOUND");
  if (recovery.schemaVersion === "ORCHESTRATION_RECOVERY_RECORD_V2") return failure("TERMINAL_STATE_CONFLICT");
  if (recovery.fenceToken !== request.expectedFence) {
    throw new PersistenceCorruptionError("Lease/recovery fence incoherence");
  }
  if (recovery.revision !== request.expectedRecoveryRevision) {
    return { status: "REVISION_CONFLICT", currentRevision: recovery.revision };
  }
  if (recovery.executionAuthorityCheckpointRef !== request.expectedCheckpointRef) return failure("CHECKPOINT_CONFLICT");
  const checkpoint = await loadExecutionAuthorityCheckpointInTransaction(tx, request.expectedCheckpointRef);
  if (checkpoint === null || recovery.executionAuthorityIdentity === null
      || !equalCanonicalJson(checkpoint.evidence.identity, recovery.executionAuthorityIdentity)
      || checkpoint.evidence.identity.instrumentId !== recovery.instrumentId) {
    throw new PersistenceCorruptionError("Recovery execution checkpoint identity incoherence");
  }
  const pending = await loadPendingEffectForUpdateInTransaction(tx, request.pendingEffectIdentity);
  if (pending === null) return failure("PENDING_NOT_FOUND");
  if (pending.sessionId !== request.sessionId || !sameIdentity(identity(pending), request.pendingEffectIdentity)
      || pending.state !== "PENDING" || pending.resolvedOutcomeKey !== null
      || pending.resolvedRevision !== null || pending.resolvedFence !== null) {
    return failure("PENDING_IDENTITY_CONFLICT");
  }
  if (pending.environment !== recovery.mode
      || pending.executionAttemptId !== recovery.executionAuthorityIdentity.executionAttemptId
      || pending.createdRevision > recovery.revision || pending.createdFence > recovery.fenceToken) {
    throw new PersistenceCorruptionError("Pending effect contradicts current recovery authority");
  }
  return creationProof(tx, request, pending, checkpoint);
}

function assertIdentity(input: ClaimInput | StatusInput, expected: OrchestrationPendingEffectIdentity): void {
  if (input.adapterId !== expected.adapterId || input.environment !== expected.environment
      || input.idempotencyKey !== expected.idempotencyKey
      || input.requestFingerprint !== expected.requestFingerprint
      || ("executionAttemptId" in input && input.executionAttemptId !== expected.executionAttemptId)
      || ("operation" in input && input.operation !== expected.operation)) {
    throw new TypeError("Idempotency mutation does not match locked pending identity");
  }
}
function transitionDisposition(outcome: OrchestrationExternalOutcome): "ACCEPTED" | "REJECTED" | null {
  if (outcome.observation.kind !== "CANONICAL_EXECUTION_TRANSITION") return null;
  const kind = outcome.observation.transition.kind;
  return kind.endsWith("ACKNOWLEDGED") ? "ACCEPTED" : kind.endsWith("REJECTED") ? "REJECTED" : null;
}
function compatible(existing: OrchestrationExternalOutcome, candidate: OrchestrationExternalOutcome): boolean {
  if (equalCanonicalJson(existing, candidate)) return true;
  if (existing.outcomeKey === candidate.outcomeKey) return false;
  const left = existing.observation, right = candidate.observation;
  if (left.kind === "CANONICAL_EXECUTION_TRANSITION" && right.kind === "CANONICAL_EXECUTION_TRANSITION") return false;
  const canonical = left.kind === "CANONICAL_EXECUTION_TRANSITION" ? existing
    : right.kind === "CANONICAL_EXECUTION_TRANSITION" ? candidate : null;
  const disposition = left.kind === "BROKER_DISPOSITION" ? left.disposition
    : right.kind === "BROKER_DISPOSITION" ? right.disposition : null;
  if (canonical !== null && disposition !== null) {
    if (disposition.status === "CONFIRMED_NOT_SUBMITTED") return false;
    if (disposition.status === "STILL_UNKNOWN") return true;
    if (transitionDisposition(canonical) !== (disposition.status === "CONFIRMED_ACCEPTED" ? "ACCEPTED" : "REJECTED")) {
      return false;
    }
    const transition = canonical.observation;
    if (transition.kind !== "CANONICAL_EXECUTION_TRANSITION") return false;
    const payload = "acknowledgement" in transition.transition ? transition.transition.acknowledgement
      : "rejection" in transition.transition ? transition.transition.rejection : null;
    return disposition.adapterOrderId === undefined || payload === null
      || !("adapterOrderId" in payload) || payload.adapterOrderId === disposition.adapterOrderId;
  }
  if (left.kind !== "BROKER_DISPOSITION" || right.kind !== "BROKER_DISPOSITION") return false;
  const a = left.disposition, b = right.disposition;
  if (a.status === "STILL_UNKNOWN" || b.status === "STILL_UNKNOWN") {
    const known = a.status === "STILL_UNKNOWN" ? a : b;
    const later = a.status === "STILL_UNKNOWN" ? b : a;
    const knownOrderId = "adapterOrderId" in known ? known.adapterOrderId : undefined;
    const laterOrderId = "adapterOrderId" in later ? later.adapterOrderId : undefined;
    return knownOrderId === undefined || later.status !== "CONFIRMED_NOT_SUBMITTED"
      && (laterOrderId === undefined || laterOrderId === knownOrderId);
  }
  const firstOrderId = "adapterOrderId" in a ? a.adapterOrderId : undefined;
  const secondOrderId = "adapterOrderId" in b ? b.adapterOrderId : undefined;
  return a.status === b.status && (firstOrderId === undefined || secondOrderId === undefined
    || firstOrderId === secondOrderId);
}
async function append(tx: PostgresTransaction, request: PendingWriterAuthority,
  input: OrchestrationExternalOutcome): Promise<OutcomeResult | PendingWriterFailure> {
  const outcome = createOrchestrationExternalOutcome(input);
  if (outcome.sessionId !== request.sessionId
      || outcome.executionAttemptId !== request.pendingEffectIdentity.executionAttemptId
      || outcome.pendingEffectIdentity === null
      || !sameIdentity(outcome.pendingEffectIdentity, request.pendingEffectIdentity)
      || outcome.observedFence > request.expectedFence) {
    return failure("PENDING_IDENTITY_CONFLICT");
  }
  const prior = await listExecutionOutcomesInTransaction(tx, request.sessionId, outcome.executionAttemptId);
  for (const existing of prior) {
    if (existing.pendingEffectIdentity !== null
        && sameIdentity(existing.pendingEffectIdentity, request.pendingEffectIdentity)
        && !compatible(existing, outcome)) return failure("OUTCOME_CONFLICT");
  }
  const result = await appendOutcomeInTransaction(tx, outcome);
  return result.status === "OUTCOME_CONFLICT" ? failure("OUTCOME_CONFLICT") : result;
}
function terminalCoherence(update: StatusInput, outcome: OrchestrationExternalOutcome): void {
  if (outcome.observation.kind !== "CANONICAL_EXECUTION_TRANSITION") {
    throw new TypeError("Terminal persistence requires a canonical execution transition");
  }
  const disposition = transitionDisposition(outcome);
  if (disposition === null || update.status !== (disposition === "ACCEPTED" ? "CONFIRMED" : "REJECTED")) {
    throw new TypeError("Terminal idempotency status contradicts canonical transition");
  }
}
function reconciliationCoherence(update: StatusInput, outcome: OrchestrationExternalOutcome | null): void {
  if (outcome === null) {
    if (update.status !== "OUTCOME_UNKNOWN") {
      throw new TypeError("Confirmed reconciliation requires a broker disposition");
    }
    return;
  }
  if (outcome.observation.kind !== "BROKER_DISPOSITION") throw new TypeError("Reconciliation cannot create canonical evidence");
  const status = outcome.observation.disposition.status;
  const expected = status === "CONFIRMED_ACCEPTED" ? "CONFIRMED"
    : status === "CONFIRMED_REJECTED" ? "REJECTED"
      : status === "STILL_UNKNOWN" ? "OUTCOME_UNKNOWN" : "RETRY_AUTHORIZED";
  if (update.status !== expected) throw new TypeError("Reconciliation status contradicts disposition");
  if (outcome.observation.disposition.status !== "CONFIRMED_NOT_SUBMITTED"
      && outcome.observation.disposition.adapterOrderId !== undefined
      && update.adapterOrderId !== outcome.observation.disposition.adapterOrderId) {
    throw new TypeError("Reconciliation adapter order identity mismatch");
  }
}

/** Only intended recoverable writer entry point. Generic stores remain available for other callers. */
export class PostgresOrchestrationFencedWriterService {
  public constructor(private readonly executor: PostgresExecutor) {}

  private async run<T>(input: PendingWriterAuthority,
    work: (tx: PostgresTransaction, request: PendingWriterAuthority) => Promise<T | PendingWriterFailure>):
    Promise<PendingWriterResult<T>> {
    const request = authority(input);
    try {
      return await this.executor.transaction(async (tx) => {
        const denied = await prefix(tx, request);
        if (denied !== null) return denied;
        const result = await work(tx, request);
        if (typeof result === "object" && result !== null && "status" in result
            && ["IDEMPOTENCY_CONFLICT", "OUTCOME_CONFLICT", "PENDING_IDENTITY_CONFLICT"].includes(String(result.status))) {
          rollback(result as PendingWriterFailure);
        }
        const finalLease = await assertActiveRecoveryLeaseInTransaction(tx, request);
        if (finalLease.status !== "ACTIVE") rollback(finalLease);
        return { status: "PERSISTED", result: result as T } as const;
      });
    } catch (cause) {
      if (cause instanceof RollbackResult) return cause.result;
      if (cause instanceof PersistenceCorruptionError || cause instanceof PersistenceConflictError
          || cause instanceof PersistenceInfrastructureError
          || cause instanceof IdempotencyPersistenceCorruptionError
          || cause instanceof IdempotencyPersistenceConflictError
          || cause instanceof TypeError || cause instanceof RangeError) throw cause;
      throw new PersistenceInfrastructureError("PostgreSQL fenced pending writer failed", { cause });
    }
  }

  public claimPendingIdempotency(input: PendingClaimRequest): Promise<PendingWriterResult<ClaimResult>> {
    assertIdentity(input.claim, input.pendingEffectIdentity);
    return this.run(input, async (tx) => {
      const result = await claimIdempotencyInTransaction(tx, input.claim);
      return result.status === "CONFLICT" ? failure("IDEMPOTENCY_CONFLICT") : result;
    });
  }
  public recordPendingIdempotencyOutcome(input: PendingStatusRequest): Promise<PendingWriterResult<StatusResult>> {
    assertIdentity(input.update, input.pendingEffectIdentity);
    return this.run(input, async (tx, request) => {
      const result = await recordIdempotencyOutcomeInTransaction(tx,
        { ...input.update, executionAttemptId: request.pendingEffectIdentity.executionAttemptId,
          operation: request.pendingEffectIdentity.operation });
      return result.status === "STATUS_CONFLICT" ? failure("IDEMPOTENCY_CONFLICT") : result;
    });
  }
  public appendPendingOutcome(input: PendingOutcomeRequest): Promise<PendingWriterResult<OutcomeResult>> {
    return this.run(input, (tx, request) => append(tx, request, input.outcome));
  }
  public persistPendingTerminalOutcome(input: PendingTerminalRequest):
    Promise<PendingWriterResult<Readonly<{ readonly idempotency: StatusResult; readonly outcome: OutcomeResult }>>> {
    assertIdentity(input.update, input.pendingEffectIdentity);
    terminalCoherence(input.update, input.outcome);
    return this.run(input, async (tx, request) => {
      const idempotency = await recordIdempotencyOutcomeInTransaction(tx,
        { ...input.update, executionAttemptId: request.pendingEffectIdentity.executionAttemptId,
          operation: request.pendingEffectIdentity.operation });
      if (idempotency.status === "STATUS_CONFLICT") return failure("IDEMPOTENCY_CONFLICT");
      const outcome = await append(tx, request, input.outcome);
      if ("status" in outcome && outcome.status === "OUTCOME_CONFLICT"
          || "status" in outcome && outcome.status === "PENDING_IDENTITY_CONFLICT") return outcome;
      return { idempotency, outcome: outcome as OutcomeResult };
    });
  }
  public persistPendingReconciliationObservation(input: PendingReconciliationRequest):
    Promise<PendingWriterResult<Readonly<{ readonly idempotency: StatusResult; readonly outcome: OutcomeResult | null }>>> {
    assertIdentity(input.update, input.pendingEffectIdentity);
    reconciliationCoherence(input.update, input.outcome);
    return this.run(input, async (tx, request) => {
      const idempotency = await recordIdempotencyOutcomeInTransaction(tx,
        { ...input.update, executionAttemptId: request.pendingEffectIdentity.executionAttemptId,
          operation: request.pendingEffectIdentity.operation });
      if (idempotency.status === "STATUS_CONFLICT") return failure("IDEMPOTENCY_CONFLICT");
      const outcome = input.outcome === null ? null : await append(tx, request, input.outcome);
      if (outcome !== null && (outcome.status === "OUTCOME_CONFLICT" || outcome.status === "PENDING_IDENTITY_CONFLICT")) return outcome;
      return { idempotency, outcome: outcome as OutcomeResult | null };
    });
  }
}
