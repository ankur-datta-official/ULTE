import { verifyTerminalSchemaCapabilityOnClient, type MigrationTarget,
  type PinnedMigrationClient } from "@ulte/migration-coordinator";
import {
  createTerminalNonSubmissionDispositionReceiptV1, createTerminalNonSubmissionDispositionV1,
  equalCanonicalJson, equivalentTerminalNonSubmissionDispositionRetry,
  ORCHESTRATION_RECOVERY_RECORD_V2, TERMINAL_NON_SUBMISSION_DISPOSITION_RECEIPT_V1,
  TERMINAL_NON_SUBMISSION_DISPOSITION_V1,
  type ExecutionAuthorityCheckpoint, type OrchestrationPendingEffect,
  type TerminalNonSubmissionDispositionLogicalPayload,
  type TerminalNonSubmissionDispositionReceiptV1,
  type OrchestrationFenceToken, type OrchestrationLeaseOwnerId,
} from "@ulte/orchestration-state-store";
import { loadExecutionAuthorityCheckpointInTransaction } from "./checkpoint-store.js";
import { listExecutionOutcomesInTransaction, loadPendingEffectForUpdateInTransaction,
  resolveTerminalPendingEffectInTransaction } from "./effect-store.js";
import { PersistenceCorruptionError, PersistenceInfrastructureError } from "./errors.js";
import { assertActiveRecoveryLeaseInTransaction } from "./lease-store.js";
import { commitTerminalRecoveryStateInTransaction,
  loadRecoveryStateForUpdateInTransaction } from "./recovery-store.js";
import { appendTerminalNonSubmissionDispositionReceiptInTransaction,
  loadAdoptionCreationProofInTransaction, loadPendingIntentCommitReceiptInTransaction,
  loadTerminalNonSubmissionDispositionReceiptByIdentityInTransaction,
  loadTerminalNonSubmissionDispositionReceiptBySessionInTransaction,
  loadTerminalNonSubmissionDispositionReceiptInTransaction } from "./receipt-store.js";
import type { PostgresExecutor, PostgresTransaction } from "./postgres.js";

export type TerminalCommitFailureCode = "CAPABILITY_UNAVAILABLE" | "LEASE_LOST" | "FENCE_CONFLICT"
  | "RECOVERY_CONFLICT" | "PENDING_CONFLICT" | "CREATION_PROOF_CONFLICT"
  | "IDEMPOTENCY_STATE_CONFLICT" | "RECEIPT_CONFLICT";

export class TerminalCommitError extends Error {
  public override readonly name = "TerminalCommitError";
  public constructor(public readonly code: TerminalCommitFailureCode, message: string) { super(message); }
}

/** The logical payload is the D1 retry identity; current owner/fence authorize only a fresh write. */
export interface CommitTerminalNonSubmissionDispositionRequest {
  readonly ownerId: OrchestrationLeaseOwnerId;
  readonly expectedFence: OrchestrationFenceToken;
  readonly disposition: TerminalNonSubmissionDispositionLogicalPayload;
}
export type TerminalCommitResult = Readonly<{
  readonly status: "COMMITTED" | "ALREADY_COMMITTED";
  readonly receipt: TerminalNonSubmissionDispositionReceiptV1;
}>;

function conflict(code: TerminalCommitFailureCode, message: string): never {
  throw new TerminalCommitError(code, message);
}

function samePending(a: OrchestrationPendingEffect, b: TerminalNonSubmissionDispositionLogicalPayload["pendingEffectIdentity"]): boolean {
  return a.adapterId === b.adapterId && a.environment === b.environment && a.operation === b.operation
    && a.executionAttemptId === b.executionAttemptId && a.idempotencyKey === b.idempotencyKey
    && a.requestFingerprint === b.requestFingerprint;
}

async function checkCreationProof(tx: PostgresTransaction, pending: OrchestrationPendingEffect,
  request: TerminalNonSubmissionDispositionLogicalPayload,
  currentCheckpoint: ExecutionAuthorityCheckpoint): Promise<void> {
  let createdRef: string;
  if (request.pendingCreationRef.kind === "PENDING_INTENT_COMMIT") {
    const receipt = await loadPendingIntentCommitReceiptInTransaction(tx,
      pending.adapterId, pending.idempotencyKey);
    if (receipt === null || receipt.sessionId !== request.sessionId
        || receipt.committedRevision !== pending.createdRevision
        || receipt.committedFence !== pending.createdFence
        || !equalCanonicalJson(receipt.pendingEffect, pending)
        || receipt.committedCheckpointRef !== request.pendingCreationRef.committedCheckpointRef)
      conflict("CREATION_PROOF_CONFLICT", "Pending intent creation proof mismatch");
    createdRef = receipt.committedCheckpointRef;
  } else {
    const result = await loadAdoptionCreationProofInTransaction(tx, request.sessionId,
      pending.createdRevision, request.pendingEffectIdentity);
    if (result.status !== "FOUND" || result.receipt.nextPendingEffect === null
        || result.receipt.adoptedFence !== pending.createdFence
        || !equalCanonicalJson(result.receipt.nextPendingEffect, pending)
        || result.receipt.committedCheckpointRef !== request.pendingCreationRef.committedCheckpointRef)
      conflict("CREATION_PROOF_CONFLICT", "Adoption pending creation proof mismatch");
    createdRef = result.receipt.committedCheckpointRef;
  }
  const created = await loadExecutionAuthorityCheckpointInTransaction(tx, createdRef as ExecutionAuthorityCheckpoint["checkpointRef"]);
  if (created === null) throw new PersistenceCorruptionError("Pending creation proof references missing checkpoint");
  const first = created.evidence, latest = currentCheckpoint.evidence;
  if (first.schemaVersion !== latest.schemaVersion || !equalCanonicalJson(first.identity, latest.identity)
      || !equalCanonicalJson(first.initialization, latest.initialization)
      || first.transitions.length > latest.transitions.length
      || !first.transitions.every((transition, i) => equalCanonicalJson(transition, latest.transitions[i])))
    throw new PersistenceCorruptionError("Current checkpoint does not descend from pending creation");
}

const BROKER_LOCK = `/* terminal:broker-lock */ SELECT adapter_id, environment, idempotency_key,
 operation, execution_attempt_id, request_fingerprint, status, adapter_order_id
 FROM broker_idempotency_records
 WHERE adapter_id = $1 AND environment = $2 AND idempotency_key = $3 FOR UPDATE`;
interface BrokerRow {
  readonly adapter_id: unknown; readonly environment: unknown; readonly idempotency_key: unknown;
  readonly operation: unknown; readonly execution_attempt_id: unknown;
  readonly request_fingerprint: unknown; readonly status: unknown; readonly adapter_order_id: unknown;
}

/** One physical PostgreSQL transaction; no provider or broker call is made. */
export class PostgresTerminalNonSubmissionCommitService {
  public constructor(private readonly executor: PostgresExecutor, private readonly target: MigrationTarget) {}

  public async commitTerminalNonSubmissionDisposition(input: CommitTerminalNonSubmissionDispositionRequest):
    Promise<TerminalCommitResult> {
    const request = input.disposition;
    const candidate = createTerminalNonSubmissionDispositionV1({ ...request,
      schemaVersion: TERMINAL_NON_SUBMISSION_DISPOSITION_V1,
      committedFence: input.expectedFence, committingOwnerId: input.ownerId,
      resolution: { ...request.resolution, resolvedFence: input.expectedFence },
    });
    try {
      return await this.executor.transaction(async (tx) => {
        // Pin the verifier to this transaction's physical connection and search_path.
        const client: PinnedMigrationClient = {
          query: (sql, params) => tx.query(sql, params ?? []), release: () => undefined,
        };
        const capability = await verifyTerminalSchemaCapabilityOnClient(client, this.target);
        if (capability.status !== "VERIFIED")
          conflict("CAPABILITY_UNAVAILABLE", "D2C terminal schema capability is unavailable");

        const p = candidate.pendingEffectIdentity;
        const existing = await loadTerminalNonSubmissionDispositionReceiptInTransaction(tx, candidate.dispositionRef)
          ?? await loadTerminalNonSubmissionDispositionReceiptBySessionInTransaction(tx, candidate.sessionId)
          ?? await loadTerminalNonSubmissionDispositionReceiptByIdentityInTransaction(tx,
            p.adapterId, p.environment, p.idempotencyKey);
        if (existing !== null) {
          if (!equivalentTerminalNonSubmissionDispositionRetry(existing, request))
            conflict("RECEIPT_CONFLICT", "Terminal disposition receipt identity or payload conflict");
          return Object.freeze({ status: "ALREADY_COMMITTED", receipt: existing });
        }

        // Global writer order: lease, recovery, pending, creation proof reads, broker, receipt.
        const leaseRequest = { sessionId: candidate.sessionId, ownerId: input.ownerId,
          expectedFence: input.expectedFence };
        const lease = await assertActiveRecoveryLeaseInTransaction(tx, leaseRequest);
        if (lease.status !== "ACTIVE") conflict(lease.status, "Current terminal lease authority missing");
        const raced = await loadTerminalNonSubmissionDispositionReceiptInTransaction(tx, candidate.dispositionRef)
          ?? await loadTerminalNonSubmissionDispositionReceiptBySessionInTransaction(tx, candidate.sessionId)
          ?? await loadTerminalNonSubmissionDispositionReceiptByIdentityInTransaction(tx,
            p.adapterId, p.environment, p.idempotencyKey);
        if (raced !== null) {
          if (!equivalentTerminalNonSubmissionDispositionRetry(raced, request))
            conflict("RECEIPT_CONFLICT", "Terminal disposition receipt identity or payload conflict");
          return Object.freeze({ status: "ALREADY_COMMITTED", receipt: raced });
        }
        const recovery = await loadRecoveryStateForUpdateInTransaction(tx, candidate.sessionId);
        if (recovery === null || recovery.schemaVersion === ORCHESTRATION_RECOVERY_RECORD_V2
            || recovery.terminalNonSubmissionDispositionRef != null
            || recovery.revision !== candidate.expectedRecoveryRevision)
          conflict("RECOVERY_CONFLICT", "Recovery revision or terminal state conflict");
        if (recovery.fenceToken !== input.expectedFence)
          throw new PersistenceCorruptionError("Lease/recovery fence incoherence");
        if (recovery.executionAuthorityCheckpointRef !== candidate.executionAuthorityCheckpointRefBefore
            || !equalCanonicalJson(recovery.executionAuthorityIdentity, candidate.executionAuthorityIdentity)
            || recovery.mode !== candidate.mode || recovery.instrumentId !== candidate.instrumentId
            || recovery.riskBasisCheckpointRef !== candidate.riskBasisCheckpointRef
            || recovery.latestROutcomeRef !== candidate.latestROutcomeRef)
          conflict("RECOVERY_CONFLICT", "Recovery authority differs from terminal disposition");
        const checkpoint = await loadExecutionAuthorityCheckpointInTransaction(tx,
          candidate.executionAuthorityCheckpointRefBefore);
        if (checkpoint === null || !equalCanonicalJson(checkpoint.evidence.identity, recovery.executionAuthorityIdentity))
          throw new PersistenceCorruptionError("Recovery checkpoint authority incoherence");

        const pending = await loadPendingEffectForUpdateInTransaction(tx, p);
        if (pending === null || pending.sessionId !== candidate.sessionId || !samePending(pending, p)
            || pending.state !== "PENDING" || pending.resolutionKind != null
            || pending.resolvedAuthorityRef != null || pending.resolvedRevision !== null
            || pending.resolvedFence !== null || pending.createdRevision !== candidate.pendingCreatedRevision
            || pending.createdFence !== candidate.pendingCreatedFence
            || pending.createdRevision > recovery.revision || pending.createdFence > recovery.fenceToken)
          conflict("PENDING_CONFLICT", "Linked pending effect is missing or not unresolved");
        await checkCreationProof(tx, pending, request, checkpoint);

        const broker = await tx.query<BrokerRow>(BROKER_LOCK,
          [p.adapterId, p.environment, p.idempotencyKey]);
        if (broker.rowCount !== broker.rows.length || broker.rows.length > 1)
          throw new PersistenceCorruptionError("Broker idempotency lookup returned impossible row count");
        const row = broker.rows[0];
        if (row === undefined || row.adapter_id !== p.adapterId || row.environment !== p.environment
            || row.idempotency_key !== p.idempotencyKey || row.operation !== p.operation
            || row.execution_attempt_id !== p.executionAttemptId
            || row.request_fingerprint !== p.requestFingerprint
            || row.status !== "FAILED_NOT_SUBMITTED" || row.adapter_order_id !== null)
          conflict("IDEMPOTENCY_STATE_CONFLICT", "Exact broker idempotency is not definitely unsubmitted");
        const outcomes = await listExecutionOutcomesInTransaction(tx, candidate.sessionId, candidate.executionAttemptId);
        if (outcomes.some((outcome) => outcome.pendingEffectIdentity !== null
            && equalCanonicalJson(outcome.pendingEffectIdentity, p)
            && (outcome.observation.kind === "CANONICAL_EXECUTION_TRANSITION"
              || outcome.observation.disposition.status !== "CONFIRMED_NOT_SUBMITTED")))
          conflict("IDEMPOTENCY_STATE_CONFLICT", "Broker outcome contradicts terminal non-submission");

        const receipt = createTerminalNonSubmissionDispositionReceiptV1({
          schemaVersion: TERMINAL_NON_SUBMISSION_DISPOSITION_RECEIPT_V1, disposition: candidate,
        });
        const inserted = await appendTerminalNonSubmissionDispositionReceiptInTransaction(tx, receipt);
        if (inserted.status !== "APPENDED")
          conflict("RECEIPT_CONFLICT", "Terminal disposition receipt insertion conflicted");
        await resolveTerminalPendingEffectInTransaction(tx, { sessionId: candidate.sessionId,
          identity: p, dispositionRef: candidate.dispositionRef,
          revision: candidate.committedRevision, fence: candidate.committedFence });
        const updated = await commitTerminalRecoveryStateInTransaction(tx, candidate.sessionId,
          candidate.expectedRecoveryRevision, candidate.committedFence, candidate.dispositionRef);
        if (updated.executionAuthorityCheckpointRef !== recovery.executionAuthorityCheckpointRef
            || !equalCanonicalJson(updated.executionAuthorityIdentity, recovery.executionAuthorityIdentity)
            || updated.mode !== recovery.mode || updated.instrumentId !== recovery.instrumentId
            || updated.riskBasisCheckpointRef !== recovery.riskBasisCheckpointRef
            || updated.latestROutcomeRef !== recovery.latestROutcomeRef)
          throw new PersistenceCorruptionError("Terminal recovery changed unrelated authority fields");
        const finalLease = await assertActiveRecoveryLeaseInTransaction(tx, leaseRequest);
        if (finalLease.status !== "ACTIVE")
          conflict(finalLease.status, "Terminal lease authority expired before commit");
        return Object.freeze({ status: "COMMITTED", receipt: inserted.receipt });
      });
    } catch (cause) {
      if (cause instanceof TerminalCommitError || cause instanceof PersistenceCorruptionError
          || cause instanceof PersistenceInfrastructureError || cause instanceof TypeError) throw cause;
      throw new PersistenceInfrastructureError("PostgreSQL terminal disposition commit failed", { cause });
    }
  }
}
