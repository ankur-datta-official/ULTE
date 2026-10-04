import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { brokerAdapterId, fingerprintEntrySubmission, fingerprintProtectionRequest } from "@ulte/broker-adapters";
import { requestEntrySubmission, requestProtection, restoreExecutionAttemptFromEvidence,
  type ExecutionAttemptRecoveryTransition } from "@ulte/execution-engine";
import { checkpointEvidence } from "../../../tests/integration/phase33b-checkpoint-fixture.js";
import {
  createExecutionAuthorityCheckpoint, createExternalOutcomeAdoptionReceipt,
  createOrchestrationExternalOutcome, createOrchestrationPendingEffect, createPendingIntentCommitReceipt,
  proveOutcomeAdoptionCheckpointAdvance, provePendingIntentCheckpointAdvance,
  type ExternalOutcomeAdoptionReceipt, type PendingIntentCommitReceipt,
} from "@ulte/orchestration-state-store";
import { mapAdoptionReceiptRow, mapPendingReceiptRow } from "./receipt-mapping.js";
import { appendExternalOutcomeAdoptionReceiptInTransaction, appendPendingIntentCommitReceiptInTransaction,
  loadExternalOutcomeAdoptionReceiptInTransaction, loadPendingIntentCommitReceiptInTransaction,
  loadAdoptionCreationProofInTransaction,
  PersistenceCorruptionError, PersistenceInfrastructureError, PostgresOrchestrationReceiptStore,
  type PostgresExecutor, type PostgresQueryResult, type PostgresTransaction } from "./index.js";

const base = checkpointEvidence();
const capabilities = { supportsClientIdempotency: false, supportsCloseOnlyExit: true,
  supportsNativeBracketProtection: false, supportsProtectionModification: true,
  supportsOrderCancellation: true, supportsPartialFillReporting: true };
const requested = { kind: "ENTRY_SUBMISSION_REQUESTED", adapterCapabilities: capabilities } as const;
function cp(ref: string, transitions: readonly ExecutionAttemptRecoveryTransition[]) {
  return createExecutionAuthorityCheckpoint({ schemaVersion: "EXECUTION_AUTHORITY_CHECKPOINT_V1",
    checkpointRef: ref, evidence: { ...base, transitions } });
}
const before = cp("before", []);
const after = cp("after", [requested]);
const restored = restoreExecutionAttemptFromEvidence(base);
if (restored.status !== "EXECUTION_ATTEMPT_RESTORED") throw new Error("Invalid test evidence");
const entry = requestEntrySubmission(restored.executionAttempt, capabilities);
if (entry.status !== "ENTRY_SUBMISSION_READY") throw new Error("Invalid test request");
const acknowledged = { kind: "ENTRY_SUBMISSION_ACKNOWLEDGED", acknowledgement: {
  executionAttemptId: base.identity.executionAttemptId, idempotencyKey: entry.request.idempotencyKey,
  adapterOrderId: "order-1", acknowledgedAt: 2_100_101 } } as const;
const adopted = cp("adopted", [requested, acknowledged]);
const filled = { kind: "ENTRY_FILL_APPLIED", fill: {
  executionAttemptId: base.identity.executionAttemptId, adapterOrderId: "order-1", fillId: "fill-1",
  filledQuantity: "1", fillPrice: entry.request.limitPrice, filledAt: 2_100_102 } } as const;
const filledCheckpoint = cp("filled", [requested, acknowledged, filled]);
const nextCheckpoint = cp("next", [requested, acknowledged, filled, { kind: "PROTECTION_REQUESTED" }]);
const effect = createOrchestrationPendingEffect({ schemaVersion: "ORCHESTRATION_PENDING_EFFECT_V1",
  sessionId: "session-1", adapterId: brokerAdapterId("adapter-1"), environment: "SANDBOX",
  operation: "ENTRY_SUBMISSION", executionAttemptId: base.identity.executionAttemptId,
  idempotencyKey: entry.request.idempotencyKey, requestFingerprint: fingerprintEntrySubmission(entry.request),
  createdRevision: 2, createdFence: 3, state: "PENDING", resolvedOutcomeKey: null,
  resolvedRevision: null, resolvedFence: null });
const outcome = createOrchestrationExternalOutcome({ schemaVersion: "ORCHESTRATION_EXTERNAL_OUTCOME_V1",
  outcomeKey: "outcome-1", sessionId: "session-1", executionAttemptId: base.identity.executionAttemptId,
  observedAt: 2_100_103, observedFence: 3,
  pendingEffectIdentity: { adapterId: effect.adapterId, environment: effect.environment,
    operation: effect.operation, executionAttemptId: effect.executionAttemptId,
    idempotencyKey: effect.idempotencyKey, requestFingerprint: effect.requestFingerprint },
  observation: { kind: "CANONICAL_EXECUTION_TRANSITION", transition: acknowledged } });
function recovery(ref: string) {
  return { mode: "SANDBOX", instrumentId: base.identity.instrumentId,
    executionAuthorityCheckpointRef: ref, executionAuthorityIdentity: base.identity,
    riskBasisCheckpointRef: null, latestROutcomeRef: null };
}
function pendingReceipt(): PendingIntentCommitReceipt {
  return createPendingIntentCommitReceipt({ schemaVersion: "ORCHESTRATION_PENDING_INTENT_COMMIT_RECEIPT_V1",
    sessionId: "session-1", expectedRevision: 1, committedRevision: 2, committedFence: 3,
    committingOwnerId: "owner-1", previousCheckpointRef: "before", committedCheckpointRef: "after",
    resultingRecoveryState: recovery("after"), pendingEffect: effect,
    advanceProof: provePendingIntentCheckpointAdvance({ previousCheckpoint: before,
      committedCheckpoint: after, pendingEffect: effect }) }, before, after);
}
function adoptionReceipt(): ExternalOutcomeAdoptionReceipt {
  const proof = proveOutcomeAdoptionCheckpointAdvance({ previousCheckpoint: after,
    committedCheckpoint: adopted, outcome, nextPendingEffect: null });
  if (proof.status !== "PROVEN") throw new Error("Invalid adoption proof");
  return createExternalOutcomeAdoptionReceipt({ schemaVersion: "ORCHESTRATION_EXTERNAL_OUTCOME_ADOPTION_RECEIPT_V1",
    outcomeKey: outcome.outcomeKey, sessionId: "session-1", executionAttemptId: outcome.executionAttemptId,
    expectedRevision: 2, adoptedRevision: 3, adoptedFence: 3, adoptingOwnerId: "owner-1",
    previousCheckpointRef: "after", committedCheckpointRef: "adopted",
    resultingRecoveryState: recovery("adopted"), linkedPendingResolution: {
      pendingEffectIdentity: outcome.pendingEffectIdentity, outcomeKey: outcome.outcomeKey,
      resolvedRevision: 3, resolvedFence: 3 }, nextPendingEffect: null, nextPendingCommit: null,
    advanceProof: proof.proof }, after, adopted, outcome);
}
type Row = Record<string, unknown>;
const checkpointRows = [before, after, adopted, filledCheckpoint, nextCheckpoint].map((value) => [value.checkpointRef, {
  schema_version: value.schemaVersion, checkpoint_ref: value.checkpointRef,
  evidence_schema_version: value.evidence.schemaVersion, execution_attempt_id: value.evidence.identity.executionAttemptId,
  execution_plan_id: value.evidence.identity.executionPlanId, trade_intent_id: value.evidence.identity.tradeIntentId,
  candidate_id: value.evidence.identity.candidateId, instrument_id: value.evidence.identity.instrumentId,
  evidence_payload: value.evidence }] as const);
const outcomeRow = { schema_version: outcome.schemaVersion, outcome_key: outcome.outcomeKey,
  session_id: outcome.sessionId, execution_attempt_id: outcome.executionAttemptId,
  observed_at_ms: String(outcome.observedAt), observed_fence: String(outcome.observedFence),
  pending_adapter_id: effect.adapterId, pending_environment: effect.environment,
  pending_operation: effect.operation, pending_execution_attempt_id: effect.executionAttemptId,
  pending_idempotency_key: effect.idempotencyKey, pending_request_fingerprint: effect.requestFingerprint,
  observation_kind: outcome.observation.kind, observation_payload: acknowledged };
const pendingFields = ["schema_version", "adapter_id", "idempotency_key", "session_id", "expected_revision",
  "committed_revision", "committed_fence", "committing_owner_id", "previous_checkpoint_ref",
  "committed_checkpoint_ref", "commit_payload"];
const adoptionFields = ["schema_version", "outcome_key", "session_id", "execution_attempt_id", "expected_revision",
  "adopted_revision", "adopted_fence", "adopting_owner_id", "previous_checkpoint_ref",
  "committed_checkpoint_ref", "commit_payload"];
function receiptRow(value: PendingIntentCommitReceipt | ExternalOutcomeAdoptionReceipt): Row {
  const pending = "pendingEffect" in value;
  const fields = pending ? pendingFields : adoptionFields;
  const values = pending ? [value.schemaVersion, value.pendingEffect.adapterId, value.pendingEffect.idempotencyKey,
    value.sessionId, value.expectedRevision, value.committedRevision, value.committedFence,
    value.committingOwnerId, value.previousCheckpointRef, value.committedCheckpointRef, value]
    : [value.schemaVersion, value.outcomeKey, value.sessionId, value.executionAttemptId, value.expectedRevision,
      value.adoptedRevision, value.adoptedFence, value.adoptingOwnerId,
      value.previousCheckpointRef, value.committedCheckpointRef, value];
  return Object.fromEntries(fields.map((field, index) => [field, values[index]]));
}
function result<T>(rows: readonly Row[], rowCount = rows.length): PostgresQueryResult<T> {
  return { rows: rows as readonly T[], rowCount };
}
class FakePostgres implements PostgresExecutor {
  public checkpoints = new Map(checkpointRows);
  public outcome: Row | null = outcomeRow;
  public pending: Row | null = null;
  public adoption: Row | null = null;
  public adoptionCandidates: Row[] | null = null;
  public fail = false;
  public impossible = false;
  public calls: { sql: string; params: readonly unknown[] }[] = [];
  public async transaction<T>(work: (transaction: PostgresTransaction) => Promise<T>): Promise<T> {
    const oldPending = this.pending, oldAdoption = this.adoption;
    try { return await work(this); }
    catch (cause) { this.pending = oldPending; this.adoption = oldAdoption; throw cause; }
  }
  public async query<T>(sql: string, params: readonly unknown[]): Promise<PostgresQueryResult<T>> {
    this.calls.push({ sql, params });
    if (this.fail) throw new Error("database unavailable");
    if (this.impossible) return result<T>([], 2);
    if (sql.includes("checkpoint:load")) {
      const row = this.checkpoints.get(String(params[0]));
      return result<T>(row === undefined ? [] : [row]);
    }
    if (sql.includes("effect:outcome-load")) return result<T>(this.outcome === null ? [] : [this.outcome]);
    if (sql.includes("receipt:pending-load")) return result<T>(this.pending === null ? [] : [this.pending]);
    if (sql.includes("receipt:adoption-load")) return result<T>(this.adoption === null ? [] : [this.adoption]);
    if (sql.includes("receipt:adoption-creation-proof-load")) {
      const candidates = this.adoptionCandidates ?? (this.adoption === null ? [] : [this.adoption]);
      return result<T>(candidates.filter((row) => row["session_id"] === params[0]
        && row["adopted_revision"] === params[1]));
    }
    if (sql.includes("receipt:pending-insert") || sql.includes("receipt:adoption-insert")) {
      const pending = sql.includes("receipt:pending-insert");
      if (pending ? this.pending !== null : this.adoption !== null) return result<T>([]);
      const fields = pending ? pendingFields : adoptionFields;
      const row = Object.fromEntries(fields.map((field, index) =>
        [field, field === "commit_payload" ? JSON.parse(String(params[index])) : params[index]]));
      if (pending) this.pending = row; else this.adoption = row;
      return result<T>([row]);
    }
    throw new Error("Unexpected SQL");
  }
}

describe("PostgreSQL orchestration commit receipts", () => {
  it("round trips an unlinked fill and preserves nested next-pending logical payload", async () => {
    const db = new FakePostgres(), store = new PostgresOrchestrationReceiptStore(db);
    const fillOutcome = createOrchestrationExternalOutcome({ ...outcome, outcomeKey: "fill-outcome",
      pendingEffectIdentity: null, observation: { kind: "CANONICAL_EXECUTION_TRANSITION", transition: filled } });
    db.outcome = { ...outcomeRow, outcome_key: fillOutcome.outcomeKey,
      pending_adapter_id: null, pending_environment: null, pending_operation: null,
      pending_execution_attempt_id: null, pending_idempotency_key: null, pending_request_fingerprint: null,
      observation_payload: filled };
    const proof = proveOutcomeAdoptionCheckpointAdvance({ previousCheckpoint: adopted,
      committedCheckpoint: filledCheckpoint, outcome: fillOutcome, nextPendingEffect: null });
    if (proof.status !== "PROVEN") throw new Error("Invalid fill proof");
    const unlinked = createExternalOutcomeAdoptionReceipt({ ...adoptionReceipt(),
      outcomeKey: fillOutcome.outcomeKey, expectedRevision: 3, adoptedRevision: 4,
      previousCheckpointRef: adopted.checkpointRef, committedCheckpointRef: filledCheckpoint.checkpointRef,
      resultingRecoveryState: recovery("filled"), linkedPendingResolution: null,
      advanceProof: proof.proof }, adopted, filledCheckpoint, fillOutcome);
    expect((await appendExternalOutcomeAdoptionReceiptInTransaction(db, unlinked)).status).toBe("APPENDED");
    expect(await store.loadExternalOutcomeAdoptionReceipt(fillOutcome.outcomeKey)).toEqual(unlinked);
    db.adoption = null;
    const filledAttempt = restoreExecutionAttemptFromEvidence(filledCheckpoint.evidence);
    if (filledAttempt.status !== "EXECUTION_ATTEMPT_RESTORED") throw new Error("Invalid filled attempt");
    const protection = requestProtection(filledAttempt.executionAttempt);
    if (protection.status !== "PROTECTION_REQUEST_READY") throw new Error("Invalid protection request");
    const nextPending = createOrchestrationPendingEffect({ ...effect, operation: "PROTECTION_SUBMISSION",
      idempotencyKey: protection.request.idempotencyKey,
      requestFingerprint: fingerprintProtectionRequest(protection.request), createdRevision: 4 });
    const nextProof = proveOutcomeAdoptionCheckpointAdvance({ previousCheckpoint: adopted,
      committedCheckpoint: nextCheckpoint, outcome: fillOutcome, nextPendingEffect: nextPending });
    if (nextProof.status !== "PROVEN") throw new Error("Invalid next-pending proof");
    const nested = { sessionId: unlinked.sessionId, expectedRevision: unlinked.expectedRevision,
      previousCheckpointRef: adopted.checkpointRef, committedCheckpointRef: nextCheckpoint.checkpointRef,
      resultingRecoveryState: recovery("next"), pendingEffect: nextPending, advanceProof: nextProof.proof };
    const withNext = createExternalOutcomeAdoptionReceipt({ ...unlinked,
      committedCheckpointRef: nextCheckpoint.checkpointRef, resultingRecoveryState: recovery("next"),
      nextPendingEffect: nextPending, nextPendingCommit: nested, advanceProof: nextProof.proof },
    adopted, nextCheckpoint, fillOutcome);
    expect((await appendExternalOutcomeAdoptionReceiptInTransaction(db, withNext)).status).toBe("APPENDED");
    expect((await store.loadExternalOutcomeAdoptionReceipt(fillOutcome.outcomeKey))?.nextPendingCommit)
      .toEqual(withNext.nextPendingCommit);
    expect(db.pending).toBeNull();

    const tx: PostgresTransaction = { query: (sql, params) => db.query(sql, params) };
    const nextIdentity = { adapterId: nextPending.adapterId, environment: nextPending.environment,
      operation: nextPending.operation, executionAttemptId: nextPending.executionAttemptId,
      idempotencyKey: nextPending.idempotencyKey, requestFingerprint: nextPending.requestFingerprint };
    const lookup = () => loadAdoptionCreationProofInTransaction(tx, "session-1", 4, nextIdentity);
    expect(await lookup()).toEqual({ status: "FOUND", receipt: withNext });
    expect(db.calls.slice(-4).map(({ sql }) => sql)).toEqual(expect.arrayContaining([
      expect.stringContaining("receipt:adoption-creation-proof-load"),
      expect.stringContaining("effect:outcome-load"),
    ]));
    expect(await loadAdoptionCreationProofInTransaction(tx, "session-1", 5, nextIdentity))
      .toEqual({ status: "MISSING" });
    for (const changed of [
      { adapterId: "wrong" }, { environment: "DRY_RUN" }, { operation: "ENTRY_CANCELLATION" },
      { executionAttemptId: "wrong" }, { idempotencyKey: "wrong" }, { requestFingerprint: "wrong" },
    ]) expect(await loadAdoptionCreationProofInTransaction(tx, "session-1", 4,
      { ...nextIdentity, ...changed } as never)).toEqual({ status: "MISSING" });
    db.adoption = null;
    expect(await lookup()).toEqual({ status: "MISSING" });
    db.adoption = receiptRow(adoptionReceipt()); db.outcome = outcomeRow;
    expect(await loadAdoptionCreationProofInTransaction(tx, "session-1", 3, nextIdentity))
      .toEqual({ status: "MISSING" });
    db.adoption = { ...receiptRow(withNext), commit_payload: [] }; db.outcome = {
      ...outcomeRow, outcome_key: fillOutcome.outcomeKey, pending_adapter_id: null,
      pending_environment: null, pending_operation: null, pending_execution_attempt_id: null,
      pending_idempotency_key: null, pending_request_fingerprint: null, observation_payload: filled,
    };
    await expect(lookup()).rejects.toBeInstanceOf(PersistenceCorruptionError);
    db.adoptionCandidates = [receiptRow(withNext), receiptRow(withNext)];
    await expect(lookup()).rejects.toBeInstanceOf(PersistenceCorruptionError);
  });

  it("loads missing, appends and round trips both receipt kinds, including transaction reads", async () => {
    const db = new FakePostgres(), store = new PostgresOrchestrationReceiptStore(db);
    const pending = pendingReceipt(), adoption = adoptionReceipt();
    expect(await store.loadPendingIntentCommitReceipt(effect.adapterId, effect.idempotencyKey)).toBeNull();
    expect(await store.loadExternalOutcomeAdoptionReceipt(outcome.outcomeKey)).toBeNull();
    expect((await db.transaction((tx) => appendPendingIntentCommitReceiptInTransaction(tx, pending))).status).toBe("APPENDED");
    expect((await db.transaction((tx) => appendExternalOutcomeAdoptionReceiptInTransaction(tx, adoption))).status).toBe("APPENDED");
    expect(await store.loadPendingIntentCommitReceipt(effect.adapterId, effect.idempotencyKey)).toEqual(pending);
    expect(await store.loadExternalOutcomeAdoptionReceipt(outcome.outcomeKey)).toEqual(adoption);
    expect(await db.transaction((tx) => loadPendingIntentCommitReceiptInTransaction(tx,
      effect.adapterId, effect.idempotencyKey))).toEqual(pending);
    expect(await db.transaction((tx) => loadExternalOutcomeAdoptionReceiptInTransaction(tx,
      outcome.outcomeKey))).toEqual(adoption);
    expect((await appendPendingIntentCommitReceiptInTransaction(db, pending)).status).toBe("DUPLICATE_SAME");
    expect((await appendExternalOutcomeAdoptionReceiptInTransaction(db, adoption)).status).toBe("DUPLICATE_SAME");
    expect(db.calls.filter(({ sql }) => sql.includes("receipt:pending-insert") || sql.includes("receipt:adoption-insert"))
      .every(({ sql, params }) => sql.includes("ON CONFLICT") && sql.includes("$11") && params.length === 11)).toBe(true);
    expect(db.calls.every(({ sql }) => !/\b(?:UPDATE|DELETE)\s+orchestration_(?:pending_intent_commit|external_outcome_adoption)\b/i.test(sql))).toBe(true);
  });

  it("compares full historical owner, fence, recovery target and nested pending facts", async () => {
    const db = new FakePostgres(), pending = pendingReceipt(), adoption = adoptionReceipt();
    await appendPendingIntentCommitReceiptInTransaction(db, pending);
    await appendExternalOutcomeAdoptionReceiptInTransaction(db, adoption);
    for (const changed of [
      { ...pending, committingOwnerId: "owner-2" },
      { ...pending, committedFence: 4, pendingEffect: { ...pending.pendingEffect, createdFence: 4 } },
      { ...pending, resultingRecoveryState: { ...pending.resultingRecoveryState, riskBasisCheckpointRef: "risk-2" } },
      { ...pending, pendingEffect: { ...pending.pendingEffect, environment: "DRY_RUN" } },
    ]) {
      expect((await appendPendingIntentCommitReceiptInTransaction(db, changed as PendingIntentCommitReceipt)).status)
        .toBe("RECEIPT_CONFLICT");
    }
    for (const changed of [
      { ...adoption, adoptingOwnerId: "owner-2" },
      { ...adoption, adoptedFence: 4, linkedPendingResolution: {
        ...adoption.linkedPendingResolution, resolvedFence: 4 } },
      { ...adoption, resultingRecoveryState: { ...adoption.resultingRecoveryState, riskBasisCheckpointRef: "risk-2" } },
    ]) expect((await appendExternalOutcomeAdoptionReceiptInTransaction(db,
      changed as ExternalOutcomeAdoptionReceipt)).status).toBe("RECEIPT_CONFLICT");
  });

  it("rolls back both append primitives with their caller and preserves the input DTO", async () => {
    const db = new FakePostgres(), pending = pendingReceipt(), adoption = adoptionReceipt();
    const beforePending = structuredClone(pending), beforeAdoption = structuredClone(adoption);
    await expect(db.transaction(async (tx) => {
      await appendPendingIntentCommitReceiptInTransaction(tx, pending);
      await appendExternalOutcomeAdoptionReceiptInTransaction(tx, adoption);
      throw new Error("rollback");
    })).rejects.toThrow("rollback");
    expect(db.pending).toBeNull(); expect(db.adoption).toBeNull();
    expect(pending).toEqual(beforePending); expect(adoption).toEqual(beforeAdoption);
  });

  it("fails closed on missing dependencies, malformed payloads, contradictions and unsafe BIGINTs", async () => {
    const db = new FakePostgres(), store = new PostgresOrchestrationReceiptStore(db);
    db.pending = receiptRow(pendingReceipt()); db.adoption = receiptRow(adoptionReceipt());
    for (const bad of [
      { commit_payload: [] }, { session_id: "other" }, { expected_revision: "01" },
      { expected_revision: Number.MAX_SAFE_INTEGER + 1 }, { committed_revision: "1.5" },
    ]) expect(() => mapPendingReceiptRow({ ...db.pending, ...bad } as never, before, after))
      .toThrow(PersistenceCorruptionError);
    for (const bad of [
      { commit_payload: [] }, { execution_attempt_id: "other" }, { adopted_fence: "01" },
      { adopted_revision: Number.MAX_SAFE_INTEGER + 1 },
    ]) expect(() => mapAdoptionReceiptRow({ ...db.adoption, ...bad } as never, after, adopted, outcome))
      .toThrow(PersistenceCorruptionError);
    db.checkpoints.delete("before");
    await expect(store.loadPendingIntentCommitReceipt(effect.adapterId, effect.idempotencyKey))
      .rejects.toBeInstanceOf(PersistenceCorruptionError);
    db.checkpoints = new Map(checkpointRows); db.checkpoints.delete("after");
    await expect(store.loadPendingIntentCommitReceipt(effect.adapterId, effect.idempotencyKey))
      .rejects.toBeInstanceOf(PersistenceCorruptionError);
    db.checkpoints = new Map(checkpointRows); db.outcome = null;
    await expect(store.loadExternalOutcomeAdoptionReceipt(outcome.outcomeKey))
      .rejects.toBeInstanceOf(PersistenceCorruptionError);
    db.impossible = true;
    await expect(store.loadPendingIntentCommitReceipt(effect.adapterId, effect.idempotencyKey))
      .rejects.toBeInstanceOf(PersistenceCorruptionError);
  });

  it("wraps database failures and migration 0005 has only additive constrained tables", async () => {
    const db = new FakePostgres(); db.fail = true;
    await expect(new PostgresOrchestrationReceiptStore(db).loadPendingIntentCommitReceipt(
      effect.adapterId, effect.idempotencyKey)).rejects.toBeInstanceOf(PersistenceInfrastructureError);
    const migration = readFileSync(fileURLToPath(new URL("../migrations/0005_orchestration_commit_receipts.sql", import.meta.url)), "utf8");
    expect([...migration.matchAll(/CREATE TABLE\s+(\w+)/g)].map((match) => match[1])).toEqual([
      "orchestration_pending_intent_commit", "orchestration_external_outcome_adoption"]);
    expect(migration).toContain("PRIMARY KEY (adapter_id, idempotency_key)");
    expect(migration).toContain("outcome_key TEXT NOT NULL PRIMARY KEY");
    expect(migration).toContain("REFERENCES orchestration_pending_effect (adapter_id, idempotency_key)");
    expect(migration).toContain("REFERENCES orchestration_external_outcome (outcome_key)");
    expect(migration.match(/REFERENCES orchestration_execution_authority_checkpoint/g)).toHaveLength(4);
    expect(migration.match(/jsonb_typeof\(commit_payload\) = 'object'/g)).toHaveLength(2);
    expect(migration).toContain("committed_revision = expected_revision + 1");
    expect(migration).toContain("adopted_revision = expected_revision + 1");
    expect(migration).not.toMatch(/\b(?:UUID|random|NOW|CURRENT_TIMESTAMP|clock_timestamp|UPDATE|DELETE|ALTER)\b/i);
  });
});
