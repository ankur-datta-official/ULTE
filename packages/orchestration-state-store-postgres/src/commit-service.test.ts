import { describe, expect, it } from "vitest";
import { brokerAdapterId, fingerprintEntryCancellation, fingerprintEntrySubmission,
  fingerprintProtectionRequest } from "@ulte/broker-adapters";
import { requestEntryCancellation, requestEntrySubmission, requestProtection,
  restoreExecutionAttemptFromEvidence, type ExecutionAttemptRecoveryTransition } from "@ulte/execution-engine";
import { checkpointEvidence } from "../../../tests/integration/phase33b-checkpoint-fixture.js";
import { createExecutionAuthorityCheckpoint, createOrchestrationPendingEffect,
  type CommitPendingIntentRequest, type PendingIntentCommitReceipt } from "@ulte/orchestration-state-store";
import { PersistenceConflictError, PersistenceCorruptionError, PersistenceInfrastructureError,
  PostgresOrchestrationCommitService, type PostgresExecutor, type PostgresQueryResult,
  type PostgresTransaction } from "./index.js";

type Row = Record<string, unknown>;
const base = checkpointEvidence();
const capabilities = { supportsClientIdempotency: false, supportsCloseOnlyExit: true,
  supportsNativeBracketProtection: false, supportsProtectionModification: true,
  supportsOrderCancellation: true, supportsPartialFillReporting: true };
const requested = { kind: "ENTRY_SUBMISSION_REQUESTED", adapterCapabilities: capabilities } as const;
const restored = restoreExecutionAttemptFromEvidence(base);
if (restored.status !== "EXECUTION_ATTEMPT_RESTORED") throw new Error("Bad fixture");
const entry = requestEntrySubmission(restored.executionAttempt, capabilities);
if (entry.status !== "ENTRY_SUBMISSION_READY") throw new Error("Bad entry fixture");
const acknowledged = { kind: "ENTRY_SUBMISSION_ACKNOWLEDGED", acknowledgement: {
  executionAttemptId: base.identity.executionAttemptId, idempotencyKey: entry.request.idempotencyKey,
  adapterOrderId: "order-1", acknowledgedAt: 2_100_101 } } as const;
const filled = { kind: "ENTRY_FILL_APPLIED", fill: {
  executionAttemptId: base.identity.executionAttemptId, adapterOrderId: "order-1", fillId: "fill-1",
  filledQuantity: "1", fillPrice: entry.request.limitPrice, filledAt: 2_100_102 } } as const;
function checkpoint(ref: string, transitions: readonly ExecutionAttemptRecoveryTransition[]) {
  return createExecutionAuthorityCheckpoint({ schemaVersion: "EXECUTION_AUTHORITY_CHECKPOINT_V1",
    checkpointRef: ref, evidence: { ...base, transitions } });
}
const entryBefore = checkpoint("entry-before", []);
const entryAfter = checkpoint("entry-after", [requested]);
const cancellationBefore = checkpoint("cancel-before", [requested, acknowledged]);
const cancellationAfter = checkpoint("cancel-after", [requested, acknowledged,
  { kind: "ENTRY_CANCELLATION_REQUESTED" }]);
const protectionBefore = checkpoint("protect-before", [requested, acknowledged, filled]);
const protectionAfter = checkpoint("protect-after", [requested, acknowledged, filled,
  { kind: "PROTECTION_REQUESTED" }]);
function attempt(transitions: readonly ExecutionAttemptRecoveryTransition[]) {
  const value = restoreExecutionAttemptFromEvidence({ ...base, transitions });
  if (value.status !== "EXECUTION_ATTEMPT_RESTORED") throw new Error("Bad attempt fixture");
  return value.executionAttempt;
}
const cancellation = requestEntryCancellation(attempt([requested, acknowledged]));
const protection = requestProtection(attempt([requested, acknowledged, filled]));
if (cancellation.status !== "CANCELLATION_REQUEST_READY" || protection.status !== "PROTECTION_REQUEST_READY") {
  throw new Error("Bad request fixture");
}
function fixture(kind: "entry" | "protection" | "cancellation" = "entry") {
  const previous = kind === "entry" ? entryBefore : kind === "protection" ? protectionBefore : cancellationBefore;
  const committed = kind === "entry" ? entryAfter : kind === "protection" ? protectionAfter : cancellationAfter;
  const actual = kind === "entry" ? entry.request : kind === "protection" ? protection.request : cancellation.request;
  const fingerprint = kind === "entry" ? fingerprintEntrySubmission(entry.request)
    : kind === "protection" ? fingerprintProtectionRequest(protection.request)
      : fingerprintEntryCancellation(cancellation.request);
  const pendingEffect = createOrchestrationPendingEffect({ schemaVersion: "ORCHESTRATION_PENDING_EFFECT_V1",
    sessionId: "session-1", adapterId: brokerAdapterId("adapter-1"), environment: "SANDBOX",
    operation: kind === "entry" ? "ENTRY_SUBMISSION" : kind === "protection" ? "PROTECTION_SUBMISSION" : "ENTRY_CANCELLATION",
    executionAttemptId: base.identity.executionAttemptId, idempotencyKey: actual.idempotencyKey,
    requestFingerprint: fingerprint, createdRevision: 2, createdFence: 3,
    state: "PENDING", resolvedOutcomeKey: null, resolvedRevision: null, resolvedFence: null });
  const request: CommitPendingIntentRequest = { sessionId: pendingEffect.sessionId, ownerId: "owner-1" as CommitPendingIntentRequest["ownerId"],
    expectedRevision: 1 as CommitPendingIntentRequest["expectedRevision"],
    expectedFence: 3 as CommitPendingIntentRequest["expectedFence"],
    previousCheckpointRef: previous.checkpointRef, committedCheckpoint: committed,
    resultingRecoveryState: { mode: "SANDBOX", instrumentId: base.identity.instrumentId,
      executionAuthorityCheckpointRef: committed.checkpointRef, executionAuthorityIdentity: base.identity,
      riskBasisCheckpointRef: null, latestROutcomeRef: null }, pendingEffect };
  return { previous, request };
}
function checkpointRow(value: ReturnType<typeof checkpoint>): Row {
  const identity = value.evidence.identity;
  return { schema_version: value.schemaVersion, checkpoint_ref: value.checkpointRef,
    evidence_schema_version: value.evidence.schemaVersion, execution_attempt_id: identity.executionAttemptId,
    execution_plan_id: identity.executionPlanId, trade_intent_id: identity.tradeIntentId,
    candidate_id: identity.candidateId, instrument_id: identity.instrumentId, evidence_payload: value.evidence };
}
function recoveryRow(ref: string): Row {
  return { schema_version: "ORCHESTRATION_RECOVERY_RECORD_V1", session_id: "session-1",
    revision: "1", fence_token: "3", mode: "SANDBOX", instrument_id: base.identity.instrumentId,
    execution_authority_checkpoint_ref: ref, execution_attempt_id: base.identity.executionAttemptId,
    execution_plan_id: base.identity.executionPlanId, trade_intent_id: base.identity.tradeIntentId,
    candidate_id: base.identity.candidateId, execution_instrument_id: base.identity.instrumentId,
    risk_basis_checkpoint_ref: null, latest_r_outcome_ref: null };
}
const checkpointFields = ["schema_version", "checkpoint_ref", "evidence_schema_version", "execution_attempt_id",
  "execution_plan_id", "trade_intent_id", "candidate_id", "instrument_id", "evidence_payload"];
const pendingFields = ["schema_version", "session_id", "adapter_id", "environment", "operation",
  "execution_attempt_id", "idempotency_key", "request_fingerprint", "created_revision", "created_fence",
  "state", "resolved_outcome_key", "resolved_revision", "resolved_fence"];
const receiptFields = ["schema_version", "adapter_id", "idempotency_key", "session_id", "expected_revision",
  "committed_revision", "committed_fence", "committing_owner_id", "previous_checkpoint_ref",
  "committed_checkpoint_ref", "commit_payload"];
function row(fields: readonly string[], params: readonly unknown[], jsonField?: string): Row {
  return Object.fromEntries(fields.map((field, index) => [field,
    field === jsonField ? JSON.parse(String(params[index])) : params[index]]));
}
function result<T>(rows: readonly Row[]): PostgresQueryResult<T> {
  return { rows: rows as readonly T[], rowCount: rows.length };
}
class FakePostgres implements PostgresExecutor {
  public checkpoints = new Map<string, Row>();
  public recovery: Row | null;
  public pending: Row | null = null;
  public receipt: Row | null = null;
  public receiptOnInsert: Row | null = null;
  public receiptOnRecheck: Row | null = null;
  public pendingOnInsert: Row | null = null;
  public lease: Row | null = { session_id: "session-1", owner_id: "owner-1", fence_token: "3", expires_at_ms: "2000" };
  public now = 1000;
  public expireAtFinal = false;
  public changeFenceAtFinal = false;
  public failAt: string | null = null;
  public conflictAt: string | null = null;
  public calls: string[] = [];
  public transactions = 0;
  private clocks = 0;
  private leaseLocks = 0;
  private receiptReads = 0;
  public constructor(previous: ReturnType<typeof checkpoint>) {
    this.checkpoints.set(previous.checkpointRef, checkpointRow(previous));
    this.recovery = recoveryRow(previous.checkpointRef);
  }
  public async transaction<T>(work: (tx: PostgresTransaction) => Promise<T>): Promise<T> {
    this.transactions += 1;
    const before = { checkpoints: new Map(this.checkpoints), recovery: this.recovery && { ...this.recovery },
      pending: this.pending && { ...this.pending }, receipt: this.receipt && { ...this.receipt } };
    try { const value = await work(this); this.calls.push("commit"); return value; }
    catch (cause) {
      this.checkpoints = before.checkpoints; this.recovery = before.recovery;
      this.pending = before.pending; this.receipt = before.receipt;
      this.calls.push("rollback"); throw cause;
    }
  }
  public async query<T>(sql: string, params: readonly unknown[]): Promise<PostgresQueryResult<T>> {
    const marker = /(?:orchestration-state-store-postgres:|\/\* (checkpoint|effect|receipt):)([a-z-]+)/.exec(sql);
    const name = marker?.[1] && marker?.[2] ? `${marker[1]}:${marker[2]}` : marker?.[2] ?? "unknown";
    this.calls.push(name);
    if (this.failAt === name) throw new Error(`Database failed at ${name}`);
    if (name === "receipt:pending-load") {
      this.receiptReads += 1;
      if (this.receiptReads === 2 && this.receiptOnRecheck) this.receipt = this.receiptOnRecheck;
      return result<T>(this.receipt ? [this.receipt] : []);
    }
    if (name === "lease-lock") {
      this.leaseLocks += 1;
      if (this.leaseLocks === 2 && this.changeFenceAtFinal && this.lease) {
        this.lease = { ...this.lease, fence_token: "4" };
      }
      return result<T>(this.lease ? [this.lease] : []);
    }
    if (name === "lease-clock") {
      this.clocks += 1;
      if (this.clocks === 2 && this.expireAtFinal) this.now = 2000;
      expect(sql).toContain("clock_timestamp()");
      return result<T>([{ now_ms: String(this.now) }]);
    }
    if (name === "select-for-update") return result<T>(this.recovery ? [this.recovery] : []);
    if (name === "checkpoint:load") {
      const value = this.checkpoints.get(String(params[0])); return result<T>(value ? [value] : []);
    }
    if (name === "checkpoint:insert") {
      if (this.conflictAt === name || this.checkpoints.has(String(params[1]))) return result<T>([]);
      const value = row(checkpointFields, params, "evidence_payload");
      this.checkpoints.set(String(params[1]), value); return result<T>([value]);
    }
    if (name === "effect:pending-insert") {
      if (this.pendingOnInsert) { this.pending = this.pendingOnInsert; return result<T>([]); }
      if (this.conflictAt === name || this.pending) return result<T>([]);
      this.pending = row(pendingFields, params); return result<T>([this.pending]);
    }
    if (name === "effect:pending-load") return result<T>(this.pending ? [this.pending] : []);
    if (name === "save-update") {
      if (this.conflictAt === name) return result<T>([]);
      if (!this.recovery) return result<T>([]);
      this.recovery = { ...this.recovery, revision: String(params[3]), mode: params[4], instrument_id: params[5],
        execution_authority_checkpoint_ref: params[6], execution_attempt_id: params[7],
        execution_plan_id: params[8], trade_intent_id: params[9], candidate_id: params[10],
        execution_instrument_id: params[11], risk_basis_checkpoint_ref: params[12], latest_r_outcome_ref: params[13] };
      return result<T>([this.recovery]);
    }
    if (name === "receipt:pending-insert") {
      if (this.receiptOnInsert) { this.receipt = this.receiptOnInsert; return result<T>([]); }
      if (this.conflictAt === name || this.receipt) return result<T>([]);
      this.receipt = row(receiptFields, params, "commit_payload"); return result<T>([this.receipt]);
    }
    throw new Error(`Unexpected SQL ${name}`);
  }
}

describe("atomic pending-intent commit", () => {
  for (const kind of ["entry", "protection", "cancellation"] as const) {
    it(`commits ${kind} checkpoint, pending effect, recovery and receipt together`, async () => {
      const { previous, request } = fixture(kind), db = new FakePostgres(previous);
      const answer = await new PostgresOrchestrationCommitService(db).commitPendingIntent(request);
      expect(answer.status).toBe("COMMITTED");
      if (answer.status !== "COMMITTED") return;
      expect(db.checkpoints.has(request.committedCheckpoint.checkpointRef)).toBe(true);
      expect(db.pending?.["created_revision"]).toBe(2);
      expect(db.pending?.["created_fence"]).toBe(3);
      expect(db.recovery?.["revision"]).toBe("2");
      expect(db.receipt?.["committing_owner_id"]).toBe("owner-1");
      expect(db.receipt?.["committed_fence"]).toBe(3);
      expect(db.transactions).toBe(1);
      expect(db.calls.indexOf("lease-lock")).toBeLessThan(db.calls.indexOf("select-for-update"));
      expect(db.calls.indexOf("select-for-update")).toBeLessThan(db.calls.indexOf("effect:pending-insert"));
      expect(db.calls.indexOf("effect:pending-insert")).toBeLessThan(db.calls.indexOf("receipt:pending-insert"));
      expect(db.calls.lastIndexOf("lease-clock")).toBeGreaterThan(db.calls.indexOf("receipt:pending-insert"));
    });
  }
  it("uses the receipt before current authorization and ignores later mutable state", async () => {
    const { previous, request } = fixture(), db = new FakePostgres(previous);
    const service = new PostgresOrchestrationCommitService(db);
    const first = await service.commitPendingIntent(request);
    expect(first.status).toBe("COMMITTED");
    db.recovery = { ...db.recovery, revision: "9" };
    db.pending = { ...db.pending, state: "RESOLVED", resolved_outcome_key: "outcome-1",
      resolved_revision: "3", resolved_fence: "4" };
    db.lease = null;
    db.calls = [];
    const again = await service.commitPendingIntent(request);
    expect(again).toEqual({ status: "ALREADY_COMMITTED", receipt: (first as { receipt: PendingIntentCommitReceipt }).receipt });
    expect(db.calls).not.toContain("lease-lock");
    expect(db.calls).not.toContain("checkpoint:insert");
    expect(db.calls).not.toContain("effect:pending-insert");
    expect(db.transactions).toBe(2);
    expect(await service.commitPendingIntent({ ...request, expectedFence: 4 as typeof request.expectedFence })).toMatchObject({ status: "ALREADY_COMMITTED" });
    expect(await service.commitPendingIntent({ ...request, ownerId: "owner-2" as typeof request.ownerId })).toMatchObject({ status: "ALREADY_COMMITTED" });
    db.lease = { session_id: "session-1", owner_id: "owner-2", fence_token: "4", expires_at_ms: "3000" };
    expect(await service.commitPendingIntent(request)).toMatchObject({ status: "ALREADY_COMMITTED" });
    expect(await service.commitPendingIntent({ ...request, resultingRecoveryState: { ...request.resultingRecoveryState,
      mode: "DRY_RUN" } })).toEqual({ status: "EFFECT_CONFLICT" });
    const contradictory = createExecutionAuthorityCheckpoint({ ...request.committedCheckpoint,
      evidence: { ...request.committedCheckpoint.evidence, transitions: [
        { kind: "ENTRY_SUBMISSION_REQUESTED", adapterCapabilities: { ...capabilities,
          supportsNativeBracketProtection: true } }] } });
    expect(await service.commitPendingIntent({ ...request, committedCheckpoint: contradictory }))
      .toEqual({ status: "CHECKPOINT_CONFLICT", checkpointRef: request.committedCheckpoint.checkpointRef });
  });
  it("classifies lease, recovery, prior ref and durable authority before writing", async () => {
    const { previous, request } = fixture();
    const cases: { change: (db: FakePostgres) => void; status: string }[] = [
      { change: (db) => { db.lease = null; }, status: "LEASE_LOST" },
      { change: (db) => { db.lease = { ...db.lease, owner_id: null, expires_at_ms: null }; }, status: "LEASE_LOST" },
      { change: (db) => { db.lease = { ...db.lease, expires_at_ms: "1000" }; }, status: "LEASE_LOST" },
      { change: (db) => { db.lease = { ...db.lease, owner_id: "other" }; }, status: "LEASE_LOST" },
      { change: (db) => { db.lease = { ...db.lease, fence_token: "4" }; }, status: "FENCE_CONFLICT" },
      { change: (db) => { db.recovery = null; }, status: "NOT_FOUND" },
      { change: (db) => { db.recovery = { ...db.recovery, revision: "2" }; }, status: "REVISION_CONFLICT" },
      { change: (db) => { db.checkpoints.set("other", checkpointRow(checkpoint("other", [])));
        db.recovery = { ...db.recovery, execution_authority_checkpoint_ref: "other" }; }, status: "PRIOR_CHECKPOINT_CONFLICT" },
      { change: (db) => { db.recovery = { ...db.recovery, execution_authority_checkpoint_ref: null,
        execution_attempt_id: null, execution_plan_id: null, trade_intent_id: null,
        candidate_id: null, execution_instrument_id: null }; }, status: "PRIOR_CHECKPOINT_CONFLICT" },
    ];
    for (const { change, status } of cases) {
      const db = new FakePostgres(previous); change(db);
      const answer = await new PostgresOrchestrationCommitService(db).commitPendingIntent(request);
      expect(answer.status).toBe(status);
      if (status === "FENCE_CONFLICT") expect(answer).toEqual({ status, currentFence: 4 });
      if (status === "PRIOR_CHECKPOINT_CONFLICT") expect(answer).toMatchObject({
        requestedPreviousCheckpointRef: request.previousCheckpointRef,
        currentCheckpointRef: db.recovery?.["execution_authority_checkpoint_ref"] });
      expect(db.pending).toBeNull(); expect(db.receipt).toBeNull();
      expect(db.transactions).toBe(1);
    }
  });
  it("rejects contradictory durable authority and session-stable facts", async () => {
    const { previous, request } = fixture();
    for (const change of [
      (db: FakePostgres) => { db.checkpoints.clear(); },
      (db: FakePostgres) => { db.recovery = { ...db.recovery, execution_authority_checkpoint_ref: "missing" }; },
      (db: FakePostgres) => { db.recovery = { ...db.recovery, execution_attempt_id: "wrong" }; },
      (db: FakePostgres) => { db.recovery = { ...db.recovery, fence_token: "4" }; },
    ]) {
      const db = new FakePostgres(previous); change(db);
      await expect(new PostgresOrchestrationCommitService(db).commitPendingIntent(request))
        .rejects.toBeInstanceOf(PersistenceCorruptionError);
    }
    for (const changed of [
      { ...request, pendingEffect: { ...request.pendingEffect, environment: "DRY_RUN" as const } },
      { ...request, resultingRecoveryState: { ...request.resultingRecoveryState, mode: "DRY_RUN" as const } },
      { ...request, resultingRecoveryState: { ...request.resultingRecoveryState, instrumentId: "other" as typeof request.resultingRecoveryState.instrumentId } },
      { ...request, resultingRecoveryState: { ...request.resultingRecoveryState,
        riskBasisCheckpointRef: "risk" as NonNullable<typeof request.resultingRecoveryState.riskBasisCheckpointRef> } },
      { ...request, resultingRecoveryState: { ...request.resultingRecoveryState,
        latestROutcomeRef: "r" as NonNullable<typeof request.resultingRecoveryState.latestROutcomeRef> } },
    ]) {
      const db = new FakePostgres(previous);
      await expect(new PostgresOrchestrationCommitService(db).commitPendingIntent(changed))
        .rejects.toBeInstanceOf(TypeError);
      expect(db.pending).toBeNull();
    }
  });
  it("rolls back every post-write typed or infrastructure failure", async () => {
    const { previous, request } = fixture();
    for (const marker of ["checkpoint:insert", "effect:pending-insert", "save-update", "receipt:pending-insert"]) {
      const db = new FakePostgres(previous); db.failAt = marker;
      await expect(new PostgresOrchestrationCommitService(db).commitPendingIntent(request))
        .rejects.toBeInstanceOf(marker === "save-update" ? Error : PersistenceInfrastructureError);
      expect(db.checkpoints.size).toBe(1); expect(db.pending).toBeNull();
      expect(db.recovery?.["revision"]).toBe("1"); expect(db.receipt).toBeNull();
    }
    for (const marker of ["effect:pending-insert"]) {
      const db = new FakePostgres(previous);
      if (marker === "effect:pending-insert") db.pending = { ...row(pendingFields, [
        request.pendingEffect.schemaVersion, request.sessionId, request.pendingEffect.adapterId,
        request.pendingEffect.environment, request.pendingEffect.operation,
        request.pendingEffect.executionAttemptId, request.pendingEffect.idempotencyKey,
        "different", 2, 3, "PENDING", null, null, null]) };
      const answer = await new PostgresOrchestrationCommitService(db).commitPendingIntent(request).catch((error: unknown) => error);
      expect(answer).toEqual({ status: "EFFECT_CONFLICT" });
      expect(db.checkpoints.size).toBe(1); expect(db.recovery?.["revision"]).toBe("1");
    }
    const duplicate = new FakePostgres(previous);
    duplicate.pendingOnInsert = row(pendingFields, [request.pendingEffect.schemaVersion,
      request.sessionId, request.pendingEffect.adapterId, request.pendingEffect.environment,
      request.pendingEffect.operation, request.pendingEffect.executionAttemptId,
      request.pendingEffect.idempotencyKey, request.pendingEffect.requestFingerprint,
      2, 3, "PENDING", null, null, null]);
    await expect(new PostgresOrchestrationCommitService(duplicate).commitPendingIntent(request))
      .rejects.toBeInstanceOf(PersistenceCorruptionError);
    expect(duplicate.checkpoints.size).toBe(1); expect(duplicate.pending).toBeNull();

    const seed = new FakePostgres(previous);
    expect((await new PostgresOrchestrationCommitService(seed).commitPendingIntent(request)).status).toBe("COMMITTED");
    const inserted = seed.receipt!;
    const receiptConflict = new FakePostgres(previous);
    receiptConflict.receiptOnInsert = { ...inserted, committing_owner_id: "other",
      commit_payload: { ...(inserted["commit_payload"] as Row), committingOwnerId: "other" } };
    expect(await new PostgresOrchestrationCommitService(receiptConflict).commitPendingIntent(request))
      .toEqual({ status: "EFFECT_CONFLICT" });
    expect(receiptConflict.checkpoints.size).toBe(1);
    expect(receiptConflict.pending).toBeNull(); expect(receiptConflict.receipt).toBeNull();
    expect(receiptConflict.recovery?.["revision"]).toBe("1");
    for (const change of ["expireAtFinal", "changeFenceAtFinal"] as const) {
      const db = new FakePostgres(previous); db[change] = true;
      const answer = await new PostgresOrchestrationCommitService(db).commitPendingIntent(request);
      expect(answer.status).toBe(change === "expireAtFinal" ? "LEASE_LOST" : "FENCE_CONFLICT");
      expect(db.calls.at(-1)).toBe("rollback");
      expect(db.checkpoints.size).toBe(1); expect(db.pending).toBeNull();
      expect(db.recovery?.["revision"]).toBe("1"); expect(db.receipt).toBeNull();
    }
  });
  it("classifies a contradictory immutable checkpoint and rolls back no facts", async () => {
    const { previous, request } = fixture(), db = new FakePostgres(previous);
    const contradictory = createExecutionAuthorityCheckpoint({ ...request.committedCheckpoint,
      evidence: { ...request.committedCheckpoint.evidence, transitions: [
        { kind: "ENTRY_SUBMISSION_REQUESTED", adapterCapabilities: { ...capabilities,
          supportsNativeBracketProtection: true } }] } });
    db.checkpoints.set(request.committedCheckpoint.checkpointRef, checkpointRow(contradictory));
    expect(await new PostgresOrchestrationCommitService(db).commitPendingIntent(request))
      .toEqual({ status: "CHECKPOINT_CONFLICT", checkpointRef: request.committedCheckpoint.checkpointRef });
    expect(db.pending).toBeNull(); expect(db.receipt).toBeNull();
    expect(db.recovery?.["revision"]).toBe("1");
    expect(db.transactions).toBe(1);
  });
  it("reuses the A2 request proof before any workflow write", async () => {
    const { previous, request } = fixture();
    for (const change of [
      { ...request, pendingEffect: { ...request.pendingEffect, requestFingerprint: "wrong" as typeof request.pendingEffect.requestFingerprint } },
      { ...request, committedCheckpoint: checkpoint("extra", [requested, acknowledged]) },
      { ...request, committedCheckpoint: checkpoint("rewritten", [
        { kind: "ENTRY_SUBMISSION_REQUESTED", adapterCapabilities: { ...capabilities,
          supportsNativeBracketProtection: true } }]) },
      { ...request, resultingRecoveryState: { ...request.resultingRecoveryState,
        executionAuthorityCheckpointRef: previous.checkpointRef } },
    ]) {
      const db = new FakePostgres(previous);
      await expect(new PostgresOrchestrationCommitService(db).commitPendingIntent(change))
        .rejects.toBeInstanceOf(TypeError);
      expect(db.calls).not.toContain("checkpoint:insert");
      expect(db.pending).toBeNull(); expect(db.receipt).toBeNull();
    }
  });
  it("rechecks a receipt after locks and proof, before any mutation", async () => {
    const { previous, request } = fixture();
    const seed = new FakePostgres(previous);
    expect((await new PostgresOrchestrationCommitService(seed).commitPendingIntent(request)).status).toBe("COMMITTED");
    const db = new FakePostgres(previous);
    db.checkpoints.set(request.committedCheckpoint.checkpointRef, checkpointRow(request.committedCheckpoint));
    db.receiptOnRecheck = seed.receipt;
    const answer = await new PostgresOrchestrationCommitService(db).commitPendingIntent(request);
    expect(answer.status).toBe("ALREADY_COMMITTED");
    expect(db.calls).not.toContain("checkpoint:insert");
    expect(db.pending).toBeNull();
    expect(db.recovery?.["revision"]).toBe("1");
    expect(db.transactions).toBe(1);
  });
  it("rejects mismatched protection and cancellation fingerprints before writing", async () => {
    for (const kind of ["protection", "cancellation"] as const) {
      const { previous, request } = fixture(kind), db = new FakePostgres(previous);
      await expect(new PostgresOrchestrationCommitService(db).commitPendingIntent({ ...request,
        pendingEffect: { ...request.pendingEffect,
          requestFingerprint: "wrong" as typeof request.pendingEffect.requestFingerprint } }))
        .rejects.toBeInstanceOf(TypeError);
      expect(db.calls).not.toContain("checkpoint:insert");
      expect(db.pending).toBeNull();
    }
  });
  it("rejects revision overflow before mutation", async () => {
    const { previous, request } = fixture(), db = new FakePostgres(previous);
    await expect(new PostgresOrchestrationCommitService(db).commitPendingIntent({ ...request,
      expectedRevision: Number.MAX_SAFE_INTEGER as typeof request.expectedRevision }))
      .rejects.toMatchObject({ code: "REVISION_OVERFLOW" } satisfies Partial<PersistenceConflictError>);
    expect(db.transactions).toBe(0); expect(db.calls).toEqual([]);
  });
});
