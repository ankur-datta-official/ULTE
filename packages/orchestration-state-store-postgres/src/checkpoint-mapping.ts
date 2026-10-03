import {
  createExecutionAuthorityCheckpoint,
  type ExecutionAuthorityCheckpoint,
} from "@ulte/orchestration-state-store";
import { PersistenceCorruptionError } from "./errors.js";

export interface CheckpointRow {
  readonly schema_version: unknown;
  readonly checkpoint_ref: unknown;
  readonly evidence_schema_version: unknown;
  readonly execution_attempt_id: unknown;
  readonly execution_plan_id: unknown;
  readonly trade_intent_id: unknown;
  readonly candidate_id: unknown;
  readonly instrument_id: unknown;
  readonly evidence_payload: unknown;
}

/** Every JSONB load is untrusted, including rows returned by INSERT. */
export function mapCheckpointRow(row: CheckpointRow): ExecutionAuthorityCheckpoint {
  try {
    const checkpoint = createExecutionAuthorityCheckpoint({
      schemaVersion: row.schema_version,
      checkpointRef: row.checkpoint_ref,
      evidence: row.evidence_payload,
    });
    const identity = checkpoint.evidence.identity;
    if (row.evidence_schema_version !== checkpoint.evidence.schemaVersion
        || row.execution_attempt_id !== identity.executionAttemptId
        || row.execution_plan_id !== identity.executionPlanId
        || row.trade_intent_id !== identity.tradeIntentId
        || row.candidate_id !== identity.candidateId
        || row.instrument_id !== identity.instrumentId) {
      throw new TypeError("Checkpoint identity columns contradict evidence");
    }
    return checkpoint;
  } catch (cause) {
    throw new PersistenceCorruptionError("Invalid execution authority checkpoint row", { cause });
  }
}
