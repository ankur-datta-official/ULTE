import { verifyTerminalSchemaCapabilityOnClient, type MigrationTarget,
  type PinnedMigrationClient } from "@ulte/migration-coordinator";
import { readIdempotencyInTransaction,
  PersistenceConflictError as ExecutionPersistenceConflictError,
  PersistenceCorruptionError as ExecutionPersistenceCorruptionError } from "@ulte/execution-store-postgres";
import { classifyRecoveryBoot, type LoadedExternalOutcome, type LoadedIdempotency,
  type LoadedPendingEffect, type PendingCreationProof, type RecoveryBootResult } from
  "@ulte/sandbox-orchestration-recovery";
import { orchestrationLeaseOwnerId, orchestrationSessionId,
  type OrchestrationPendingEffect, type OrchestrationSessionId } from "@ulte/orchestration-state-store";
import { loadExecutionAuthorityCheckpointInTransaction } from "./checkpoint-store.js";
import { listExecutionOutcomesInTransaction, listTerminalResolvedEffectsInTransaction,
  listUnresolvedEffectsInTransaction,
  loadPendingEffectInTransaction } from "./effect-store.js";
import { PersistenceCorruptionError } from "./errors.js";
import { loadRecoveryLeaseInTransaction } from "./lease-store.js";
import { safeLeaseBigint } from "./lease-mapping.js";
import type { PostgresSnapshotExecutor, PostgresTransaction } from "./postgres.js";
import { loadRecoveryStateInTransaction } from "./recovery-store.js";
import { loadAdoptionCreationProofInTransaction, loadExternalOutcomeAdoptionReceiptInTransaction,
  loadPendingIntentCommitReceiptInTransaction,
  loadTerminalNonSubmissionDispositionReceiptBySessionInTransaction,
  loadTerminalNonSubmissionDispositionReceiptInTransaction } from "./receipt-store.js";

export type PostgresRecoveryBootResult = RecoveryBootResult | Readonly<{
  readonly status: "RECOVERY_REJECTED";
  readonly sessionId: OrchestrationSessionId;
  readonly reason: "RECOVERY_STATE_MISSING" | "PERSISTENCE_CORRUPTION" | "REQUIRED_EVIDENCE_UNAVAILABLE";
}>;

async function creationProof(tx: PostgresTransaction, effect: OrchestrationPendingEffect):
  Promise<PendingCreationProof | null> {
  const pending = await loadPendingIntentCommitReceiptInTransaction(tx, effect.adapterId, effect.idempotencyKey);
  if (pending !== null) return { kind: "PENDING_INTENT_COMMIT", receipt: pending };
  const adoption = await loadAdoptionCreationProofInTransaction(tx, effect.sessionId,
    effect.createdRevision, { adapterId: effect.adapterId, environment: effect.environment,
      operation: effect.operation, executionAttemptId: effect.executionAttemptId,
      idempotencyKey: effect.idempotencyKey, requestFingerprint: effect.requestFingerprint });
  return adoption.status === "FOUND" ? { kind: "ADOPTION_NEXT_PENDING", receipt: adoption.receipt } : null;
}

async function idempotency(tx: PostgresTransaction, effect: OrchestrationPendingEffect):
  Promise<LoadedIdempotency> {
  const record = await readIdempotencyInTransaction(tx, effect.adapterId, effect.idempotencyKey);
  return record === undefined ? { status: "ABSENT" } : { status: "PRESENT", record };
}

/** Historical authority composition only. Results grant no runtime execution permission. */
export class PostgresRecoveryBootLoader {
  public constructor(private readonly executor: PostgresSnapshotExecutor,
    private readonly target: MigrationTarget) {}

  public async boot(sessionIdInput: OrchestrationSessionId, ownerIdInput: string):
    Promise<PostgresRecoveryBootResult> {
    const sessionId = orchestrationSessionId(sessionIdInput);
    const ownerId = orchestrationLeaseOwnerId(ownerIdInput);
    try { return await this.executor.snapshot(async (tx) => {
      const client: PinnedMigrationClient = {
        query: (sql, params) => tx.query(sql, params ?? []), release: () => undefined,
      };
      const capability = await verifyTerminalSchemaCapabilityOnClient(client, this.target);
      if (capability.status !== "VERIFIED") return Object.freeze({ status: "RECOVERY_REJECTED",
        sessionId, reason: "REQUIRED_EVIDENCE_UNAVAILABLE" });
      const recovery = await loadRecoveryStateInTransaction(tx, sessionId);
      if (recovery === null) return Object.freeze({ status: "RECOVERY_REJECTED",
        sessionId, reason: "RECOVERY_STATE_MISSING" });
      const lease = await loadRecoveryLeaseInTransaction(tx, sessionId);
      if (lease !== null && lease.fenceToken !== recovery.fenceToken)
        return Object.freeze({ status: "RECOVERY_REJECTED", sessionId,
          reason: "PERSISTENCE_CORRUPTION" });
      const clock = await tx.query<{ now_ms: unknown }>(
        "SELECT floor(extract(epoch from clock_timestamp()) * 1000)::bigint AS now_ms", []);
      if (clock.rowCount !== 1 || clock.rows.length !== 1)
        throw new PersistenceCorruptionError("Boot lease clock returned an impossible row count");
      const now = safeLeaseBigint(clock.rows[0]!.now_ms, "boot now_ms");
      const validLease = lease !== null && lease.ownerId === ownerId
        && lease.expiresAt !== null && lease.expiresAt > now;
      const checkpoint = recovery.executionAuthorityCheckpointRef === null ? null
        : await loadExecutionAuthorityCheckpointInTransaction(tx, recovery.executionAuthorityCheckpointRef);
      const unresolved = await listUnresolvedEffectsInTransaction(tx, sessionId);
      const resolvedEffects = await listTerminalResolvedEffectsInTransaction(tx, sessionId);
      const pendingEffects: LoadedPendingEffect[] = [];
      for (const effect of unresolved) pendingEffects.push({ effect,
        creationProof: await creationProof(tx, effect), idempotency: await idempotency(tx, effect) });
      const outcomes: LoadedExternalOutcome[] = [];
      if (recovery.executionAuthorityIdentity !== null) {
        const listed = await listExecutionOutcomesInTransaction(tx, sessionId,
          recovery.executionAuthorityIdentity.executionAttemptId);
        for (const outcome of listed) outcomes.push({ outcome,
          adoptionReceipt: await loadExternalOutcomeAdoptionReceiptInTransaction(tx, outcome.outcomeKey) });
      }
      const receiptBySession = await loadTerminalNonSubmissionDispositionReceiptBySessionInTransaction(tx, sessionId);
      const receipt = recovery.schemaVersion === "ORCHESTRATION_RECOVERY_RECORD_V2"
        ? await loadTerminalNonSubmissionDispositionReceiptInTransaction(tx,
          recovery.terminalNonSubmissionDispositionRef) : receiptBySession;
      if (recovery.schemaVersion === "ORCHESTRATION_RECOVERY_RECORD_V2"
          && receiptBySession?.disposition.dispositionRef !== receipt?.disposition.dispositionRef)
        return Object.freeze({ status: "RECOVERY_REJECTED", sessionId,
          reason: "PERSISTENCE_CORRUPTION" });
      const linked = receipt === null ? null
        : await loadPendingEffectInTransaction(tx, receipt.disposition.pendingEffectIdentity);
      const linkedCreation = linked === null ? null : await creationProof(tx, linked);
      const created = receipt === null ? null : await loadExecutionAuthorityCheckpointInTransaction(tx,
        receipt.disposition.pendingCreationRef.committedCheckpointRef);
      const linkedIdempotency = linked === null ? { status: "ABSENT" } as const
        : await idempotency(tx, linked);
      return classifyRecoveryBoot({ recovery, ownerId, lease: validLease ? "VALID" : "INVALID",
        checkpoint: checkpoint === null ? { status: "MISSING" } : { status: "VALID", checkpoint },
        evidence: "COMPLETE", pendingEffects, outcomes,
        terminal: { receipt, pending: linked, resolvedEffects, creationProof: linkedCreation,
          creationCheckpoint: created, idempotency: linkedIdempotency,
          leaseFence: lease?.fenceToken ?? null } });
    }); }
    catch (cause) {
      if (cause instanceof PersistenceCorruptionError
          || cause instanceof ExecutionPersistenceConflictError
          || cause instanceof ExecutionPersistenceCorruptionError)
        return Object.freeze({ status: "RECOVERY_REJECTED", sessionId,
          reason: "PERSISTENCE_CORRUPTION" });
      throw cause;
    }
  }
}
