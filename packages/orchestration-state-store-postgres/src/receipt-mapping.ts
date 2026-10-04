import {
  createExternalOutcomeAdoptionReceipt, createPendingIntentCommitReceipt,
  executionAuthorityCheckpointId, orchestrationFenceToken, orchestrationLeaseOwnerId,
  orchestrationOutcomeKey, orchestrationRevision, orchestrationSessionId,
  ORCHESTRATION_EXTERNAL_OUTCOME_ADOPTION_RECEIPT_V1,
  ORCHESTRATION_PENDING_INTENT_COMMIT_RECEIPT_V1,
  type ExecutionAuthorityCheckpoint, type ExternalOutcomeAdoptionReceipt,
  type OrchestrationExternalOutcome, type PendingIntentCommitReceipt,
} from "@ulte/orchestration-state-store";
import { PersistenceCorruptionError } from "./errors.js";
import { safeEffectBigint } from "./effect-mapping.js";

export interface PendingReceiptRow {
  readonly schema_version: unknown; readonly adapter_id: unknown; readonly idempotency_key: unknown;
  readonly session_id: unknown; readonly expected_revision: unknown; readonly committed_revision: unknown;
  readonly committed_fence: unknown; readonly committing_owner_id: unknown;
  readonly previous_checkpoint_ref: unknown; readonly committed_checkpoint_ref: unknown;
  readonly commit_payload: unknown;
}
export interface AdoptionReceiptRow {
  readonly schema_version: unknown; readonly outcome_key: unknown; readonly session_id: unknown;
  readonly execution_attempt_id: unknown; readonly expected_revision: unknown; readonly adopted_revision: unknown;
  readonly adopted_fence: unknown; readonly adopting_owner_id: unknown;
  readonly previous_checkpoint_ref: unknown; readonly committed_checkpoint_ref: unknown;
  readonly commit_payload: unknown;
}

function canonicalText(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value)
    throw new TypeError(`Invalid ${field}`);
  return value;
}
function payload(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)
      || Object.getPrototypeOf(value) !== Object.prototype) throw new TypeError("Invalid receipt JSONB object");
  return value as Record<string, unknown>;
}
function revisions(expected: unknown, committed: unknown, fence: unknown): readonly [number, number, number] {
  const before = orchestrationRevision(safeEffectBigint(expected, "expected_revision"));
  const after = orchestrationRevision(safeEffectBigint(committed, "committed_revision"));
  const token = orchestrationFenceToken(safeEffectBigint(fence, "receipt fence"));
  if (before >= Number.MAX_SAFE_INTEGER || after !== before + 1) throw new TypeError("Invalid receipt revision advance");
  return [before, after, token];
}

/** Parse references before loading immutable dependencies; all row fields remain untrusted. */
export function receiptCheckpointRefs(row: PendingReceiptRow | AdoptionReceiptRow): readonly [
  ExecutionAuthorityCheckpoint["checkpointRef"], ExecutionAuthorityCheckpoint["checkpointRef"],
] {
  try {
    const previous = executionAuthorityCheckpointId(row.previous_checkpoint_ref);
    const committed = executionAuthorityCheckpointId(row.committed_checkpoint_ref);
    if (previous === committed) throw new TypeError("Receipt checkpoint refs must differ");
    return [previous, committed];
  } catch (cause) { throw new PersistenceCorruptionError("Invalid receipt checkpoint refs", { cause }); }
}

export function mapPendingReceiptRow(row: PendingReceiptRow, previous: ExecutionAuthorityCheckpoint,
  committed: ExecutionAuthorityCheckpoint): PendingIntentCommitReceipt {
  try {
    if (row.schema_version !== ORCHESTRATION_PENDING_INTENT_COMMIT_RECEIPT_V1)
      throw new TypeError("Invalid pending receipt schema");
    const adapter = canonicalText(row.adapter_id, "adapter_id");
    const key = canonicalText(row.idempotency_key, "idempotency_key");
    const session = orchestrationSessionId(row.session_id);
    const [expected, revision, fence] = revisions(row.expected_revision, row.committed_revision, row.committed_fence);
    const owner = orchestrationLeaseOwnerId(row.committing_owner_id);
    const [previousRef, committedRef] = receiptCheckpointRefs(row);
    const receipt = createPendingIntentCommitReceipt(payload(row.commit_payload), previous, committed);
    if (receipt.schemaVersion !== row.schema_version || receipt.pendingEffect.adapterId !== adapter
        || receipt.pendingEffect.idempotencyKey !== key || receipt.sessionId !== session
        || receipt.expectedRevision !== expected || receipt.committedRevision !== revision
        || receipt.committedFence !== fence || receipt.committingOwnerId !== owner
        || receipt.previousCheckpointRef !== previousRef || receipt.committedCheckpointRef !== committedRef)
      throw new TypeError("Pending receipt columns contradict payload");
    return receipt;
  } catch (cause) { throw new PersistenceCorruptionError("Invalid pending-intent commit receipt row", { cause }); }
}

export function mapAdoptionReceiptRow(row: AdoptionReceiptRow, previous: ExecutionAuthorityCheckpoint,
  committed: ExecutionAuthorityCheckpoint, outcome: OrchestrationExternalOutcome): ExternalOutcomeAdoptionReceipt {
  try {
    if (row.schema_version !== ORCHESTRATION_EXTERNAL_OUTCOME_ADOPTION_RECEIPT_V1)
      throw new TypeError("Invalid adoption receipt schema");
    const key = orchestrationOutcomeKey(row.outcome_key);
    const session = orchestrationSessionId(row.session_id);
    const attempt = canonicalText(row.execution_attempt_id, "execution_attempt_id");
    const [expected, revision, fence] = revisions(row.expected_revision, row.adopted_revision, row.adopted_fence);
    const owner = orchestrationLeaseOwnerId(row.adopting_owner_id);
    const [previousRef, committedRef] = receiptCheckpointRefs(row);
    const receipt = createExternalOutcomeAdoptionReceipt(payload(row.commit_payload), previous, committed, outcome);
    if (receipt.schemaVersion !== row.schema_version || receipt.outcomeKey !== key
        || receipt.sessionId !== session || receipt.executionAttemptId !== attempt
        || receipt.expectedRevision !== expected || receipt.adoptedRevision !== revision
        || receipt.adoptedFence !== fence || receipt.adoptingOwnerId !== owner
        || receipt.previousCheckpointRef !== previousRef || receipt.committedCheckpointRef !== committedRef)
      throw new TypeError("Adoption receipt columns contradict payload");
    return receipt;
  } catch (cause) { throw new PersistenceCorruptionError("Invalid external-outcome adoption receipt row", { cause }); }
}
