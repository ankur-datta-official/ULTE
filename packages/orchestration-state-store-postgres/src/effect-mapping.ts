import {
  createOrchestrationExternalOutcome, createOrchestrationPendingEffect,
  type OrchestrationExternalOutcome, type OrchestrationPendingEffect,
} from "@ulte/orchestration-state-store";
import { PersistenceCorruptionError } from "./errors.js";

export interface PendingRow {
  readonly schema_version: unknown; readonly session_id: unknown;
  readonly adapter_id: unknown; readonly environment: unknown; readonly operation: unknown;
  readonly execution_attempt_id: unknown; readonly idempotency_key: unknown;
  readonly request_fingerprint: unknown; readonly created_revision: unknown;
  readonly created_fence: unknown; readonly state: unknown;
  readonly resolved_outcome_key: unknown; readonly resolved_revision: unknown;
  readonly resolved_fence: unknown;
}

export interface OutcomeRow {
  readonly schema_version: unknown; readonly outcome_key: unknown;
  readonly session_id: unknown; readonly execution_attempt_id: unknown;
  readonly observed_at_ms: unknown; readonly observed_fence: unknown;
  readonly pending_adapter_id: unknown; readonly pending_environment: unknown;
  readonly pending_operation: unknown; readonly pending_execution_attempt_id: unknown;
  readonly pending_idempotency_key: unknown; readonly pending_request_fingerprint: unknown;
  readonly observation_kind: unknown; readonly observation_payload: unknown;
}

export function safeEffectBigint(value: unknown, field: string): number {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return value;
  if (typeof value === "string" && /^(0|[1-9]\d*)$/.test(value)) {
    const parsed = BigInt(value);
    if (parsed <= BigInt(Number.MAX_SAFE_INTEGER)) return Number(parsed);
  }
  throw new PersistenceCorruptionError(`Invalid ${field} BIGINT`);
}

export function mapPendingRow(row: PendingRow): OrchestrationPendingEffect {
  try {
    return createOrchestrationPendingEffect({
      schemaVersion: row.schema_version, sessionId: row.session_id,
      adapterId: row.adapter_id, environment: row.environment, operation: row.operation,
      executionAttemptId: row.execution_attempt_id, idempotencyKey: row.idempotency_key,
      requestFingerprint: row.request_fingerprint,
      createdRevision: safeEffectBigint(row.created_revision, "created_revision"),
      createdFence: safeEffectBigint(row.created_fence, "created_fence"),
      state: row.state, resolvedOutcomeKey: row.resolved_outcome_key,
      resolvedRevision: row.resolved_revision === null ? null : safeEffectBigint(row.resolved_revision, "resolved_revision"),
      resolvedFence: row.resolved_fence === null ? null : safeEffectBigint(row.resolved_fence, "resolved_fence"),
    });
  } catch (cause) {
    throw new PersistenceCorruptionError("Invalid orchestration pending effect row", { cause });
  }
}

export function mapOutcomeRow(row: OutcomeRow): OrchestrationExternalOutcome {
  try {
    const pending = row.pending_adapter_id === null && row.pending_environment === null
      && row.pending_operation === null && row.pending_execution_attempt_id === null
      && row.pending_idempotency_key === null && row.pending_request_fingerprint === null
      ? null : {
        adapterId: row.pending_adapter_id, environment: row.pending_environment,
        operation: row.pending_operation, executionAttemptId: row.pending_execution_attempt_id,
        idempotencyKey: row.pending_idempotency_key, requestFingerprint: row.pending_request_fingerprint,
      };
    return createOrchestrationExternalOutcome({
      schemaVersion: row.schema_version, outcomeKey: row.outcome_key,
      sessionId: row.session_id, executionAttemptId: row.execution_attempt_id,
      observedAt: safeEffectBigint(row.observed_at_ms, "observed_at_ms"),
      observedFence: safeEffectBigint(row.observed_fence, "observed_fence"),
      pendingEffectIdentity: pending,
      observation: { kind: row.observation_kind,
        ...(row.observation_kind === "CANONICAL_EXECUTION_TRANSITION"
          ? { transition: row.observation_payload } : { disposition: row.observation_payload }) },
    });
  } catch (cause) {
    throw new PersistenceCorruptionError("Invalid orchestration external outcome row", { cause });
  }
}
