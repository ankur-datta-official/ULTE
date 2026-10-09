import { createTerminalNonSubmissionDispositionReceiptV1, equalCanonicalJson,
  type TerminalNonSubmissionDispositionReceiptV1 } from "@ulte/orchestration-state-store";
import { PersistenceCorruptionError } from "./errors.js";

export interface TerminalReceiptRow {
  readonly schema_version: unknown; readonly disposition_ref: unknown; readonly session_id: unknown;
  readonly adapter_id: unknown; readonly environment: unknown; readonly operation: unknown;
  readonly execution_attempt_id: unknown; readonly idempotency_key: unknown;
  readonly request_fingerprint: unknown; readonly expected_revision: unknown;
  readonly committed_revision: unknown; readonly committed_fence: unknown;
  readonly committing_owner_id: unknown; readonly unchanged_checkpoint_ref: unknown;
  readonly source_event_ref: unknown; readonly observed_at_ms: unknown;
  readonly proof_payload: unknown; readonly commit_payload: unknown;
}

function bigint(value: unknown): number {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return value;
  if (typeof value === "string" && /^(0|[1-9]\d*)$/.test(value)
      && BigInt(value) <= BigInt(Number.MAX_SAFE_INTEGER)) return Number(value);
  throw new TypeError("Invalid terminal receipt BIGINT");
}

export function mapTerminalReceiptRow(row: TerminalReceiptRow): TerminalNonSubmissionDispositionReceiptV1 {
  try {
    const receipt = createTerminalNonSubmissionDispositionReceiptV1(row.commit_payload);
    const d = receipt.disposition, p = d.pendingEffectIdentity;
    if (row.schema_version !== receipt.schemaVersion || row.disposition_ref !== d.dispositionRef
        || row.session_id !== d.sessionId || row.adapter_id !== p.adapterId
        || row.environment !== p.environment || row.operation !== p.operation
        || row.execution_attempt_id !== d.executionAttemptId || row.execution_attempt_id !== p.executionAttemptId
        || row.idempotency_key !== p.idempotencyKey || row.request_fingerprint !== p.requestFingerprint
        || bigint(row.expected_revision) !== d.expectedRecoveryRevision
        || bigint(row.committed_revision) !== d.committedRevision
        || bigint(row.committed_fence) !== d.committedFence
        || row.committing_owner_id !== d.committingOwnerId
        || row.unchanged_checkpoint_ref !== d.executionAuthorityCheckpointRefBefore
        || row.source_event_ref !== d.proof.sourceEventRef
        || bigint(row.observed_at_ms) !== d.proof.observedAt
        || !equalCanonicalJson(row.proof_payload, d.proof)) {
      throw new TypeError("Terminal receipt columns disagree with canonical payload");
    }
    return receipt;
  } catch (cause) {
    throw new PersistenceCorruptionError("Invalid terminal disposition receipt row", { cause });
  }
}
