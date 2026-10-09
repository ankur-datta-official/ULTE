import {
  createOrchestrationRecoveryRecord,
  type OrchestrationRecoveryRecord,
} from "@ulte/orchestration-state-store";
import { PersistenceCorruptionError } from "./errors.js";

export interface RecoveryRow {
  readonly schema_version: unknown;
  readonly session_id: unknown;
  readonly revision: unknown;
  readonly fence_token: unknown;
  readonly mode: unknown;
  readonly instrument_id: unknown;
  readonly execution_authority_checkpoint_ref: unknown;
  readonly execution_attempt_id: unknown;
  readonly execution_plan_id: unknown;
  readonly trade_intent_id: unknown;
  readonly candidate_id: unknown;
  readonly execution_instrument_id: unknown;
  readonly risk_basis_checkpoint_ref: unknown;
  readonly latest_r_outcome_ref: unknown;
  readonly terminal_non_submission_disposition_ref: unknown;
}

function safeBigint(value: unknown, field: string): number {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return value;
  if (typeof value === "string" && /^(0|[1-9]\d*)$/.test(value)) {
    const parsed = BigInt(value);
    if (parsed <= BigInt(Number.MAX_SAFE_INTEGER)) return Number(parsed);
  }
  throw new TypeError(`${field} must be a non-negative safe BIGINT`);
}

export function mapRecoveryRow(row: RecoveryRow): OrchestrationRecoveryRecord {
  try {
    const identity = row.execution_attempt_id === null && row.execution_plan_id === null
      && row.trade_intent_id === null && row.candidate_id === null
      && row.execution_instrument_id === null
      ? null
      : {
          executionAttemptId: row.execution_attempt_id,
          executionPlanId: row.execution_plan_id,
          tradeIntentId: row.trade_intent_id,
          candidateId: row.candidate_id,
          instrumentId: row.execution_instrument_id,
        };
    return createOrchestrationRecoveryRecord({
      schemaVersion: row.schema_version,
      sessionId: row.session_id,
      revision: safeBigint(row.revision, "revision"),
      fenceToken: safeBigint(row.fence_token, "fence_token"),
      mode: row.mode,
      instrumentId: row.instrument_id,
      executionAuthorityCheckpointRef: row.execution_authority_checkpoint_ref,
      executionAuthorityIdentity: identity,
      riskBasisCheckpointRef: row.risk_basis_checkpoint_ref,
      latestROutcomeRef: row.latest_r_outcome_ref,
      ...(row.schema_version === "ORCHESTRATION_RECOVERY_RECORD_V2"
        ? { terminalNonSubmissionDispositionRef: row.terminal_non_submission_disposition_ref }
        : row.terminal_non_submission_disposition_ref === null ? {} : { terminalNonSubmissionDispositionRef: row.terminal_non_submission_disposition_ref }),
    });
  } catch (cause) {
    throw new PersistenceCorruptionError("Invalid orchestration recovery row", { cause });
  }
}
