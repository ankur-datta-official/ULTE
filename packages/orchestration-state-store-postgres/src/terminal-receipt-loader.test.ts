import { describe, expect, it } from "vitest";
import { createTerminalNonSubmissionDispositionReceiptV1 } from "@ulte/orchestration-state-store";
import { PersistenceCorruptionError, PostgresOrchestrationReceiptStore,
  loadTerminalNonSubmissionDispositionReceiptInTransaction,
  loadTerminalNonSubmissionDispositionReceiptBySessionInTransaction,
  loadTerminalNonSubmissionDispositionReceiptByIdentityInTransaction,
  type PostgresExecutor, type PostgresQueryResult, type PostgresTransaction } from "./index.js";
import { mapTerminalReceiptRow } from "./terminal-receipt-mapping.js";

const identity = { adapterId: "adapter-1", environment: "SANDBOX", operation: "ENTRY_SUBMISSION",
  executionAttemptId: "attempt-1", idempotencyKey: "key-1", requestFingerprint: "fingerprint-1" };
const proof = { schemaVersion: "TERMINAL_NON_SUBMISSION_PROOF_V1",
  sourceKind: "TRUSTED_ADAPTER_FAILURE", sourceEventRef: "event-1", observedAt: 1234,
  category: "INVALID_REQUEST", certainty: "DEFINITE_FAILURE", submissionExposure: "NOT_SUBMITTED",
  retryDisposition: "DO_NOT_RETRY", pendingEffectIdentity: identity };
const disposition = { schemaVersion: "TERMINAL_NON_SUBMISSION_DISPOSITION_V1",
  dispositionRef: "terminal-1", sessionId: "session-1", executionAttemptId: "attempt-1",
  pendingEffectIdentity: identity, pendingCreatedRevision: 2, pendingCreatedFence: 5,
  pendingCreationRef: { kind: "PENDING_INTENT_COMMIT", committedCheckpointRef: "checkpoint-2",
    committedRevision: 2 }, expectedRecoveryRevision: 3, committedRevision: 4,
  committedFence: 7, committingOwnerId: "owner-1",
  executionAuthorityCheckpointRefBefore: "checkpoint-3",
  executionAuthorityCheckpointRefAfter: "checkpoint-3",
  executionAuthorityIdentity: { executionAttemptId: "attempt-1", executionPlanId: "plan-1",
    tradeIntentId: "intent-1", candidateId: "candidate-1", instrumentId: "ulte:v1:venue:EQUITY:ABC" },
  mode: "SANDBOX", instrumentId: "ulte:v1:venue:EQUITY:ABC",
  riskBasisCheckpointRef: "risk-1", latestROutcomeRef: "r-1",
  proof, sessionDisposition: "TERMINAL_NON_SUBMISSION",
  resolution: { kind: "TERMINAL_NON_SUBMISSION", resolvedRevision: 4, resolvedFence: 7 } };
const receipt = createTerminalNonSubmissionDispositionReceiptV1({
  schemaVersion: "TERMINAL_NON_SUBMISSION_DISPOSITION_RECEIPT_V1", disposition });
function row() {
  return { schema_version: receipt.schemaVersion, disposition_ref: "terminal-1", session_id: "session-1",
    adapter_id: "adapter-1", environment: "SANDBOX", operation: "ENTRY_SUBMISSION",
    execution_attempt_id: "attempt-1", idempotency_key: "key-1", request_fingerprint: "fingerprint-1",
    expected_revision: "3", committed_revision: "4", committed_fence: "7",
    committing_owner_id: "owner-1", unchanged_checkpoint_ref: "checkpoint-3",
    source_event_ref: "event-1", observed_at_ms: "1234", proof_payload: proof,
    commit_payload: JSON.parse(JSON.stringify(receipt)) as unknown };
}
class Fake implements PostgresExecutor {
  public stored: ReturnType<typeof row> | null = row();
  public async query<T>(sql: string, params: readonly unknown[]): Promise<PostgresQueryResult<T>> {
    const found = this.stored && (sql.includes("terminal-ref-load") && params[0] === this.stored.disposition_ref
      || sql.includes("terminal-session-load") && params[0] === this.stored.session_id
      || sql.includes("terminal-identity-load") && params[0] === this.stored.adapter_id
        && params[1] === this.stored.environment && params[2] === this.stored.idempotency_key);
    const rows = found ? [this.stored] : [];
    return { rows: rows as readonly T[], rowCount: rows.length };
  }
  public transaction<T>(work: (tx: PostgresTransaction) => Promise<T>): Promise<T> { return work(this); }
}

describe("terminal disposition receipt read boundary", () => {
  it("loads the canonical immutable receipt by ref, session and exact environment identity", async () => {
    const db = new Fake(), store = new PostgresOrchestrationReceiptStore(db);
    expect(await store.loadTerminalNonSubmissionDispositionReceipt("terminal-1" as never)).toEqual(receipt);
    expect(await store.loadTerminalNonSubmissionDispositionReceiptBySession("session-1" as never)).toEqual(receipt);
    expect(await store.loadTerminalNonSubmissionDispositionReceiptByIdentity("adapter-1", "SANDBOX", "key-1"))
      .toEqual(receipt);
    expect(await loadTerminalNonSubmissionDispositionReceiptInTransaction(db, "terminal-1" as never)).toEqual(receipt);
    expect(await loadTerminalNonSubmissionDispositionReceiptBySessionInTransaction(db, "session-1" as never)).toEqual(receipt);
    expect(await loadTerminalNonSubmissionDispositionReceiptByIdentityInTransaction(db,
      "adapter-1", "SANDBOX", "key-1")).toEqual(receipt);
    expect(await store.loadTerminalNonSubmissionDispositionReceiptByIdentity("adapter-1", "DRY_RUN", "key-1"))
      .toBeNull();
  });
  it("rejects malformed proof, commit, revision, checkpoint and flattened identity", () => {
    for (const changed of [
      { proof_payload: { ...proof, retryDisposition: "RETRY_SAFE" } },
      { commit_payload: { ...receipt, disposition: { ...disposition,
        proof: { ...proof, submissionExposure: "MAY_HAVE_BEEN_SUBMITTED" } } } },
      { commit_payload: { ...receipt, disposition: { ...disposition, committedRevision: 5 } } },
      { commit_payload: { ...receipt, disposition: { ...disposition,
        executionAuthorityCheckpointRefAfter: "checkpoint-4" } } },
      { environment: "DRY_RUN" }, { committed_fence: "9007199254740992" },
    ]) expect(() => mapTerminalReceiptRow({ ...row(), ...changed })).toThrow(PersistenceCorruptionError);
  });
  it("treats malformed durable data as corruption through the loader", async () => {
    const db = new Fake(); db.stored = { ...row(), proof_payload: { invalid: true } };
    await expect(new PostgresOrchestrationReceiptStore(db)
      .loadTerminalNonSubmissionDispositionReceipt("terminal-1" as never))
      .rejects.toBeInstanceOf(PersistenceCorruptionError);
  });
});
