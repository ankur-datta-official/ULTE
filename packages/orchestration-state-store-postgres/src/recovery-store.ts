import {
  createOrchestrationRecoveryRecord,
  orchestrationSessionId,
  ORCHESTRATION_RECOVERY_RECORD_SCHEMA_VERSION,
  type OrchestrationRecoveryRecord,
  type OrchestrationRecoverySaveResult,
  type OrchestrationRecoveryStore,
  type OrchestrationRecoveryWrite,
  type OrchestrationSessionId,
} from "@ulte/orchestration-state-store";
import { PersistenceConflictError, PersistenceCorruptionError } from "./errors.js";
import { mapRecoveryRow, type RecoveryRow } from "./mapping.js";
import type { PostgresExecutor, PostgresTransaction } from "./postgres.js";

const COLUMNS = `schema_version, session_id, revision, fence_token, mode, instrument_id,
  execution_authority_checkpoint_ref, execution_attempt_id, execution_plan_id,
  trade_intent_id, candidate_id, execution_instrument_id,
  risk_basis_checkpoint_ref, latest_r_outcome_ref`;

const LOAD_SQL = `/* orchestration-state-store-postgres:load */
SELECT ${COLUMNS} FROM orchestration_recovery_state WHERE session_id = $1`;

const INSERT_SQL = `/* orchestration-state-store-postgres:initialize-insert */
INSERT INTO orchestration_recovery_state (${COLUMNS})
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
ON CONFLICT (session_id) DO NOTHING
RETURNING ${COLUMNS}`;

const LOCK_SQL = `/* orchestration-state-store-postgres:select-for-update */
SELECT ${COLUMNS} FROM orchestration_recovery_state WHERE session_id = $1 FOR UPDATE`;

const UPDATE_SQL = `/* orchestration-state-store-postgres:save-update */
UPDATE orchestration_recovery_state
SET revision = $4, mode = $5, instrument_id = $6,
  execution_authority_checkpoint_ref = $7, execution_attempt_id = $8,
  execution_plan_id = $9, trade_intent_id = $10, candidate_id = $11,
  execution_instrument_id = $12, risk_basis_checkpoint_ref = $13,
  latest_r_outcome_ref = $14
WHERE session_id = $1 AND revision = $2 AND fence_token = $3
RETURNING ${COLUMNS}`;

function values(record: OrchestrationRecoveryRecord): readonly unknown[] {
  const identity = record.executionAuthorityIdentity;
  return [
    record.schemaVersion, record.sessionId, record.revision, record.fenceToken,
    record.mode, record.instrumentId, record.executionAuthorityCheckpointRef,
    identity?.executionAttemptId ?? null, identity?.executionPlanId ?? null,
    identity?.tradeIntentId ?? null, identity?.candidateId ?? null,
    identity?.instrumentId ?? null, record.riskBasisCheckpointRef, record.latestROutcomeRef,
  ];
}

function validatedWrite(write: OrchestrationRecoveryWrite): OrchestrationRecoveryRecord {
  return createOrchestrationRecoveryRecord({
    schemaVersion: ORCHESTRATION_RECOVERY_RECORD_SCHEMA_VERSION,
    sessionId: write.sessionId,
    revision: write.expectedRevision,
    fenceToken: write.expectedFence,
    mode: write.state.mode,
    instrumentId: write.state.instrumentId,
    executionAuthorityCheckpointRef: write.state.executionAuthorityCheckpointRef,
    executionAuthorityIdentity: write.state.executionAuthorityIdentity,
    riskBasisCheckpointRef: write.state.riskBasisCheckpointRef,
    latestROutcomeRef: write.state.latestROutcomeRef,
  });
}

function singleRow(rows: readonly RecoveryRow[], context: string): OrchestrationRecoveryRecord {
  if (rows.length !== 1) throw new PersistenceCorruptionError(`${context} expected exactly one row`);
  return mapRecoveryRow(rows[0]!);
}

async function lockedRecord(transaction: PostgresTransaction, sessionId: OrchestrationSessionId): Promise<OrchestrationRecoveryRecord | null> {
  const selected = await transaction.query<RecoveryRow>(LOCK_SQL, [sessionId]);
  if (selected.rowCount !== selected.rows.length || selected.rows.length > 1 || selected.rowCount < 0)
    throw new PersistenceCorruptionError("Locked recovery lookup returned an impossible row count");
  if (selected.rows.length === 0) return null;
  const record = singleRow(selected.rows, "Locked recovery lookup");
  if (record.sessionId !== sessionId) throw new PersistenceCorruptionError("Locked recovery session mismatch");
  return record;
}

function saved(rows: readonly RecoveryRow[], sessionId: OrchestrationSessionId, revision: number, fence: number): OrchestrationRecoverySaveResult {
  const record = singleRow(rows, "Recovery mutation");
  if (record.sessionId !== sessionId || record.revision !== revision || record.fenceToken !== fence) {
    throw new PersistenceCorruptionError("Recovery mutation returned a mismatched identity or version");
  }
  return Object.freeze({ status: "SAVED", record, newRevision: record.revision });
}

export class PostgresOrchestrationRecoveryStore implements OrchestrationRecoveryStore {
  public constructor(private readonly executor: PostgresExecutor) {}

  public async loadRecoveryState(sessionId: OrchestrationSessionId): Promise<OrchestrationRecoveryRecord | null> {
    const validId = orchestrationSessionId(sessionId);
    const result = await this.executor.query<RecoveryRow>(LOAD_SQL, [validId]);
    if (result.rows.length === 0) return null;
    const record = singleRow(result.rows, "Recovery load");
    if (record.sessionId !== validId) throw new PersistenceCorruptionError("Recovery load session mismatch");
    return record;
  }

  public initializeRecoveryState(write: OrchestrationRecoveryWrite): Promise<OrchestrationRecoverySaveResult> {
    const candidate = validatedWrite(write);
    if (candidate.revision !== 0) throw new RangeError("Initialization requires expectedRevision 0");
    return this.executor.transaction(async (transaction) => {
      const inserted = await transaction.query<RecoveryRow>(INSERT_SQL, values(candidate));
      if (inserted.rows.length === 1) return saved(inserted.rows, candidate.sessionId, 0, candidate.fenceToken);
      if (inserted.rows.length !== 0) throw new PersistenceCorruptionError("Initialization returned multiple rows");
      const current = await lockedRecord(transaction, candidate.sessionId);
      if (current === null) throw new PersistenceConflictError("CONCURRENT_RECOVERY_CONFLICT", "Conflicting initialization row disappeared");
      if (current.fenceToken !== candidate.fenceToken) {
        return Object.freeze({ status: "FENCE_CONFLICT", currentFence: current.fenceToken });
      }
      return Object.freeze({ status: "REVISION_CONFLICT", currentRevision: current.revision });
    });
  }

  public saveRecoveryState(write: OrchestrationRecoveryWrite): Promise<OrchestrationRecoverySaveResult> {
    return this.executor.transaction((transaction) => saveRecoveryStateInTransaction(transaction, write));
  }
}

/** Caller must acquire the lease row before this recovery row in a composed B1E mutation. */
export async function saveRecoveryStateInTransaction(transaction: PostgresTransaction,
  write: OrchestrationRecoveryWrite): Promise<OrchestrationRecoverySaveResult> {
  const candidate = validatedWrite(write);
  const current = await lockedRecord(transaction, candidate.sessionId);
  if (current === null) return Object.freeze({ status: "NOT_FOUND" });
  if (current.fenceToken !== candidate.fenceToken) {
    return Object.freeze({ status: "FENCE_CONFLICT", currentFence: current.fenceToken });
  }
  if (current.revision !== candidate.revision) {
    return Object.freeze({ status: "REVISION_CONFLICT", currentRevision: current.revision });
  }
  if (candidate.revision === Number.MAX_SAFE_INTEGER) {
    throw new PersistenceConflictError("REVISION_OVERFLOW", "Recovery revision cannot exceed MAX_SAFE_INTEGER");
  }
  const nextRevision = candidate.revision + 1;
  const updated = await transaction.query<RecoveryRow>(UPDATE_SQL, [
    candidate.sessionId, candidate.revision, candidate.fenceToken, nextRevision,
    ...values(candidate).slice(4),
  ]);
  if (updated.rowCount !== updated.rows.length || updated.rows.length > 1 || updated.rowCount < 0)
    throw new PersistenceCorruptionError("Conditional recovery update returned an impossible row count");
  if (updated.rows.length !== 1) {
    throw new PersistenceConflictError("CONCURRENT_RECOVERY_CONFLICT", "Conditional recovery update returned no single row");
  }
  return saved(updated.rows, candidate.sessionId, nextRevision, candidate.fenceToken);
}
