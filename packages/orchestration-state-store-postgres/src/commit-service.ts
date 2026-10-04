import {
  createExecutionAuthorityCheckpoint, createOrchestrationPendingEffect, createOrchestrationRecoveryRecord,
  createPendingIntentCommitReceipt, equalCanonicalJson, equivalentPendingIntentRetry,
  executionAuthorityCheckpointId, orchestrationFenceToken, orchestrationLeaseOwnerId,
  orchestrationRevision, orchestrationSessionId, provePendingIntentCheckpointAdvance,
  ORCHESTRATION_PENDING_INTENT_COMMIT_RECEIPT_V1, ORCHESTRATION_RECOVERY_RECORD_SCHEMA_VERSION,
  type CommitPendingIntentRequest, type ExecutionAuthorityCheckpoint,
  type OrchestrationRecoveryState, type PendingIntentCommitReceipt,
  type PendingIntentLogicalPayload, type PendingIntentTransactionResult,
} from "@ulte/orchestration-state-store";
import { appendExecutionAuthorityCheckpointInTransaction,
  loadExecutionAuthorityCheckpointInTransaction } from "./checkpoint-store.js";
import { createPendingEffectInTransaction } from "./effect-store.js";
import { PersistenceConflictError, PersistenceCorruptionError } from "./errors.js";
import { assertActiveRecoveryLeaseInTransaction } from "./lease-store.js";
import { loadRecoveryStateForUpdateInTransaction, saveRecoveryStateInTransaction } from "./recovery-store.js";
import { appendPendingIntentCommitReceiptInTransaction,
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

export class PostgresOrchestrationCommitService {
  public constructor(private readonly executor: PostgresExecutor) {}

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
