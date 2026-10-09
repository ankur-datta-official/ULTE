import {
  createExecutionAuthorityCheckpoint, createExternalOutcomeAdoptionReceipt,
  createOrchestrationPendingEffect, createOrchestrationPendingEffectIdentity, createOrchestrationRecoveryRecord,
  createOutcomeAdoptionRecoveryState, equivalentOutcomeAdoptionRetry, orchestrationOutcomeKey,
  createPendingIntentCommitReceipt, equalCanonicalJson, equivalentPendingIntentRetry,
  executionAuthorityCheckpointId, orchestrationFenceToken, orchestrationLeaseOwnerId,
  orchestrationRevision, orchestrationSessionId, proveOutcomeAdoptionCheckpointAdvance,
  provePendingIntentCheckpointAdvance, ORCHESTRATION_EXTERNAL_OUTCOME_ADOPTION_RECEIPT_V1,
  ORCHESTRATION_PENDING_EFFECT_SCHEMA_VERSION,
  ORCHESTRATION_PENDING_INTENT_COMMIT_RECEIPT_V1, ORCHESTRATION_RECOVERY_RECORD_SCHEMA_VERSION,
  type AdoptOutcomeRequest, type AdoptionLogicalPayload, type CommitPendingIntentRequest,
  type ExecutionAuthorityCheckpoint, type ExternalOutcomeAdoptionReceipt,
  type LinkedPendingResolution, type OrchestrationPendingEffect, type OrchestrationRecoveryState,
  type OrchestrationPendingEffectIdentity,
  type OutcomeAdoptionTransactionResult, type PendingIntentCommitReceipt,
  type PendingIntentLogicalPayload, type PendingIntentTransactionResult,
} from "@ulte/orchestration-state-store";
import { appendExecutionAuthorityCheckpointInTransaction,
  loadExecutionAuthorityCheckpointInTransaction } from "./checkpoint-store.js";
import { createPendingEffectInTransaction, loadOutcomeInTransaction,
  loadPendingEffectForUpdateInTransaction, resolvePendingEffectInTransaction } from "./effect-store.js";
import { PersistenceConflictError, PersistenceCorruptionError } from "./errors.js";
import { assertActiveRecoveryLeaseInTransaction } from "./lease-store.js";
import { loadRecoveryStateForUpdateInTransaction, saveRecoveryStateInTransaction } from "./recovery-store.js";
import { appendPendingIntentCommitReceiptInTransaction,
  appendExternalOutcomeAdoptionReceiptInTransaction, loadExternalOutcomeAdoptionReceiptInTransaction,
  loadPendingIntentCommitReceiptInTransaction } from "./receipt-store.js";
import type { PostgresExecutor, PostgresTransaction } from "./postgres.js";

type ValidRequest = CommitPendingIntentRequest & { readonly committedRevision: ReturnType<typeof orchestrationRevision> };

function validRequest(input: CommitPendingIntentRequest): ValidRequest {
  const sessionId = orchestrationSessionId(input.sessionId);
  const ownerId = orchestrationLeaseOwnerId(input.ownerId);
  const expectedRevision = orchestrationRevision(input.expectedRevision);
  if (expectedRevision === Number.MAX_SAFE_INTEGER) {
    throw new PersistenceConflictError("REVISION_OVERFLOW", "Recovery revision cannot exceed MAX_SAFE_INTEGER");
  }
  const committedRevision = orchestrationRevision(expectedRevision + 1);
  const expectedFence = orchestrationFenceToken(input.expectedFence);
  const previousCheckpointRef = executionAuthorityCheckpointId(input.previousCheckpointRef);
  const committedCheckpoint = createExecutionAuthorityCheckpoint(input.committedCheckpoint);
  const pendingEffect = createOrchestrationPendingEffect(input.pendingEffect);
  if (pendingEffect.state !== "PENDING" || pendingEffect.sessionId !== sessionId
      || pendingEffect.createdRevision !== committedRevision) {
    throw new TypeError("Pending intent creation facts mismatch");
  }
  const state = createOrchestrationRecoveryRecord({
    ...input.resultingRecoveryState,
    schemaVersion: ORCHESTRATION_RECOVERY_RECORD_SCHEMA_VERSION,
    sessionId, revision: committedRevision, fenceToken: expectedFence,
  });
  const resultingRecoveryState: OrchestrationRecoveryState = Object.freeze({
    mode: state.mode, instrumentId: state.instrumentId,
    executionAuthorityCheckpointRef: state.executionAuthorityCheckpointRef,
    executionAuthorityIdentity: state.executionAuthorityIdentity,
    riskBasisCheckpointRef: state.riskBasisCheckpointRef,
    latestROutcomeRef: state.latestROutcomeRef,
  });
  return { sessionId, ownerId, expectedRevision, expectedFence, committedRevision,
    previousCheckpointRef, committedCheckpoint, resultingRecoveryState, pendingEffect };
}

function checkpointConflict(request: ValidRequest): PendingIntentTransactionResult {
  return Object.freeze({ status: "CHECKPOINT_CONFLICT", checkpointRef: request.committedCheckpoint.checkpointRef });
}
function effectConflict(): PendingIntentTransactionResult {
  return Object.freeze({ status: "EFFECT_CONFLICT" });
}

/** The receipt is historical authority. No current lease, pending state, or recovery revision is read. */
async function historicalRetry(tx: PostgresTransaction, request: ValidRequest,
  receipt: PendingIntentCommitReceipt): Promise<PendingIntentTransactionResult> {
  if (receipt.committedCheckpointRef !== request.committedCheckpoint.checkpointRef) return effectConflict();
  const committed = await loadExecutionAuthorityCheckpointInTransaction(tx, receipt.committedCheckpointRef);
  if (committed === null) throw new PersistenceCorruptionError("Receipt references a missing committed checkpoint");
  if (!equalCanonicalJson(committed, request.committedCheckpoint)) return checkpointConflict(request);
  if (receipt.previousCheckpointRef !== request.previousCheckpointRef) return effectConflict();
  const previous = await loadExecutionAuthorityCheckpointInTransaction(tx, receipt.previousCheckpointRef);
  if (previous === null) throw new PersistenceCorruptionError("Receipt references a missing previous checkpoint");
  let logical: PendingIntentLogicalPayload;
  try {
    const advanceProof = provePendingIntentCheckpointAdvance({ previousCheckpoint: previous,
      committedCheckpoint: committed, pendingEffect: request.pendingEffect });
    logical = { sessionId: request.sessionId, expectedRevision: request.expectedRevision,
      previousCheckpointRef: request.previousCheckpointRef,
      committedCheckpointRef: request.committedCheckpoint.checkpointRef,
      resultingRecoveryState: request.resultingRecoveryState, pendingEffect: request.pendingEffect, advanceProof };
  } catch (cause) {
    if (cause instanceof TypeError) return effectConflict();
    throw cause;
  }
  return equivalentPendingIntentRetry(receipt, logical)
    ? Object.freeze({ status: "ALREADY_COMMITTED", receipt }) : effectConflict();
}

class RollbackResult extends Error {
  public constructor(public readonly result: PendingIntentTransactionResult) { super("Rollback pending intent transaction"); }
}

function rollback(result: PendingIntentTransactionResult): never { throw new RollbackResult(result); }

type ValidAdoptionRequest = AdoptOutcomeRequest & { readonly adoptedRevision: ReturnType<typeof orchestrationRevision> };

function validAdoptionRequest(input: AdoptOutcomeRequest): ValidAdoptionRequest {
  const sessionId = orchestrationSessionId(input.sessionId);
  const ownerId = orchestrationLeaseOwnerId(input.ownerId);
  const expectedRevision = orchestrationRevision(input.expectedRevision);
  if (expectedRevision === Number.MAX_SAFE_INTEGER) {
    throw new PersistenceConflictError("REVISION_OVERFLOW", "Recovery revision cannot exceed MAX_SAFE_INTEGER");
  }
  const adoptedRevision = orchestrationRevision(expectedRevision + 1);
  const expectedFence = orchestrationFenceToken(input.expectedFence);
  const previousCheckpointRef = executionAuthorityCheckpointId(input.previousCheckpointRef);
  const outcomeKey = orchestrationOutcomeKey(input.outcomeKey);
  const committedCheckpoint = createExecutionAuthorityCheckpoint(input.committedCheckpoint);
  const nextPendingEffectIdentity = input.nextPendingEffectIdentity === null ? null
    : createOrchestrationPendingEffectIdentity(input.nextPendingEffectIdentity);
  const state = createOrchestrationRecoveryRecord({
    ...input.resultingRecoveryState, schemaVersion: ORCHESTRATION_RECOVERY_RECORD_SCHEMA_VERSION,
    sessionId, revision: adoptedRevision, fenceToken: expectedFence,
  });
  const resultingRecoveryState: OrchestrationRecoveryState = Object.freeze({
    mode: state.mode, instrumentId: state.instrumentId,
    executionAuthorityCheckpointRef: state.executionAuthorityCheckpointRef,
    executionAuthorityIdentity: state.executionAuthorityIdentity,
    riskBasisCheckpointRef: state.riskBasisCheckpointRef, latestROutcomeRef: state.latestROutcomeRef,
  });
  return { sessionId, ownerId, expectedRevision, adoptedRevision, expectedFence,
    previousCheckpointRef, outcomeKey, committedCheckpoint, resultingRecoveryState, nextPendingEffectIdentity };
}

function derivedNextPending(request: ValidAdoptionRequest,
  revision: ValidAdoptionRequest["adoptedRevision"], fence: ValidAdoptionRequest["expectedFence"]): OrchestrationPendingEffect | null {
  if (request.nextPendingEffectIdentity === null) return null;
  return createOrchestrationPendingEffect({
    schemaVersion: ORCHESTRATION_PENDING_EFFECT_SCHEMA_VERSION, sessionId: request.sessionId,
    ...request.nextPendingEffectIdentity, createdRevision: revision, createdFence: fence,
    state: "PENDING", resolvedOutcomeKey: null, resolvedRevision: null, resolvedFence: null,
  });
}
function pendingIdentity(effect: OrchestrationPendingEffect): OrchestrationPendingEffectIdentity {
  const { adapterId, environment, operation, executionAttemptId, idempotencyKey, requestFingerprint } = effect;
  return { adapterId, environment, operation, executionAttemptId, idempotencyKey, requestFingerprint };
}

function adoptionConflict(): OutcomeAdoptionTransactionResult {
  return Object.freeze({ status: "ADOPTION_CONFLICT" });
}
function adoptionCheckpointConflict(request: ValidAdoptionRequest): OutcomeAdoptionTransactionResult {
  return Object.freeze({ status: "CHECKPOINT_CONFLICT", checkpointRef: request.committedCheckpoint.checkpointRef });
}

/** The stored receipt supplies historical fence and revision facts, independent of current authorization. */
async function historicalAdoptionRetry(tx: PostgresTransaction, request: ValidAdoptionRequest,
  receipt: ExternalOutcomeAdoptionReceipt): Promise<OutcomeAdoptionTransactionResult> {
  if (receipt.committedCheckpointRef !== request.committedCheckpoint.checkpointRef) return adoptionConflict();
  const committed = await loadExecutionAuthorityCheckpointInTransaction(tx, receipt.committedCheckpointRef);
  if (committed === null) throw new PersistenceCorruptionError("Adoption receipt references a missing committed checkpoint");
  if (!equalCanonicalJson(committed, request.committedCheckpoint)) return adoptionCheckpointConflict(request);
  if (receipt.previousCheckpointRef !== request.previousCheckpointRef) return adoptionConflict();
  const previous = await loadExecutionAuthorityCheckpointInTransaction(tx, receipt.previousCheckpointRef);
  if (previous === null) throw new PersistenceCorruptionError("Adoption receipt references a missing previous checkpoint");
  const outcome = await loadOutcomeInTransaction(tx, request.outcomeKey);
  if (outcome === null) throw new PersistenceCorruptionError("Adoption receipt references a missing outcome");
  try {
    const nextPendingEffect = derivedNextPending(request, receipt.adoptedRevision, receipt.adoptedFence);
    const proofResult = proveOutcomeAdoptionCheckpointAdvance({ previousCheckpoint: previous,
      committedCheckpoint: committed, outcome, nextPendingEffect });
    if (proofResult.status !== "PROVEN") return adoptionConflict();
    const advanceProof = proofResult.proof;
    const linkedPendingResolution: LinkedPendingResolution | null = outcome.pendingEffectIdentity === null ? null
      : { pendingEffectIdentity: outcome.pendingEffectIdentity, outcomeKey: outcome.outcomeKey,
        resolvedRevision: receipt.adoptedRevision, resolvedFence: receipt.adoptedFence };
    const nextPendingCommit: PendingIntentLogicalPayload | null = nextPendingEffect === null ? null
      : { sessionId: request.sessionId, expectedRevision: request.expectedRevision,
        previousCheckpointRef: request.previousCheckpointRef,
        committedCheckpointRef: request.committedCheckpoint.checkpointRef,
        resultingRecoveryState: request.resultingRecoveryState, pendingEffect: nextPendingEffect, advanceProof };
    const logical: AdoptionLogicalPayload = { outcomeKey: request.outcomeKey, sessionId: request.sessionId,
      executionAttemptId: outcome.executionAttemptId, expectedRevision: request.expectedRevision,
      previousCheckpointRef: request.previousCheckpointRef,
      committedCheckpointRef: request.committedCheckpoint.checkpointRef,
      resultingRecoveryState: request.resultingRecoveryState, linkedPendingResolution,
      nextPendingEffect, nextPendingCommit, advanceProof };
    return equivalentOutcomeAdoptionRetry(receipt, logical)
      ? Object.freeze({ status: "ALREADY_ADOPTED", receipt }) : adoptionConflict();
  } catch (cause) {
    if (cause instanceof TypeError) return adoptionConflict();
    throw cause;
  }
}

class AdoptionRollbackResult extends Error {
  public constructor(public readonly result: OutcomeAdoptionTransactionResult) {
    super("Rollback outcome adoption transaction");
  }
}
function rollbackAdoption(result: OutcomeAdoptionTransactionResult): never {
  throw new AdoptionRollbackResult(result);
}

export class PostgresOrchestrationCommitService {
  public constructor(private readonly executor: PostgresExecutor) {}

  public async adoptOutcome(input: AdoptOutcomeRequest): Promise<OutcomeAdoptionTransactionResult> {
    const request = validAdoptionRequest(input);
    try {
      return await this.executor.transaction(async (tx) => {
        const existing = await loadExternalOutcomeAdoptionReceiptInTransaction(tx, request.outcomeKey);
        if (existing !== null) return historicalAdoptionRetry(tx, request, existing);

        const outcome = await loadOutcomeInTransaction(tx, request.outcomeKey);
        if (outcome === null) return Object.freeze({ status: "OUTCOME_NOT_FOUND" });
        if (outcome.observation.kind === "BROKER_DISPOSITION") {
          return Object.freeze({ status: "OUTCOME_NOT_ADOPTABLE" });
        }
        if (outcome.sessionId !== request.sessionId
            || outcome.executionAttemptId !== request.committedCheckpoint.evidence.identity.executionAttemptId) {
          throw new TypeError("Outcome adoption session or attempt mismatch");
        }
        const leaseRequest = { sessionId: request.sessionId, ownerId: request.ownerId,
          expectedFence: request.expectedFence };
        const lease = await assertActiveRecoveryLeaseInTransaction(tx, leaseRequest);
        if (lease.status !== "ACTIVE") return lease;

        const current = await loadRecoveryStateForUpdateInTransaction(tx, request.sessionId);
        if (current === null) return Object.freeze({ status: "NOT_FOUND" });
        if (current.schemaVersion === "ORCHESTRATION_RECOVERY_RECORD_V2") {
          throw new PersistenceConflictError("TERMINAL_STATE_CONFLICT", "Terminal recovery cannot adopt an outcome");
        }
        if (current.revision !== request.expectedRevision) {
          return Object.freeze({ status: "REVISION_CONFLICT", currentRevision: current.revision });
        }
        if (current.fenceToken !== request.expectedFence) {
          throw new PersistenceCorruptionError("Lease/recovery fence incoherence");
        }
        const currentRef = current.executionAuthorityCheckpointRef;
        const previous: ExecutionAuthorityCheckpoint | null = currentRef === null ? null
          : await loadExecutionAuthorityCheckpointInTransaction(tx, currentRef);
        if (currentRef !== null && previous === null) {
          throw new PersistenceCorruptionError("Recovery references a missing checkpoint");
        }
        if (previous !== null && (!equalCanonicalJson(current.executionAuthorityIdentity, previous.evidence.identity)
            || current.instrumentId !== previous.evidence.identity.instrumentId)) {
          throw new PersistenceCorruptionError("Recovery checkpoint identity incoherence");
        }
        if (currentRef !== request.previousCheckpointRef) {
          return Object.freeze({ status: "PRIOR_CHECKPOINT_CONFLICT",
            requestedPreviousCheckpointRef: request.previousCheckpointRef, currentCheckpointRef: currentRef });
        }
        if (previous === null) throw new PersistenceCorruptionError("Expected prior checkpoint authority");
        const canonicalTarget = createOutcomeAdoptionRecoveryState({ currentRecovery: current,
          committedCheckpoint: request.committedCheckpoint });
        if (!equalCanonicalJson(canonicalTarget, request.resultingRecoveryState)) {
          throw new TypeError("Outcome adoption recovery target mismatch");
        }
        const nextPendingEffect = derivedNextPending(request, request.adoptedRevision, request.expectedFence);
        if (nextPendingEffect !== null && (nextPendingEffect.environment !== current.mode
            || nextPendingEffect.executionAttemptId !== outcome.executionAttemptId)) {
          throw new TypeError("Next pending effect environment or attempt mismatch");
        }
        const linkedIdentity = outcome.pendingEffectIdentity;
        const linkedPendingResolution: LinkedPendingResolution | null = linkedIdentity === null ? null
          : { pendingEffectIdentity: linkedIdentity, outcomeKey: outcome.outcomeKey,
            resolvedRevision: request.adoptedRevision, resolvedFence: request.expectedFence };
        if (linkedIdentity !== null) {
          const linked = await loadPendingEffectForUpdateInTransaction(tx, linkedIdentity);
          if (linked === null || linked.sessionId !== request.sessionId
              || !equalCanonicalJson(pendingIdentity(linked), linkedIdentity)
              || linked.state !== "PENDING" || linked.resolvedOutcomeKey !== null
              || linked.resolvedRevision !== null || linked.resolvedFence !== null) {
            throw new PersistenceCorruptionError("Outcome linked pending effect is missing or contradictory");
          }
        }
        if (nextPendingEffect !== null) {
          const nextExisting = await loadPendingEffectForUpdateInTransaction(tx,
            request.nextPendingEffectIdentity!);
          if (nextExisting !== null) {
            const sameCreation = nextExisting.sessionId === nextPendingEffect.sessionId
              && equalCanonicalJson(pendingIdentity(nextExisting),
                request.nextPendingEffectIdentity)
              && nextExisting.createdRevision === nextPendingEffect.createdRevision
              && nextExisting.createdFence === nextPendingEffect.createdFence;
            if (sameCreation) {
              throw new PersistenceCorruptionError("Next pending effect exists without adoption receipt");
            }
            return Object.freeze({ status: "EFFECT_CONFLICT" });
          }
        }
        const committedExisting = await loadExecutionAuthorityCheckpointInTransaction(tx,
          request.committedCheckpoint.checkpointRef);
        if (committedExisting !== null && !equalCanonicalJson(committedExisting, request.committedCheckpoint)) {
          return adoptionCheckpointConflict(request);
        }
        const proofResult = proveOutcomeAdoptionCheckpointAdvance({ previousCheckpoint: previous,
          committedCheckpoint: request.committedCheckpoint, outcome, nextPendingEffect });
        if (proofResult.status !== "PROVEN") return Object.freeze({ status: "OUTCOME_NOT_ADOPTABLE" });
        const advanceProof = proofResult.proof;
        const nextPendingCommit: PendingIntentLogicalPayload | null = nextPendingEffect === null ? null
          : { sessionId: request.sessionId, expectedRevision: request.expectedRevision,
            previousCheckpointRef: request.previousCheckpointRef,
            committedCheckpointRef: request.committedCheckpoint.checkpointRef,
            resultingRecoveryState: request.resultingRecoveryState, pendingEffect: nextPendingEffect, advanceProof };
        const receipt = createExternalOutcomeAdoptionReceipt({
          schemaVersion: ORCHESTRATION_EXTERNAL_OUTCOME_ADOPTION_RECEIPT_V1,
          outcomeKey: outcome.outcomeKey, sessionId: request.sessionId,
          executionAttemptId: outcome.executionAttemptId, expectedRevision: request.expectedRevision,
          adoptedRevision: request.adoptedRevision, adoptedFence: request.expectedFence,
          adoptingOwnerId: request.ownerId, previousCheckpointRef: request.previousCheckpointRef,
          committedCheckpointRef: request.committedCheckpoint.checkpointRef,
          resultingRecoveryState: request.resultingRecoveryState, linkedPendingResolution,
          nextPendingEffect, nextPendingCommit, advanceProof,
        }, previous, request.committedCheckpoint, outcome);

        const raced = await loadExternalOutcomeAdoptionReceiptInTransaction(tx, request.outcomeKey);
        if (raced !== null) return historicalAdoptionRetry(tx, request, raced);
        const checkpointResult = await appendExecutionAuthorityCheckpointInTransaction(tx, request.committedCheckpoint);
        if (checkpointResult.status === "CHECKPOINT_CONFLICT") rollbackAdoption(adoptionCheckpointConflict(request));
        if (linkedIdentity !== null) {
          const resolution = await resolvePendingEffectInTransaction(tx, { sessionId: request.sessionId,
            pendingEffectIdentity: linkedIdentity, outcomeKey: outcome.outcomeKey,
            expectedRevision: request.adoptedRevision, expectedFence: request.expectedFence });
          if (resolution.status !== "RESOLVED") {
            throw new PersistenceCorruptionError(`Locked pending resolution returned ${resolution.status}`);
          }
        }
        if (nextPendingEffect !== null) {
          const creation = await createPendingEffectInTransaction(tx, nextPendingEffect);
          if (creation.status !== "CREATED") rollbackAdoption(Object.freeze({ status: "EFFECT_CONFLICT" }));
        }
        let recoveryResult: Awaited<ReturnType<typeof saveRecoveryStateInTransaction>>;
        try {
          recoveryResult = await saveRecoveryStateInTransaction(tx, {
            sessionId: request.sessionId, expectedRevision: request.expectedRevision,
            expectedFence: request.expectedFence, state: request.resultingRecoveryState,
          });
        } catch (cause) {
          if (cause instanceof PersistenceConflictError && cause.code === "CONCURRENT_RECOVERY_CONFLICT") {
            throw new PersistenceCorruptionError("Locked recovery CAS updated no row", { cause });
          }
          throw cause;
        }
        if (recoveryResult.status !== "SAVED") {
          throw new PersistenceCorruptionError(`Locked recovery CAS returned ${recoveryResult.status}`);
        }
        const receiptResult = await appendExternalOutcomeAdoptionReceiptInTransaction(tx, receipt);
        if (receiptResult.status === "RECEIPT_CONFLICT") rollbackAdoption(adoptionConflict());
        if (receiptResult.status === "DUPLICATE_SAME") {
          throw new PersistenceCorruptionError("Adoption receipt appeared after locked pre-write recheck");
        }
        const finalLease = await assertActiveRecoveryLeaseInTransaction(tx, leaseRequest);
        if (finalLease.status !== "ACTIVE") rollbackAdoption(finalLease);
        return Object.freeze({ status: "ADOPTED", receipt: receiptResult.receipt });
      });
    } catch (cause) {
      if (cause instanceof AdoptionRollbackResult) return cause.result;
      throw cause;
    }
  }

  public async commitPendingIntent(input: CommitPendingIntentRequest): Promise<PendingIntentTransactionResult> {
    const request = validRequest(input);
    try {
      return await this.executor.transaction(async (tx) => {
        const { pendingEffect } = request;
        const existing = await loadPendingIntentCommitReceiptInTransaction(tx,
          pendingEffect.adapterId, pendingEffect.idempotencyKey);
        if (existing !== null) return historicalRetry(tx, request, existing);

        if (pendingEffect.createdFence !== request.expectedFence) {
          throw new TypeError("Pending intent fence does not match current authorization");
        }
        const leaseRequest = { sessionId: request.sessionId, ownerId: request.ownerId,
          expectedFence: request.expectedFence };
        const lease = await assertActiveRecoveryLeaseInTransaction(tx, leaseRequest);
        if (lease.status !== "ACTIVE") return lease;

        const current = await loadRecoveryStateForUpdateInTransaction(tx, request.sessionId);
        if (current === null) return Object.freeze({ status: "NOT_FOUND" });
        if (current.schemaVersion === "ORCHESTRATION_RECOVERY_RECORD_V2") {
          throw new PersistenceConflictError("TERMINAL_STATE_CONFLICT", "Terminal recovery cannot commit pending intent");
        }
        if (current.revision !== request.expectedRevision) {
          return Object.freeze({ status: "REVISION_CONFLICT", currentRevision: current.revision });
        }
        if (current.fenceToken !== request.expectedFence) {
          throw new PersistenceCorruptionError("Lease/recovery fence incoherence");
        }
        const currentRef = current.executionAuthorityCheckpointRef;
        const previous: ExecutionAuthorityCheckpoint | null = currentRef === null ? null
          : await loadExecutionAuthorityCheckpointInTransaction(tx, currentRef);
        if (currentRef !== null && previous === null) {
          throw new PersistenceCorruptionError("Recovery references a missing checkpoint");
        }
        if (previous !== null && (!equalCanonicalJson(current.executionAuthorityIdentity, previous.evidence.identity)
            || current.instrumentId !== previous.evidence.identity.instrumentId)) {
          throw new PersistenceCorruptionError("Recovery checkpoint identity incoherence");
        }
        if (currentRef !== request.previousCheckpointRef) {
          return Object.freeze({ status: "PRIOR_CHECKPOINT_CONFLICT",
            requestedPreviousCheckpointRef: request.previousCheckpointRef, currentCheckpointRef: currentRef });
        }
        if (previous === null) throw new PersistenceCorruptionError("Expected prior checkpoint authority");
        const state = request.resultingRecoveryState;
        if (state.mode !== current.mode || state.instrumentId !== current.instrumentId
            || state.riskBasisCheckpointRef !== current.riskBasisCheckpointRef
            || state.latestROutcomeRef !== current.latestROutcomeRef
            || pendingEffect.environment !== current.mode
            || pendingEffect.executionAttemptId !== current.executionAuthorityIdentity?.executionAttemptId) {
          throw new TypeError("Pending intent changes session-stable recovery facts or execution identity");
        }
        const proof = provePendingIntentCheckpointAdvance({ previousCheckpoint: previous,
          committedCheckpoint: request.committedCheckpoint, pendingEffect });
        const receipt = createPendingIntentCommitReceipt({
          schemaVersion: ORCHESTRATION_PENDING_INTENT_COMMIT_RECEIPT_V1,
          sessionId: request.sessionId, expectedRevision: request.expectedRevision,
          committedRevision: request.committedRevision, committedFence: request.expectedFence,
          committingOwnerId: request.ownerId, previousCheckpointRef: request.previousCheckpointRef,
          committedCheckpointRef: request.committedCheckpoint.checkpointRef,
          resultingRecoveryState: state, pendingEffect, advanceProof: proof,
        }, previous, request.committedCheckpoint);

        const raced = await loadPendingIntentCommitReceiptInTransaction(tx,
          pendingEffect.adapterId, pendingEffect.idempotencyKey);
        if (raced !== null) return historicalRetry(tx, request, raced);

        const checkpointResult = await appendExecutionAuthorityCheckpointInTransaction(tx, request.committedCheckpoint);
        if (checkpointResult.status === "CHECKPOINT_CONFLICT") return checkpointConflict(request);
        const pendingResult = await createPendingEffectInTransaction(tx, pendingEffect);
        if (pendingResult.status === "EFFECT_CONFLICT") rollback(effectConflict());
        if (pendingResult.status === "DUPLICATE_SAME") {
          throw new PersistenceCorruptionError("Pending effect exists without its commit receipt");
        }
        const recoveryResult = await saveRecoveryStateInTransaction(tx, {
          sessionId: request.sessionId, expectedRevision: request.expectedRevision,
          expectedFence: request.expectedFence, state,
        });
        if (recoveryResult.status !== "SAVED") {
          throw new PersistenceCorruptionError(`Locked recovery CAS returned ${recoveryResult.status}`);
        }
        const receiptResult = await appendPendingIntentCommitReceiptInTransaction(tx, receipt);
        if (receiptResult.status === "RECEIPT_CONFLICT") rollback(effectConflict());
        if (receiptResult.status === "DUPLICATE_SAME") {
          throw new PersistenceCorruptionError("Receipt appeared after locked pre-write recheck");
        }
        const finalLease = await assertActiveRecoveryLeaseInTransaction(tx, leaseRequest);
        if (finalLease.status !== "ACTIVE") rollback(finalLease);
        return Object.freeze({ status: "COMMITTED", receipt: receiptResult.receipt });
      });
    } catch (cause) {
      if (cause instanceof RollbackResult) return cause.result;
      throw cause;
    }
  }
}
