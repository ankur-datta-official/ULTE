import {
  createExecutionAuthorityCheckpoint,
  executionAuthorityCheckpointId,
  type ExecutionAuthorityCheckpoint,
  type ExecutionAuthorityCheckpointAppendResult,
  type ExecutionAuthorityCheckpointId,
  type ExecutionAuthorityCheckpointStore,
} from "@ulte/orchestration-state-store";
import { mapCheckpointRow, type CheckpointRow } from "./checkpoint-mapping.js";
import { PersistenceCorruptionError, PersistenceInfrastructureError } from "./errors.js";
import type { PostgresExecutor, PostgresQueryResult, PostgresTransaction } from "./postgres.js";

const COLUMNS = `schema_version, checkpoint_ref, evidence_schema_version, execution_attempt_id,
 execution_plan_id, trade_intent_id, candidate_id, instrument_id, evidence_payload`;
const INSERT_SQL = `/* checkpoint:insert */ INSERT INTO orchestration_execution_authority_checkpoint (${COLUMNS})
 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
 ON CONFLICT (checkpoint_ref) DO NOTHING RETURNING ${COLUMNS}`;
const LOAD_SQL = `/* checkpoint:load */ SELECT ${COLUMNS} FROM orchestration_execution_authority_checkpoint
 WHERE checkpoint_ref = $1`;

function atMostOne(result: PostgresQueryResult<CheckpointRow>, operation: string): CheckpointRow | null {
  if (result.rowCount !== result.rows.length || result.rows.length > 1 || result.rowCount < 0) {
    throw new PersistenceCorruptionError(`${operation}: impossible row count`);
  }
  return result.rows[0] ?? null;
}

function sameJson(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (left === null || right === null || typeof left !== "object" || typeof right !== "object") return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length
      && left.every((item, index) => sameJson(item, right[index]));
  }
  const leftKeys = Object.keys(left);
  const rightRecord = right as Readonly<Record<string, unknown>>;
  return leftKeys.length === Object.keys(rightRecord).length
    && leftKeys.every((key) => Object.prototype.hasOwnProperty.call(rightRecord, key)
      && sameJson((left as Readonly<Record<string, unknown>>)[key], rightRecord[key]));
}

function sameCheckpoint(left: ExecutionAuthorityCheckpoint, right: ExecutionAuthorityCheckpoint): boolean {
  return left.schemaVersion === right.schemaVersion && left.checkpointRef === right.checkpointRef
    && sameJson(left.evidence, right.evidence);
}

function values(checkpoint: ExecutionAuthorityCheckpoint): readonly unknown[] {
  const evidence = checkpoint.evidence;
  const identity = evidence.identity;
  return [checkpoint.schemaVersion, checkpoint.checkpointRef, evidence.schemaVersion,
    identity.executionAttemptId, identity.executionPlanId, identity.tradeIntentId,
    identity.candidateId, identity.instrumentId, JSON.stringify(evidence)];
}

async function infrastructure<T>(work: () => Promise<T>): Promise<T> {
  try { return await work(); }
  catch (cause) {
    if (cause instanceof PersistenceCorruptionError || cause instanceof PersistenceInfrastructureError) throw cause;
    throw new PersistenceInfrastructureError("PostgreSQL execution checkpoint operation failed", { cause });
  }
}

async function readCheckpoint(db: PostgresTransaction, ref: ExecutionAuthorityCheckpointId): Promise<ExecutionAuthorityCheckpoint | null> {
  const row = atMostOne(await db.query<CheckpointRow>(LOAD_SQL, [ref]), "Checkpoint load");
  if (row === null) return null;
  const checkpoint = mapCheckpointRow(row);
  if (checkpoint.checkpointRef !== ref) throw new PersistenceCorruptionError("Checkpoint lookup returned another ref");
  return checkpoint;
}

async function append(db: PostgresTransaction, checkpoint: ExecutionAuthorityCheckpoint): Promise<ExecutionAuthorityCheckpointAppendResult> {
  const row = atMostOne(await db.query<CheckpointRow>(INSERT_SQL, values(checkpoint)), "Checkpoint insert");
  if (row !== null) {
    const stored = mapCheckpointRow(row);
    if (!sameCheckpoint(stored, checkpoint)) throw new PersistenceCorruptionError("Checkpoint insert returned contradictory facts");
    return Object.freeze({ status: "APPENDED", checkpoint: stored });
  }
  const existing = await readCheckpoint(db, checkpoint.checkpointRef);
  if (existing === null) throw new PersistenceCorruptionError("Conflicting checkpoint row disappeared");
  return sameCheckpoint(existing, checkpoint)
    ? Object.freeze({ status: "DUPLICATE_SAME", checkpoint: existing })
    : Object.freeze({ status: "CHECKPOINT_CONFLICT", existing });
}

/** Low-level append only. The caller must authorize and advance recovery in the same transaction. */
export function appendExecutionAuthorityCheckpointInTransaction(
  transaction: PostgresTransaction, input: ExecutionAuthorityCheckpoint,
): Promise<ExecutionAuthorityCheckpointAppendResult> {
  const checkpoint = createExecutionAuthorityCheckpoint(input);
  return infrastructure(() => append(transaction, checkpoint));
}

export class PostgresExecutionAuthorityCheckpointStore implements ExecutionAuthorityCheckpointStore {
  public constructor(private readonly executor: PostgresExecutor) {}

  public loadExecutionAuthorityCheckpoint(ref: ExecutionAuthorityCheckpointId): Promise<ExecutionAuthorityCheckpoint | null> {
    const checkpointRef = executionAuthorityCheckpointId(ref);
    return infrastructure(() => readCheckpoint(this.executor, checkpointRef));
  }

  public appendExecutionAuthorityCheckpoint(input: ExecutionAuthorityCheckpoint): Promise<ExecutionAuthorityCheckpointAppendResult> {
    return appendExecutionAuthorityCheckpointInTransaction(this.executor, input);
  }
}
