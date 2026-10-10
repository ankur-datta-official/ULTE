import { describe, expect, it } from "vitest";
import { brokerAdapterId, fingerprintEntrySubmission, fingerprintProtectionRequest } from "@ulte/broker-adapters";
import { requestEntrySubmission, requestProtection, restoreExecutionAttemptFromEvidence } from "@ulte/execution-engine";
import { checkpointEvidence } from "../../../tests/integration/phase33b-checkpoint-fixture.js";
import {
  createExecutionAuthorityCheckpoint, createExternalOutcomeAdoptionReceipt,
  createOrchestrationExternalOutcome,
  createOrchestrationPendingEffect, createPendingIntentCommitReceipt,
  proveOutcomeAdoptionCheckpointAdvance, provePendingIntentCheckpointAdvance,
  type OrchestrationExternalOutcome, type PendingIntentCommitReceipt,
} from "@ulte/orchestration-state-store";
import { PersistenceInfrastructureError, PostgresOrchestrationFencedWriterService,
  type PendingWriterAuthority, type PostgresExecutor, type PostgresQueryResult,
  type PostgresTransaction } from "./index.js";

type Row = Record<string, unknown>;
const evidence = checkpointEvidence();
const capabilities = { supportsClientIdempotency: false, supportsCloseOnlyExit: true,
  supportsNativeBracketProtection: false, supportsProtectionModification: true,
  supportsOrderCancellation: true, supportsPartialFillReporting: true };
const restored = restoreExecutionAttemptFromEvidence(evidence);
if (restored.status !== "EXECUTION_ATTEMPT_RESTORED") throw new Error("Bad fixture");
const entry = requestEntrySubmission(restored.executionAttempt, capabilities);
if (entry.status !== "ENTRY_SUBMISSION_READY") throw new Error("Bad fixture");
const requested = { kind: "ENTRY_SUBMISSION_REQUESTED", adapterCapabilities: capabilities } as const;
const before = createExecutionAuthorityCheckpoint({ schemaVersion: "EXECUTION_AUTHORITY_CHECKPOINT_V1",
  checkpointRef: "before", evidence });
const after = createExecutionAuthorityCheckpoint({ schemaVersion: "EXECUTION_AUTHORITY_CHECKPOINT_V1",
  checkpointRef: "after", evidence: { ...evidence, transitions: [requested] } });
const pending = createOrchestrationPendingEffect({ schemaVersion: "ORCHESTRATION_PENDING_EFFECT_V1",
  sessionId: "session-1", adapterId: brokerAdapterId("adapter-1"), environment: "SANDBOX",
  operation: "ENTRY_SUBMISSION", executionAttemptId: evidence.identity.executionAttemptId,
  idempotencyKey: entry.request.idempotencyKey, requestFingerprint: fingerprintEntrySubmission(entry.request),
  createdRevision: 2, createdFence: 3, state: "PENDING", resolvedOutcomeKey: null,
  resolvedRevision: null, resolvedFence: null });
const identity = { adapterId: pending.adapterId, environment: pending.environment, operation: pending.operation,
  executionAttemptId: pending.executionAttemptId, idempotencyKey: pending.idempotencyKey,
  requestFingerprint: pending.requestFingerprint };
const recoveryState = { mode: "SANDBOX" as const, instrumentId: evidence.identity.instrumentId,
  executionAuthorityCheckpointRef: after.checkpointRef, executionAuthorityIdentity: evidence.identity,
  riskBasisCheckpointRef: null, latestROutcomeRef: null };
const receipt: PendingIntentCommitReceipt = createPendingIntentCommitReceipt({
  schemaVersion: "ORCHESTRATION_PENDING_INTENT_COMMIT_RECEIPT_V1", sessionId: pending.sessionId,
  expectedRevision: 1, committedRevision: 2, committedFence: 3, committingOwnerId: "owner-1",
  previousCheckpointRef: before.checkpointRef, committedCheckpointRef: after.checkpointRef,
  resultingRecoveryState: recoveryState, pendingEffect: pending,
  advanceProof: provePendingIntentCheckpointAdvance({ previousCheckpoint: before,
    committedCheckpoint: after, pendingEffect: pending }),
}, before, after);
const acknowledgement = { kind: "ENTRY_SUBMISSION_ACKNOWLEDGED", acknowledgement: {
  executionAttemptId: pending.executionAttemptId, idempotencyKey: pending.idempotencyKey,
  adapterOrderId: "order-1", acknowledgedAt: 2_100_101 } } as const;
function outcome(key = "outcome-1", observation: OrchestrationExternalOutcome["observation"] = {
  kind: "CANONICAL_EXECUTION_TRANSITION", transition: acknowledgement,
}): OrchestrationExternalOutcome {
  return createOrchestrationExternalOutcome({ schemaVersion: "ORCHESTRATION_EXTERNAL_OUTCOME_V1",
    outcomeKey: key, sessionId: pending.sessionId, executionAttemptId: pending.executionAttemptId,
    observedAt: 2_100_103, observedFence: 3, pendingEffectIdentity: identity, observation });
}
const authority: PendingWriterAuthority = { sessionId: pending.sessionId, ownerId: receipt.committingOwnerId,
  expectedFence: pending.createdFence, expectedRecoveryRevision: pending.createdRevision,
  expectedCheckpointRef: after.checkpointRef, pendingEffectIdentity: identity };
const claim = { ...identity, claimedAt: 2_100_100 };
const confirmed = { adapterId: identity.adapterId, environment: identity.environment,
  idempotencyKey: identity.idempotencyKey, requestFingerprint: identity.requestFingerprint,
  status: "CONFIRMED" as const, updatedAt: 2_100_103, adapterOrderId: "order-1" };

function checkpointRow(value: typeof before): Row {
  const id = value.evidence.identity;
  return { schema_version: value.schemaVersion, checkpoint_ref: value.checkpointRef,
    evidence_schema_version: value.evidence.schemaVersion, execution_attempt_id: id.executionAttemptId,
    execution_plan_id: id.executionPlanId, trade_intent_id: id.tradeIntentId, candidate_id: id.candidateId,
    instrument_id: id.instrumentId, evidence_payload: value.evidence };
}
function pendingRow(value = pending): Row {
  return { schema_version: value.schemaVersion, session_id: value.sessionId, adapter_id: value.adapterId,
    environment: value.environment, operation: value.operation, execution_attempt_id: value.executionAttemptId,
    idempotency_key: value.idempotencyKey, request_fingerprint: value.requestFingerprint,
    created_revision: value.createdRevision, created_fence: value.createdFence, state: value.state,
    resolution_kind: null, resolved_authority_ref: null, resolved_revision: null, resolved_fence: null };
}
function outcomeRow(value: OrchestrationExternalOutcome): Row {
  const id = value.pendingEffectIdentity;
  return { schema_version: value.schemaVersion, outcome_key: value.outcomeKey, session_id: value.sessionId,
    execution_attempt_id: value.executionAttemptId, observed_at_ms: value.observedAt,
    observed_fence: value.observedFence, pending_adapter_id: id?.adapterId ?? null,
    pending_environment: id?.environment ?? null, pending_operation: id?.operation ?? null,
    pending_execution_attempt_id: id?.executionAttemptId ?? null, pending_idempotency_key: id?.idempotencyKey ?? null,
    pending_request_fingerprint: id?.requestFingerprint ?? null, observation_kind: value.observation.kind,
    observation_payload: value.observation.kind === "BROKER_DISPOSITION" ? value.observation.disposition
      : value.observation.transition };
}
function rows<T>(values: readonly Row[]): PostgresQueryResult<T> {
  return { rows: values as readonly T[], rowCount: values.length };
}
class Fake implements PostgresExecutor {
  public lease: Row | null = { session_id: pending.sessionId, owner_id: "owner-1",
    fence_token: "3", expires_at_ms: "2000" };
  public recovery: Row | null = { schema_version: "ORCHESTRATION_RECOVERY_RECORD_V1",
    session_id: pending.sessionId, revision: "2", fence_token: "3", mode: "SANDBOX",
    instrument_id: evidence.identity.instrumentId, execution_authority_checkpoint_ref: after.checkpointRef,
    execution_attempt_id: evidence.identity.executionAttemptId, execution_plan_id: evidence.identity.executionPlanId,
    trade_intent_id: evidence.identity.tradeIntentId, candidate_id: evidence.identity.candidateId,
    execution_instrument_id: evidence.identity.instrumentId, risk_basis_checkpoint_ref: null,
    latest_r_outcome_ref: null, terminal_non_submission_disposition_ref: null };
  public effect: Row | null = pendingRow();
  public proof: Row | null = { schema_version: receipt.schemaVersion, adapter_id: pending.adapterId,
    idempotency_key: pending.idempotencyKey, session_id: pending.sessionId,
    expected_revision: 1, committed_revision: 2, committed_fence: 3, committing_owner_id: "owner-1",
    previous_checkpoint_ref: before.checkpointRef, committed_checkpoint_ref: after.checkpointRef,
    commit_payload: receipt };
  public adoptionProof: Row | null = null;
  public checkpoints = new Map<string, Row>([["before", checkpointRow(before)], ["after", checkpointRow(after)]]);
  public idempotency: Row | null = null;
  public outcomes: Row[] = [];
  public now = 1000;
  public failFinal = false;
  public failAt: string | null = null;
  public calls: string[] = [];
  public transactionObjects: PostgresTransaction[] = [];
  private leaseReads = 0;
  public async transaction<T>(work: (tx: PostgresTransaction) => Promise<T>): Promise<T> {
    const saved = { idempotency: this.idempotency && { ...this.idempotency }, outcomes: [...this.outcomes] };
    const tx: PostgresTransaction = { query: <R>(sql: string, params: readonly unknown[]) => {
      this.transactionObjects.push(tx);
      return this.query<R>(sql, params);
    } };
    try { const result = await work(tx); this.calls.push("commit"); return result; }
    catch (error) { this.idempotency = saved.idempotency; this.outcomes = saved.outcomes;
      this.calls.push("rollback"); throw error; }
  }
  public async query<T>(sql: string, params: readonly unknown[]): Promise<PostgresQueryResult<T>> {
    const marker = /\/\* ([^*]+) \*\//.exec(sql)?.[1] ?? "unknown";
    this.calls.push(marker);
    if (marker === this.failAt) throw new Error("database unavailable");
    if (marker === "orchestration-state-store-postgres:lease-lock") {
      this.leaseReads++;
      return rows<T>(this.lease === null ? [] : [this.failFinal && this.leaseReads === 2
        ? { ...this.lease, owner_id: "other" } : this.lease]);
    }
    if (marker === "orchestration-state-store-postgres:lease-clock") return rows<T>([{ now_ms: this.now }]);
    if (marker === "orchestration-state-store-postgres:select-for-update") return rows<T>(this.recovery ? [this.recovery] : []);
    if (marker === "checkpoint:load") {
      const value = this.checkpoints.get(String(params[0]));
      return rows<T>(value === undefined ? [] : [value]);
    }
    if (marker === "effect:pending-load") return rows<T>(this.effect ? [this.effect] : []);
    if (marker === "receipt:pending-load") return rows<T>(this.proof ? [this.proof] : []);
    if (marker === "receipt:adoption-creation-proof-load") return rows<T>(this.adoptionProof
      && this.adoptionProof["session_id"] === params[0] && this.adoptionProof["adopted_revision"] === params[1]
      ? [this.adoptionProof] : []);
    if (marker === "effect:outcome-list") return rows<T>(this.outcomes);
    if (marker === "effect:outcome-load") return rows<T>(this.outcomes.filter((row) => row["outcome_key"] === params[0]));
    if (marker === "effect:outcome-insert") {
      if (this.outcomes.some((row) => row["outcome_key"] === params[1])) return rows<T>([]);
      const candidate = outcomeRow(createOrchestrationExternalOutcome({ schemaVersion: params[0],
        outcomeKey: params[1], sessionId: params[2], executionAttemptId: params[3], observedAt: params[4],
        observedFence: params[5], pendingEffectIdentity: { adapterId: params[6], environment: params[7],
          operation: params[8], executionAttemptId: params[9], idempotencyKey: params[10],
          requestFingerprint: params[11] }, observation: { kind: params[12],
          ...(params[12] === "BROKER_DISPOSITION" ? { disposition: JSON.parse(String(params[13])) }
            : { transition: JSON.parse(String(params[13])) }) } }));
      this.outcomes.push(candidate); return rows<T>([candidate]);
    }
    if (marker === "execution-store-postgres:claim-insert") {
      if (this.idempotency !== null) return rows<T>([]);
      this.idempotency = { adapter_id: params[0], environment: params[1], idempotency_key: params[2],
        execution_attempt_id: params[3], operation: params[4], request_fingerprint: params[5],
        status: params[6], created_at_ms: params[7], updated_at_ms: params[8], adapter_order_id: params[9] };
      return rows<T>([this.idempotency]);
    }
    if (marker === "execution-store-postgres:claim-select-existing"
        || marker === "execution-store-postgres:outcome-select") return rows<T>(this.idempotency ? [this.idempotency] : []);
    if (marker === "execution-store-postgres:outcome-update") {
      if (this.idempotency === null) return rows<T>([]);
      this.idempotency = { ...this.idempotency, status: params[6], updated_at_ms: params[7],
        adapter_order_id: this.idempotency["adapter_order_id"] ?? params[8] };
      return rows<T>([this.idempotency]);
    }
    if (marker === "execution-store-postgres:outcome-enrich") {
      if (this.idempotency === null) return rows<T>([]);
      this.idempotency = { ...this.idempotency, adapter_order_id: params[6], updated_at_ms: params[7] };
      return rows<T>([this.idempotency]);
    }
    throw new Error(`Unexpected SQL ${marker}`);
  }
}
function service(db: Fake) { return new PostgresOrchestrationFencedWriterService(db); }

describe("fenced recoverable writer", () => {
  it("cannot persist definite terminal non-submission without atomic closure", () => {
    const db = new Fake();
    expect(() => service(db).recordPendingIdempotencyOutcome({ ...authority,
      update: { ...confirmed, status: "FAILED_NOT_SUBMITTED", adapterOrderId: undefined } as never }))
      .toThrow("atomic terminal closure");
    expect(db.calls).toHaveLength(0);
  });
  it("blocks every fresh writer path for a terminal recovery before pending or idempotency I/O", async () => {
    const db = new Fake();
    db.recovery = { ...db.recovery, schema_version: "ORCHESTRATION_RECOVERY_RECORD_V2",
      terminal_non_submission_disposition_ref: "terminal-1" };
    const writer = service(db);
    const unknownUpdate = { ...confirmed, status: "OUTCOME_UNKNOWN" as const,
      adapterOrderId: undefined };
    const actions = [
      () => writer.claimPendingIdempotency({ ...authority, claim }),
      () => writer.recordPendingIdempotencyOutcome({ ...authority, update: confirmed }),
      () => writer.appendPendingOutcome({ ...authority, outcome: outcome() }),
      () => writer.persistPendingTerminalOutcome({ ...authority, update: confirmed, outcome: outcome() }),
      () => writer.persistPendingReconciliationObservation({ ...authority, update: unknownUpdate, outcome: null }),
    ];
    for (const action of actions) {
      expect(await action()).toEqual({ status: "TERMINAL_STATE_CONFLICT" });
    }
    expect(db.calls).not.toContain("effect:pending-load");
    expect(db.calls).not.toContain("execution-store-postgres:claim-insert");
    expect(db.calls).not.toContain("effect:outcome-insert");
  });
  it("claims under current authority, repeats exactly, and uses one transaction in lock order", async () => {
    const db = new Fake();
    expect((await service(db).claimPendingIdempotency({ ...authority, claim })).status).toBe("PERSISTED");
    expect((await service(db).claimPendingIdempotency({ ...authority, claim })).status).toBe("PERSISTED");
    expect(new Set(db.transactionObjects.slice(0, db.calls.indexOf("commit"))).size).toBe(1);
    const names = db.calls;
    expect(names.indexOf("orchestration-state-store-postgres:lease-lock")).toBeLessThan(names.indexOf("orchestration-state-store-postgres:select-for-update"));
    expect(names.indexOf("orchestration-state-store-postgres:select-for-update")).toBeLessThan(names.indexOf("effect:pending-load"));
    expect(names.indexOf("effect:pending-load")).toBeLessThan(names.indexOf("execution-store-postgres:claim-insert"));
    expect(db.recovery?.["revision"]).toBe("2");
    expect(db.effect?.["state"]).toBe("PENDING");
  });
  it("rejects stale or contradictory authority before idempotency", async () => {
    for (const [change, status] of [
      [(db: Fake) => { db.lease = { ...db.lease, owner_id: "other" }; }, "LEASE_LOST"],
      [(db: Fake) => { db.lease = { ...db.lease, fence_token: "4" }; }, "FENCE_CONFLICT"],
      [(db: Fake) => { db.lease = { ...db.lease, expires_at_ms: "1000" }; }, "LEASE_LOST"],
      [(db: Fake) => { db.recovery = null; }, "RECOVERY_NOT_FOUND"],
      [(db: Fake) => { db.recovery = { ...db.recovery, revision: "3" }; }, "REVISION_CONFLICT"],
      [(db: Fake) => { db.recovery = { ...db.recovery, execution_authority_checkpoint_ref: "before" }; }, "CHECKPOINT_CONFLICT"],
      [(db: Fake) => { db.effect = null; }, "PENDING_NOT_FOUND"],
      [(db: Fake) => { db.effect = { ...db.effect, state: "RESOLVED", resolution_kind: "EXTERNAL_OUTCOME",
        resolved_authority_ref: "old",
        resolved_revision: 3, resolved_fence: 3 }; }, "PENDING_IDENTITY_CONFLICT"],
      [(db: Fake) => { db.proof = null; }, "PENDING_CREATION_PROOF_MISSING"],
    ] as const) {
      const db = new Fake(); change(db);
      expect((await service(db).claimPendingIdempotency({ ...authority, claim })).status).toBe(status);
      expect(db.idempotency).toBeNull();
    }
  });
  it("permits a historical creation revision and fence under coherent current authority", async () => {
    const db = new Fake();
    db.lease = { ...db.lease, fence_token: "4" };
    db.recovery = { ...db.recovery, revision: "3", fence_token: "4" };
    expect((await service(db).claimPendingIdempotency({ ...authority,
      expectedFence: 4 as PendingWriterAuthority["expectedFence"],
      expectedRecoveryRevision: 3 as PendingWriterAuthority["expectedRecoveryRevision"], claim })).status).toBe("PERSISTED");
  });
  it("rejects incoherent recovery fence and a checkpoint that loses creation history", async () => {
    const fence = new Fake();
    fence.recovery = { ...fence.recovery, fence_token: "4" };
    await expect(service(fence).claimPendingIdempotency({ ...authority, claim }))
      .rejects.toThrow("Lease/recovery fence incoherence");
    const history = new Fake();
    history.recovery = { ...history.recovery, revision: "3",
      execution_authority_checkpoint_ref: before.checkpointRef };
    await expect(service(history).claimPendingIdempotency({ ...authority,
      expectedRecoveryRevision: 3 as PendingWriterAuthority["expectedRecoveryRevision"],
      expectedCheckpointRef: before.checkpointRef, claim }))
      .rejects.toThrow("Current execution checkpoint does not descend");
  });
  it("distinguishes an infrastructure failure from an authority conflict", async () => {
    const db = new Fake(); db.failAt = "orchestration-state-store-postgres:select-for-update";
    await expect(service(db).claimPendingIdempotency({ ...authority, claim }))
      .rejects.toBeInstanceOf(PersistenceInfrastructureError);
  });
  it("accepts a next pending effect only with its nested adoption creation witness", async () => {
    const adopted = createExecutionAuthorityCheckpoint({ schemaVersion: "EXECUTION_AUTHORITY_CHECKPOINT_V1",
      checkpointRef: "adopted", evidence: { ...evidence, transitions: [requested, acknowledgement] } });
    const fill = { kind: "ENTRY_FILL_APPLIED", fill: { executionAttemptId: pending.executionAttemptId,
      adapterOrderId: "order-1", fillId: "fill-1", filledQuantity: "1",
      fillPrice: entry.request.limitPrice, filledAt: 2_100_102 } } as const;
    const next = createExecutionAuthorityCheckpoint({ schemaVersion: "EXECUTION_AUTHORITY_CHECKPOINT_V1",
      checkpointRef: "next", evidence: { ...evidence, transitions: [requested, acknowledgement,
        fill, { kind: "PROTECTION_REQUESTED" }] } });
    const fillOutcome = createOrchestrationExternalOutcome({ schemaVersion: "ORCHESTRATION_EXTERNAL_OUTCOME_V1",
      outcomeKey: "fill-outcome", sessionId: pending.sessionId, executionAttemptId: pending.executionAttemptId,
      observedAt: 2_100_102, observedFence: 3, pendingEffectIdentity: null,
      observation: { kind: "CANONICAL_EXECUTION_TRANSITION", transition: fill } });
    const filled = restoreExecutionAttemptFromEvidence({ ...evidence,
      transitions: [requested, acknowledgement, fill] });
    if (filled.status !== "EXECUTION_ATTEMPT_RESTORED") throw new Error("Bad fill fixture");
    const protection = requestProtection(filled.executionAttempt);
    if (protection.status !== "PROTECTION_REQUEST_READY") throw new Error("Bad protection fixture");
    const nextPending = createOrchestrationPendingEffect({ ...pending, operation: "PROTECTION_SUBMISSION",
      idempotencyKey: protection.request.idempotencyKey,
      requestFingerprint: fingerprintProtectionRequest(protection.request), createdRevision: 4 });
    const proof = proveOutcomeAdoptionCheckpointAdvance({ previousCheckpoint: adopted,
      committedCheckpoint: next, outcome: fillOutcome, nextPendingEffect: nextPending });
    if (proof.status !== "PROVEN") throw new Error("Bad nested proof fixture");
    const nextState = { ...recoveryState, executionAuthorityCheckpointRef: next.checkpointRef };
    const nested = { sessionId: pending.sessionId, expectedRevision: 3,
      previousCheckpointRef: adopted.checkpointRef, committedCheckpointRef: next.checkpointRef,
      resultingRecoveryState: nextState, pendingEffect: nextPending, advanceProof: proof.proof };
    const adoption = createExternalOutcomeAdoptionReceipt({
      schemaVersion: "ORCHESTRATION_EXTERNAL_OUTCOME_ADOPTION_RECEIPT_V1", outcomeKey: fillOutcome.outcomeKey,
      sessionId: pending.sessionId, executionAttemptId: pending.executionAttemptId,
      expectedRevision: 3, adoptedRevision: 4, adoptedFence: 3, adoptingOwnerId: "owner-1",
      previousCheckpointRef: adopted.checkpointRef, committedCheckpointRef: next.checkpointRef,
      resultingRecoveryState: nextState, linkedPendingResolution: null,
      nextPendingEffect: nextPending, nextPendingCommit: nested, advanceProof: proof.proof,
    }, adopted, next, fillOutcome);
    const db = new Fake();
    db.proof = null; db.effect = pendingRow(nextPending);
    db.recovery = { ...db.recovery, revision: "4", execution_authority_checkpoint_ref: next.checkpointRef };
    db.checkpoints.set(adopted.checkpointRef, checkpointRow(adopted));
    db.checkpoints.set(next.checkpointRef, checkpointRow(next));
    db.outcomes.push(outcomeRow(fillOutcome));
    db.adoptionProof = { schema_version: adoption.schemaVersion, outcome_key: adoption.outcomeKey,
      session_id: adoption.sessionId, execution_attempt_id: adoption.executionAttemptId,
      expected_revision: adoption.expectedRevision, adopted_revision: adoption.adoptedRevision,
      adopted_fence: adoption.adoptedFence, adopting_owner_id: adoption.adoptingOwnerId,
      previous_checkpoint_ref: adoption.previousCheckpointRef,
      committed_checkpoint_ref: adoption.committedCheckpointRef, commit_payload: adoption };
    const nextIdentity = { adapterId: nextPending.adapterId, environment: nextPending.environment,
      operation: nextPending.operation, executionAttemptId: nextPending.executionAttemptId,
      idempotencyKey: nextPending.idempotencyKey, requestFingerprint: nextPending.requestFingerprint };
    const request = { ...authority, expectedRecoveryRevision: 4 as PendingWriterAuthority["expectedRecoveryRevision"],
      expectedCheckpointRef: next.checkpointRef, pendingEffectIdentity: nextIdentity,
      claim: { ...nextIdentity, claimedAt: 2_100_104 } };
    expect((await service(db).claimPendingIdempotency(request)).status).toBe("PERSISTED");
    db.idempotency = null; db.adoptionProof = null;
    expect((await service(db).claimPendingIdempotency(request)).status).toBe("PENDING_CREATION_PROOF_MISSING");
  });
  it("rolls back each write after final lease loss", async () => {
    for (const action of ["claim", "status", "outcome", "terminal", "reconciliation"] as const) {
      const db = new Fake();
      if (action !== "claim") await service(db).claimPendingIdempotency({ ...authority, claim });
      const original = db.idempotency && { ...db.idempotency };
      db.failFinal = true;
      // One prior claim may have used two lease checks.
      db["leaseReads"] = 0;
      const writer = service(db);
      const result = action === "claim" ? await writer.claimPendingIdempotency({ ...authority, claim })
        : action === "status" ? await writer.recordPendingIdempotencyOutcome({ ...authority, update: confirmed })
          : action === "outcome" ? await writer.appendPendingOutcome({ ...authority, outcome: outcome() })
            : action === "terminal" ? await writer.persistPendingTerminalOutcome({ ...authority,
              update: confirmed, outcome: outcome() })
              : await writer.persistPendingReconciliationObservation({ ...authority, update: confirmed,
                outcome: outcome("disposition", { kind: "BROKER_DISPOSITION",
                  disposition: { status: "CONFIRMED_ACCEPTED", adapterOrderId: "order-1" } }) });
      expect(result.status).toBe("LEASE_LOST");
      expect(db.idempotency).toEqual(original);
      expect(db.outcomes).toHaveLength(0);
      expect(db.calls.at(-1)).toBe("rollback");
    }
  });
  it("atomically persists terminal and reconciliation facts without authority advances", async () => {
    const db = new Fake();
    await service(db).claimPendingIdempotency({ ...authority, claim });
    const writer = service(db);
    const txStart = db.transactionObjects.length;
    const callStart = db.calls.length;
    const terminal = await writer.persistPendingTerminalOutcome({ ...authority, update: confirmed, outcome: outcome() });
    expect(terminal.status).toBe("PERSISTED");
    expect(new Set(db.transactionObjects.slice(txStart)).size).toBe(1);
    const composedCalls = db.calls.slice(callStart);
    expect(composedCalls.indexOf("orchestration-state-store-postgres:lease-lock"))
      .toBeLessThan(composedCalls.indexOf("orchestration-state-store-postgres:select-for-update"));
    expect(composedCalls.indexOf("orchestration-state-store-postgres:select-for-update"))
      .toBeLessThan(composedCalls.indexOf("effect:pending-load"));
    expect(composedCalls.indexOf("effect:pending-load"))
      .toBeLessThan(composedCalls.indexOf("execution-store-postgres:outcome-select"));
    expect(composedCalls.indexOf("execution-store-postgres:outcome-update"))
      .toBeLessThan(composedCalls.indexOf("effect:outcome-insert"));
    expect(db.idempotency?.["status"]).toBe("CONFIRMED");
    expect(db.outcomes).toHaveLength(1);
    expect((await writer.persistPendingTerminalOutcome({ ...authority, update: confirmed,
      outcome: outcome() })).status).toBe("PERSISTED");
    expect((await writer.appendPendingOutcome({ ...authority, outcome: outcome("different") })).status).toBe("OUTCOME_CONFLICT");
    expect(db.recovery?.["revision"]).toBe("2");
    expect(db.recovery?.["execution_authority_checkpoint_ref"]).toBe("after");
    expect(db.effect?.["state"]).toBe("PENDING");
    expect(db.calls.indexOf("execution-store-postgres:outcome-update")).toBeLessThan(db.calls.indexOf("effect:outcome-insert"));
  });
  it("rolls back a terminal status when a different canonical fact already exists", async () => {
    const db = new Fake();
    await service(db).claimPendingIdempotency({ ...authority, claim });
    db.outcomes.push(outcomeRow(outcome("other-key")));
    const result = await service(db).persistPendingTerminalOutcome({ ...authority,
      update: confirmed, outcome: outcome() });
    expect(result.status).toBe("OUTCOME_CONFLICT");
    expect(db.idempotency?.["status"]).toBe("CLAIMED");
    expect(db.outcomes).toHaveLength(1);
    expect(db.calls.at(-1)).toBe("rollback");
  });
  it("does not append a terminal outcome when the idempotency transition is illegal", async () => {
    const db = new Fake(); const writer = service(db);
    await writer.claimPendingIdempotency({ ...authority, claim });
    await writer.recordPendingIdempotencyOutcome({ ...authority,
      update: { ...confirmed, status: "REJECTED", adapterOrderId: undefined } });
    expect((await writer.persistPendingTerminalOutcome({ ...authority,
      update: confirmed, outcome: outcome() })).status).toBe("IDEMPOTENCY_CONFLICT");
    expect(db.outcomes).toHaveLength(0);
    expect(db.idempotency?.["status"]).toBe("REJECTED");
  });
  it("rolls back a reconciliation status on a conflicting disposition and adds no canonical outcome", async () => {
    const db = new Fake();
    await service(db).claimPendingIdempotency({ ...authority, claim });
    db.outcomes.push(outcomeRow(outcome("prior", { kind: "BROKER_DISPOSITION",
      disposition: { status: "CONFIRMED_REJECTED" } })));
    const result = await service(db).persistPendingReconciliationObservation({ ...authority,
      update: confirmed, outcome: outcome("new", { kind: "BROKER_DISPOSITION",
        disposition: { status: "CONFIRMED_ACCEPTED", adapterOrderId: "order-1" } }) });
    expect(result.status).toBe("OUTCOME_CONFLICT");
    expect(db.idempotency?.["status"]).toBe("CLAIMED");
    expect(db.outcomes).toHaveLength(1);
    expect(db.outcomes.every((row) => row["observation_kind"] === "BROKER_DISPOSITION")).toBe(true);
  });
  it("keeps status transitions in the existing idempotency state machine", async () => {
    const db = new Fake(); const writer = service(db);
    await writer.claimPendingIdempotency({ ...authority, claim });
    const unknown = { ...confirmed, status: "OUTCOME_UNKNOWN" as const, adapterOrderId: undefined };
    expect((await writer.recordPendingIdempotencyOutcome({ ...authority, update: unknown })).status).toBe("PERSISTED");
    expect((await writer.recordPendingIdempotencyOutcome({ ...authority, update: unknown })).status).toBe("PERSISTED");
    expect((await writer.recordPendingIdempotencyOutcome({ ...authority,
      update: { ...confirmed, status: "SUBMITTED" } })).status).toBe("IDEMPOTENCY_CONFLICT");
    expect(db.idempotency?.["status"]).toBe("OUTCOME_UNKNOWN");
    expect(db.outcomes).toHaveLength(0);
  });
  it("fences claim conflicts and linked identity mismatches", async () => {
    const db = new Fake();
    await service(db).claimPendingIdempotency({ ...authority, claim });
    db.idempotency = { ...db.idempotency, request_fingerprint: "different" };
    expect((await service(db).claimPendingIdempotency({ ...authority, claim })).status).toBe("IDEMPOTENCY_CONFLICT");
    const differentIdentity = { ...identity, requestFingerprint: "different" as typeof identity.requestFingerprint };
    expect((await service(db).appendPendingOutcome({ ...authority,
      outcome: createOrchestrationExternalOutcome({ ...outcome(), pendingEffectIdentity: differentIdentity }) })).status)
      .toBe("PENDING_IDENTITY_CONFLICT");
  });
  it("persists reconciliation dispositions and legal unknown and retry observations", async () => {
    const db = new Fake(); const writer = service(db);
    await writer.claimPendingIdempotency({ ...authority, claim });
    const unknown = { ...confirmed, status: "OUTCOME_UNKNOWN" as const, adapterOrderId: undefined };
    expect((await writer.persistPendingReconciliationObservation({ ...authority, update: unknown,
      outcome: outcome("unknown", { kind: "BROKER_DISPOSITION",
        disposition: { status: "STILL_UNKNOWN" } }) })).status).toBe("PERSISTED");
    expect(db.outcomes).toHaveLength(1);
    expect((await writer.persistPendingReconciliationObservation({ ...authority, update: unknown,
      outcome: outcome("unknown", { kind: "BROKER_DISPOSITION",
        disposition: { status: "STILL_UNKNOWN" } }) })).status).toBe("PERSISTED");
    expect(db.outcomes).toHaveLength(1);
    const retry = { ...unknown, status: "RETRY_AUTHORIZED" as const, updatedAt: 2_100_104 };
    expect((await writer.persistPendingReconciliationObservation({ ...authority, update: retry,
      outcome: outcome("not-submitted", { kind: "BROKER_DISPOSITION",
        disposition: { status: "CONFIRMED_NOT_SUBMITTED" } }) })).status).toBe("PERSISTED");
    expect(db.idempotency?.["status"]).toBe("RETRY_AUTHORIZED");
    expect(db.outcomes).toHaveLength(2);
    expect(db.outcomes.every((row) => row["observation_kind"] === "BROKER_DISPOSITION")).toBe(true);
    expect(db.recovery?.["revision"]).toBe("2");
    expect(db.effect?.["state"]).toBe("PENDING");
  });
});
