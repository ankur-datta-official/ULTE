import { describe, expect, it } from "vitest";
import { createOrchestrationExternalOutcome, createTerminalNonSubmissionDispositionV1 } from
  "../../packages/orchestration-state-store/src/index.js";
import { PostgresIdempotencyRepository } from "../../packages/execution-store-postgres/src/index.js";
import { PostgresOrchestrationCommitService, PostgresOrchestrationEffectStore,
  PostgresOrchestrationRecoveryLeaseStore, PostgresOrchestrationFencedWriterService,
  PostgresTerminalNonSubmissionCommitService, PersistenceInfrastructureError, TerminalCommitError,
  type NormalTerminalNonSubmissionRequest } from
  "../../packages/orchestration-state-store-postgres/src/index.js";
import { B1fDatabase, LostCommitResponseError, bounded, deferred,
  type RealPostgresExecutor, type Marker } from "./b1f-postgres-helper.js";
import { adoptionFixture, pendingFixture, seed } from "./b1f-postgres-fixture.js";

async function prepared(db: B1fDatabase, status = "SUBMITTED"): Promise<NormalTerminalNonSubmissionRequest> {
  const fixture = pendingFixture();
  await seed(db, fixture.previous, { leaseMs: 30000 });
  expect((await new PostgresOrchestrationCommitService(db.a)
    .commitPendingIntent(fixture.request)).status).toBe("COMMITTED");
  const effect = fixture.request.pendingEffect;
  await db.observer.query(`INSERT INTO broker_idempotency_records
    (adapter_id,environment,idempotency_key,execution_attempt_id,operation,request_fingerprint,
     status,created_at_ms,updated_at_ms)
    VALUES ($1,$2,$3,$4,$5,$6,$7,100,101)`, [effect.adapterId, effect.environment,
    effect.idempotencyKey, effect.executionAttemptId, effect.operation, effect.requestFingerprint, status]);
  const identity = { adapterId: effect.adapterId, environment: effect.environment,
    operation: effect.operation, executionAttemptId: effect.executionAttemptId,
    idempotencyKey: effect.idempotencyKey, requestFingerprint: effect.requestFingerprint };
  const d = createTerminalNonSubmissionDispositionV1({
    schemaVersion: "TERMINAL_NON_SUBMISSION_DISPOSITION_V1", dispositionRef: "terminal-1",
    sessionId: effect.sessionId, executionAttemptId: effect.executionAttemptId,
    pendingEffectIdentity: identity, pendingCreatedRevision: 2, pendingCreatedFence: 3,
    pendingCreationRef: { kind: "PENDING_INTENT_COMMIT",
      committedCheckpointRef: fixture.request.committedCheckpoint.checkpointRef, committedRevision: 2 },
    expectedRecoveryRevision: 2, committedRevision: 3, committedFence: 3,
    committingOwnerId: fixture.request.ownerId,
    executionAuthorityCheckpointRefBefore: fixture.request.committedCheckpoint.checkpointRef,
    executionAuthorityCheckpointRefAfter: fixture.request.committedCheckpoint.checkpointRef,
    executionAuthorityIdentity: fixture.request.resultingRecoveryState.executionAuthorityIdentity,
    mode: "SANDBOX", instrumentId: fixture.request.resultingRecoveryState.instrumentId,
    riskBasisCheckpointRef: null, latestROutcomeRef: null,
    proof: { schemaVersion: "TERMINAL_NON_SUBMISSION_PROOF_V1",
      sourceKind: "TRUSTED_ADAPTER_FAILURE", sourceEventRef: "evidence-1", observedAt: 102,
      category: "INVALID_REQUEST", certainty: "DEFINITE_FAILURE",
      submissionExposure: "NOT_SUBMITTED", retryDisposition: "DO_NOT_RETRY",
      pendingEffectIdentity: identity },
    sessionDisposition: "TERMINAL_NON_SUBMISSION",
    resolution: { kind: "TERMINAL_NON_SUBMISSION", resolvedRevision: 3, resolvedFence: 3 },
  });
  const { schemaVersion: _version, committedFence: _fence, committingOwnerId: _owner,
    resolution, ...rest } = d;
  return { ownerId: fixture.request.ownerId, expectedFence: fixture.request.expectedFence,
    brokerStatusUpdatedAt: 103 as never,
    disposition: { ...rest, resolution: { kind: resolution.kind,
      resolvedRevision: resolution.resolvedRevision } } } as NormalTerminalNonSubmissionRequest;
}

async function state(db: B1fDatabase) {
  const broker = (await db.observer.query<{ status: string; updated_at_ms: string }>(
    "SELECT status,updated_at_ms FROM broker_idempotency_records", [])).rows[0]!;
  const pending = (await db.observer.query<{ state: string; resolution_kind: string | null;
    resolved_authority_ref: string | null }>(
    "SELECT state,resolution_kind,resolved_authority_ref FROM orchestration_pending_effect WHERE session_id='session-1'", [])).rows[0]!;
  const recovery = (await db.observer.query<{ revision: string;
    terminal_non_submission_disposition_ref: string | null }>(
    "SELECT revision,terminal_non_submission_disposition_ref FROM orchestration_recovery_state WHERE session_id='session-1'", [])).rows[0]!;
  const receipts = Number((await db.observer.query<{ n: string }>(
    "SELECT count(*)::bigint AS n FROM orchestration_terminal_non_submission_disposition", [])).rows[0]!.n);
  return { broker, pending, recovery, receipts };
}
function expectOpen(actual: Awaited<ReturnType<typeof state>>, status = "SUBMITTED") {
  expect(actual.broker.status).toBe(status);
  expect(actual.pending).toMatchObject({ state: "PENDING", resolution_kind: null,
    resolved_authority_ref: null });
  expect(actual.recovery).toMatchObject({ revision: "2", terminal_non_submission_disposition_ref: null });
  expect(actual.receipts).toBe(0);
}
function expectClosed(actual: Awaited<ReturnType<typeof state>>) {
  expect(actual.broker).toMatchObject({ status: "FAILED_NOT_SUBMITTED", updated_at_ms: "103" });
  expect(actual.pending).toMatchObject({ state: "RESOLVED",
    resolution_kind: "TERMINAL_NON_SUBMISSION", resolved_authority_ref: "terminal-1" });
  expect(actual.recovery).toMatchObject({ revision: "3",
    terminal_non_submission_disposition_ref: "terminal-1" });
  expect(actual.receipts).toBe(1);
}
async function realTest(work: (db: B1fDatabase) => Promise<void>) {
  const db = await B1fDatabase.create(true);
  try { await db.proveConnections(); await work(db); }
  finally { await db.dispose(); }
}
function service(db: B1fDatabase, side: "a" | "b" = "a") {
  return new PostgresTerminalNonSubmissionCommitService(db[side], db.target);
}
async function code(work: Promise<unknown>, expected: string) {
  await expect(work).rejects.toSatisfy((error: unknown) =>
    error instanceof TerminalCommitError && error.code === expected);
}
async function leaseRace<A, B>(db: B1fDatabase, runA: () => Promise<A>, runB: () => Promise<B>):
  Promise<readonly [PromiseSettledResult<A>, PromiseSettledResult<B>]> {
  const locked = deferred(), release = deferred(), issued = deferred();
  db.a.afterQuery = async (marker) => {
    if (marker === "orchestration-state-store-postgres:lease-lock") {
      locked.resolve(); await release.promise;
    }
  };
  db.b.beforeQuery = (marker) => {
    if (marker === "orchestration-state-store-postgres:lease-lock") issued.resolve();
  };
  const a = runA();
  let b: Promise<B> | undefined;
  try {
    await bounded(locked.promise, "D3N A lease lock");
    b = runB();
    await bounded(issued.promise, "D3N B lease query");
    while (db.b.lastTransactionPid === undefined) await bounded(new Promise<void>((resolve) =>
      setTimeout(resolve, 5)), "D3N B PID");
    const aPid = db.a.lastTransactionPid, bPid = db.b.lastTransactionPid;
    expect(aPid).toBeDefined(); expect(bPid).toBeDefined(); expect(aPid).not.toBe(bPid);
    await db.blocking(bPid!, aPid!);
    release.resolve();
    return await bounded(Promise.allSettled([a, b]) as Promise<
      readonly [PromiseSettledResult<A>, PromiseSettledResult<B>]>, "D3N race workers");
  } finally {
    release.resolve();
    try { await bounded(Promise.allSettled([a, ...(b ? [b] : [])]), "D3N race cleanup"); }
    finally { db.a.afterQuery = undefined; db.b.beforeQuery = undefined; }
  }
}

describe.sequential("D3N real PostgreSQL normal atomic terminal closure", () => {
  it("atomically closes SUBMITTED with exact trusted proof", () => realTest(async (db) => {
    const request = await prepared(db);
    expect((await service(db).commitNormalTerminalNonSubmissionDisposition(request)).status).toBe("COMMITTED");
    expectClosed(await state(db));
    const receipt = await db.observer.query<{ commit_payload: { disposition: { proof: unknown } } }>(
      "SELECT commit_payload FROM orchestration_terminal_non_submission_disposition", []);
    expect(receipt.rows[0]?.commit_payload.disposition.proof).toEqual(request.disposition.proof);
  }));

  it("recovers exact lost COMMIT response and rejects conflicting proof", () => realTest(async (db) => {
    const request = await prepared(db);
    db.a.loseNextCommitResponse = true;
    await expect(service(db).commitNormalTerminalNonSubmissionDisposition(request))
      .rejects.toSatisfy((error: unknown) => error instanceof PersistenceInfrastructureError
        && error.cause instanceof LostCommitResponseError);
    expect((await service(db, "b").commitNormalTerminalNonSubmissionDisposition(request)).status)
      .toBe("ALREADY_COMMITTED");
    await code(service(db, "b").commitNormalTerminalNonSubmissionDisposition({ ...request,
      disposition: { ...request.disposition, proof: { ...request.disposition.proof,
        sourceEventRef: "conflict" } } }), "RECEIPT_CONFLICT");
    expectClosed(await state(db));
  }));

  it.each(["FAILED_NOT_SUBMITTED", "OUTCOME_UNKNOWN", "RETRY_AUTHORIZED",
    "CONFIRMED", "REJECTED", "CLAIMED"])("rejects starting status %s", (status) => realTest(async (db) => {
      const request = await prepared(db, status);
      await code(service(db).commitNormalTerminalNonSubmissionDisposition(request), "IDEMPOTENCY_STATE_CONFLICT");
      expectOpen(await state(db), status);
    }));

  it("rejects order ID and exact broker identity mismatches", () => realTest(async (db) => {
    const request = await prepared(db);
    const p = request.disposition.pendingEffectIdentity;
    await db.observer.query("DELETE FROM broker_idempotency_records", []);
    await db.observer.query(`INSERT INTO broker_idempotency_records
      (adapter_id,environment,idempotency_key,execution_attempt_id,operation,request_fingerprint,
       status,created_at_ms,updated_at_ms,adapter_order_id)
      VALUES ($1,$2,$3,$4,$5,$6,'SUBMITTED',100,101,'order-1')`, [
        p.adapterId, p.environment, p.idempotencyKey, p.executionAttemptId,
        p.operation, p.requestFingerprint,
      ]);
    await code(service(db).commitNormalTerminalNonSubmissionDisposition(request), "IDEMPOTENCY_STATE_CONFLICT");
    await db.observer.query("DELETE FROM broker_idempotency_records", []);
    await db.observer.query(`INSERT INTO broker_idempotency_records
      (adapter_id,environment,idempotency_key,execution_attempt_id,operation,request_fingerprint,
       status,created_at_ms,updated_at_ms)
      VALUES ($1,$2,$3,'wrong-attempt',$4,$5,'SUBMITTED',100,101)`, [
        request.disposition.pendingEffectIdentity.adapterId,
        request.disposition.pendingEffectIdentity.environment,
        request.disposition.pendingEffectIdentity.idempotencyKey,
        request.disposition.pendingEffectIdentity.operation,
        request.disposition.pendingEffectIdentity.requestFingerprint,
      ]);
    await code(service(db).commitNormalTerminalNonSubmissionDisposition(request), "IDEMPOTENCY_STATE_CONFLICT");
    expectOpen(await state(db));
  }));

  it.each(["adapterId", "environment", "idempotencyKey", "operation",
    "executionAttemptId", "requestFingerprint"] as const)(
    "rejects a wrong broker %s", (field) => realTest(async (db) => {
      const request = await prepared(db);
      const p = request.disposition.pendingEffectIdentity;
      const broker = { ...p, [field]: field === "environment" ? "DRY_RUN"
        : field === "operation" ? "ENTRY_CANCELLATION" : "different" };
      await db.observer.query("DELETE FROM broker_idempotency_records", []);
      await db.observer.query(`INSERT INTO broker_idempotency_records
        (adapter_id,environment,idempotency_key,execution_attempt_id,operation,request_fingerprint,
         status,created_at_ms,updated_at_ms)
        VALUES ($1,$2,$3,$4,$5,$6,'SUBMITTED',100,101)`, [broker.adapterId,
          broker.environment, broker.idempotencyKey, broker.executionAttemptId,
          broker.operation, broker.requestFingerprint]);
      await code(service(db).commitNormalTerminalNonSubmissionDisposition(request), "IDEMPOTENCY_STATE_CONFLICT");
      expectOpen(await state(db));
    }));

  it("rejects reviewed, malformed, and chronologically impossible proof", () => realTest(async (db) => {
    const request = await prepared(db);
    const proof = request.disposition.proof;
    for (const changed of [
      { ...proof, sourceKind: "REVIEWED_LEGACY_ATTESTATION" },
      { ...proof, category: "RATE_LIMIT" },
      { ...proof, certainty: "OUTCOME_UNKNOWN" },
      { ...proof, submissionExposure: "MAY_HAVE_BEEN_SUBMITTED" },
      { ...proof, retryDisposition: "RETRY_SAFE" },
      { ...proof, sourceEventRef: " " },
      { ...proof, observedAt: -1 },
      { ...proof, adapterReasonCode: " " },
      { ...proof, pendingEffectIdentity: { ...proof.pendingEffectIdentity, idempotencyKey: "other" } },
      { ...proof, observedAt: 99 },
    ]) {
      await expect(service(db).commitNormalTerminalNonSubmissionDisposition({ ...request,
        disposition: { ...request.disposition, proof: changed as never } })).rejects.toThrow();
    }
    await expect(service(db).commitNormalTerminalNonSubmissionDisposition({ ...request,
      brokerStatusUpdatedAt: 101 as never })).rejects.toThrow();
    expectOpen(await state(db));
  }));

  it("rejects contradictory canonical outcome and capability loss", () => realTest(async (db) => {
    const request = await prepared(db);
    const outcome = createOrchestrationExternalOutcome({ schemaVersion: "ORCHESTRATION_EXTERNAL_OUTCOME_V1",
      outcomeKey: "canonical-1", sessionId: request.disposition.sessionId,
      executionAttemptId: request.disposition.executionAttemptId, observedAt: 103, observedFence: 3,
      pendingEffectIdentity: request.disposition.pendingEffectIdentity,
      observation: { kind: "BROKER_DISPOSITION", disposition: { status: "CONFIRMED_REJECTED" } } });
    expect((await new PostgresOrchestrationEffectStore(db.observer).appendOutcome(outcome)).status).toBe("APPENDED");
    await code(service(db).commitNormalTerminalNonSubmissionDisposition(request), "IDEMPOTENCY_STATE_CONFLICT");
    await code(new PostgresTerminalNonSubmissionCommitService(db.a,
      { ...db.target, database: "wrong" }).commitNormalTerminalNonSubmissionDisposition(request),
    "CAPABILITY_UNAVAILABLE");
    await code(new PostgresTerminalNonSubmissionCommitService(db.a,
      { ...db.target, schema: "public" }).commitNormalTerminalNonSubmissionDisposition(request),
    "CAPABILITY_UNAVAILABLE");
    expectOpen(await state(db));
  }));

  it.each(["ack", "rejection"] as const)("rejects linked canonical %s", (kind) => realTest(async (db) => {
    const request = await prepared(db);
    expect((await new PostgresOrchestrationEffectStore(db.observer)
      .appendOutcome(adoptionFixture(kind).outcome)).status).toBe("APPENDED");
    await code(service(db).commitNormalTerminalNonSubmissionDisposition(request), "IDEMPOTENCY_STATE_CONFLICT");
    expectOpen(await state(db));
  }));

  it.each(["execution-store-postgres:outcome-update", "receipt:terminal-insert",
    "effect:terminal-resolve", "orchestration-state-store-postgres:terminal-update"] as const)(
    "rolls back broker and all authority after %s failure", (marker: Marker) => realTest(async (db) => {
      const request = await prepared(db);
      db.a.afterQuery = (seen) => { if (seen === marker) throw new Error("injected failure"); };
      try { await expect(service(db).commitNormalTerminalNonSubmissionDisposition(request)).rejects.toThrow(); }
      finally { db.a.afterQuery = undefined; }
      expectOpen(await state(db));
    }));

  it("rolls back when failure occurs before the broker status update", () => realTest(async (db) => {
    const request = await prepared(db);
    db.a.beforeQuery = (marker) => {
      if (marker === "execution-store-postgres:outcome-update") throw new Error("injected before status");
    };
    try { await expect(service(db).commitNormalTerminalNonSubmissionDisposition(request)).rejects.toThrow(); }
    finally { db.a.beforeQuery = undefined; }
    expectOpen(await state(db));
  }));

  it("rolls back every change when COMMIT fails before completion", () => realTest(async (db) => {
    const request = await prepared(db);
    db.a.failNextCommit = true;
    await expect(service(db).commitNormalTerminalNonSubmissionDisposition(request))
      .rejects.toSatisfy((error: unknown) => error instanceof PersistenceInfrastructureError
        && error.cause instanceof Error && error.cause.message.includes("before PostgreSQL COMMIT"));
    expectOpen(await state(db));
  }));

  it("rolls back the broker transition when final lease check expires", () => realTest(async (db) => {
    const request = await prepared(db);
    const expiry = await db.nowMs() + 1800;
    await db.observer.query("UPDATE orchestration_recovery_lease SET expires_at_ms=$1 WHERE session_id='session-1'", [expiry]);
    db.a.afterQuery = async (marker) => {
      if (marker === "orchestration-state-store-postgres:terminal-update") await db.untilDbTime(expiry);
    };
    try { await code(service(db).commitNormalTerminalNonSubmissionDisposition(request), "LEASE_LOST"); }
    finally { db.a.afterQuery = undefined; }
    expectOpen(await state(db));
  }));

  it("rejects stale fence and old owner after takeover", () => realTest(async (db) => {
    const request = await prepared(db);
    await code(service(db).commitNormalTerminalNonSubmissionDisposition({ ...request,
      expectedFence: 4 as never }), "FENCE_CONFLICT");
    await db.observer.query("UPDATE orchestration_recovery_lease SET expires_at_ms=$1 WHERE session_id='session-1'",
      [await db.nowMs() - 1]);
    const takeover = await new PostgresOrchestrationRecoveryLeaseStore(db.b).acquireRecoveryLease({
      sessionId: request.disposition.sessionId, ownerId: "owner-2" as never,
      leaseDurationMs: 30000 as never });
    expect(takeover.status).toBe("ACQUIRED");
    await code(service(db).commitNormalTerminalNonSubmissionDisposition(request), "LEASE_LOST");
    expectOpen(await state(db));
  }));

  it("rejects incoherent lease and recovery fences without writes", () => realTest(async (db) => {
    const request = await prepared(db);
    await db.observer.query("UPDATE orchestration_recovery_state SET fence_token=4 WHERE session_id='session-1'", []);
    await expect(service(db).commitNormalTerminalNonSubmissionDisposition(request)).rejects.toThrow(
      "Lease/recovery fence incoherence");
    expectOpen(await state(db));
  }));

  it("serializes identical normal requests on distinct blocked backends", () => realTest(async (db) => {
    const request = await prepared(db);
    const [a, b] = await leaseRace(db,
      () => service(db).commitNormalTerminalNonSubmissionDisposition(request),
      () => service(db, "b").commitNormalTerminalNonSubmissionDisposition(request));
    expect(a.status).toBe("fulfilled"); expect(b.status).toBe("fulfilled");
    if (a.status === "fulfilled") expect(a.value.status).toBe("COMMITTED");
    if (b.status === "fulfilled") expect(b.value.status).toBe("ALREADY_COMMITTED");
    expectClosed(await state(db));
  }));

  it("serializes conflicting normal requests to one immutable receipt", () => realTest(async (db) => {
    const request = await prepared(db);
    const other = { ...request, disposition: { ...request.disposition,
      proof: { ...request.disposition.proof, sourceEventRef: "different-evidence" } } };
    const [a, b] = await leaseRace(db,
      () => service(db).commitNormalTerminalNonSubmissionDisposition(request),
      () => service(db, "b").commitNormalTerminalNonSubmissionDisposition(other));
    expect(a.status).toBe("fulfilled"); expect(b.status).toBe("rejected");
    if (a.status === "fulfilled") expect(a.value.status).toBe("COMMITTED");
    if (b.status === "rejected") {
      expect(b.reason).toBeInstanceOf(TerminalCommitError);
      expect(b.reason.code).toBe("RECEIPT_CONFLICT");
    }
    expectClosed(await state(db));
  }));

  it("fenced status writer cannot create a split state", () => realTest(async (db) => {
    const request = await prepared(db);
    const p = request.disposition.pendingEffectIdentity;
    expect(() => new PostgresOrchestrationFencedWriterService(db.b).recordPendingIdempotencyOutcome({
        sessionId: request.disposition.sessionId, ownerId: request.ownerId,
        expectedFence: request.expectedFence,
        expectedRecoveryRevision: request.disposition.expectedRecoveryRevision,
        expectedCheckpointRef: request.disposition.executionAuthorityCheckpointRefBefore,
        pendingEffectIdentity: p,
        update: { adapterId: p.adapterId, environment: p.environment,
          idempotencyKey: p.idempotencyKey, requestFingerprint: p.requestFingerprint,
          status: "FAILED_NOT_SUBMITTED", updatedAt: 104 as never } as never,
      })).toThrow("atomic terminal closure");
    expectOpen(await state(db));
    expect((await service(db).commitNormalTerminalNonSubmissionDisposition(request)).status).toBe("COMMITTED");
    expectClosed(await state(db));
  }));

  it("serializes a legacy broker status writer behind D3N's broker lock", () => realTest(async (db) => {
    const request = await prepared(db);
    const p = request.disposition.pendingEffectIdentity;
    const locked = deferred(), release = deferred(), issued = deferred();
    db.a.afterQuery = async (marker) => {
      if (marker === "terminal:broker-lock") { locked.resolve(); await release.promise; }
    };
    db.b.beforeQuery = (marker) => {
      if (marker === "execution-store-postgres:outcome-select") issued.resolve();
    };
    const a = service(db).commitNormalTerminalNonSubmissionDisposition(request);
    let b: ReturnType<PostgresIdempotencyRepository["recordOutcome"]> | undefined;
    try {
      await bounded(locked.promise, "D3N broker row locked");
      b = new PostgresIdempotencyRepository(db.b).recordOutcome({
        adapterId: p.adapterId, environment: p.environment, idempotencyKey: p.idempotencyKey,
        requestFingerprint: p.requestFingerprint, status: "FAILED_NOT_SUBMITTED",
        updatedAt: 104 as never,
      });
      await bounded(issued.promise, "legacy status query issued");
      const aPid = db.a.lastTransactionPid, bPid = db.b.lastTransactionPid;
      expect(aPid).toBeDefined(); expect(bPid).toBeDefined(); expect(aPid).not.toBe(bPid);
      await db.blocking(bPid!, aPid!);
      release.resolve();
      expect((await bounded(a, "D3N broker race winner")).status).toBe("COMMITTED");
      expect((await bounded(b, "legacy broker writer")).status).toBe("DUPLICATE_SAME");
      expectClosed(await state(db));
    } finally {
      release.resolve();
      try { await bounded(Promise.allSettled([a, ...(b ? [b] : [])]), "D3N broker race cleanup"); }
      finally { db.a.afterQuery = undefined; db.b.beforeQuery = undefined; }
    }
  }));
});
