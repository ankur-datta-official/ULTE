import { describe, expect, it } from "vitest";
import { createExecutionAuthorityCheckpoint, createOrchestrationExternalOutcome,
  createTerminalNonSubmissionDispositionV1,
  proveOutcomeAdoptionCheckpointAdvance,
  type TerminalNonSubmissionDispositionLogicalPayload } from "../../packages/orchestration-state-store/src/index.js";
import { PostgresOrchestrationCommitService, PostgresTerminalNonSubmissionCommitService,
  PostgresOrchestrationEffectStore, PostgresOrchestrationRecoveryLeaseStore,
  PersistenceConflictError, PersistenceInfrastructureError, TerminalCommitError,
  type CommitTerminalNonSubmissionDispositionRequest } from
  "../../packages/orchestration-state-store-postgres/src/index.js";
import { B1fDatabase, LostCommitResponseError, bounded, deferred,
  type RealPostgresExecutor } from "./b1f-postgres-helper.js";
import { adoptionFixture, cancellationFixture, pendingFixture, seed } from "./b1f-postgres-fixture.js";

async function prepared(db: B1fDatabase, status = "FAILED_NOT_SUBMITTED",
  kind: "entry" | "cancellation" = "entry") {
  const fixture = kind === "entry" ? pendingFixture() : cancellationFixture();
  await seed(db, fixture.previous, { leaseMs: 30000 });
  expect((await new PostgresOrchestrationCommitService(db.a)
    .commitPendingIntent(fixture.request)).status).toBe("COMMITTED");
  const effect = fixture.request.pendingEffect;
  await db.observer.query(`INSERT INTO broker_idempotency_records
    (adapter_id,environment,idempotency_key,execution_attempt_id,operation,request_fingerprint,
     status,created_at_ms,updated_at_ms)
    VALUES ($1,$2,$3,$4,$5,$6,$7,100,101)`, [effect.adapterId, effect.environment,
    effect.idempotencyKey, effect.executionAttemptId, effect.operation, effect.requestFingerprint, status]);
  const d = createTerminalNonSubmissionDispositionV1({
    schemaVersion: "TERMINAL_NON_SUBMISSION_DISPOSITION_V1", dispositionRef: "terminal-1",
    sessionId: effect.sessionId, executionAttemptId: effect.executionAttemptId,
    pendingEffectIdentity: { adapterId: effect.adapterId, environment: effect.environment,
      operation: effect.operation, executionAttemptId: effect.executionAttemptId,
      idempotencyKey: effect.idempotencyKey, requestFingerprint: effect.requestFingerprint },
    pendingCreatedRevision: 2, pendingCreatedFence: 3,
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
      pendingEffectIdentity: { adapterId: effect.adapterId, environment: effect.environment,
        operation: effect.operation, executionAttemptId: effect.executionAttemptId,
        idempotencyKey: effect.idempotencyKey, requestFingerprint: effect.requestFingerprint } },
    sessionDisposition: "TERMINAL_NON_SUBMISSION",
    resolution: { kind: "TERMINAL_NON_SUBMISSION", resolvedRevision: 3, resolvedFence: 3 },
  });
  const { schemaVersion: _version, committedFence: _fence, committingOwnerId: _owner,
    resolution, ...rest } = d;
  const disposition: TerminalNonSubmissionDispositionLogicalPayload = {
    ...rest, resolution: { kind: resolution.kind, resolvedRevision: resolution.resolvedRevision },
  };
  const request: CommitTerminalNonSubmissionDispositionRequest = {
    ownerId: fixture.request.ownerId, expectedFence: fixture.request.expectedFence, disposition,
  };
  return request;
}

async function snapshot(db: B1fDatabase) {
  const recovery = (await db.observer.query<{ schema_version: string; revision: string;
    fence_token: string; terminal_non_submission_disposition_ref: string | null;
    execution_authority_checkpoint_ref: string }>(`SELECT schema_version,revision,fence_token,
    terminal_non_submission_disposition_ref,execution_authority_checkpoint_ref
    FROM orchestration_recovery_state WHERE session_id='session-1'`, [])).rows[0]!;
  const pending = (await db.observer.query<{ schema_version: string; state: string;
    resolution_kind: string | null; resolved_authority_ref: string | null }>(`SELECT schema_version,state,
    resolution_kind,resolved_authority_ref FROM orchestration_pending_effect WHERE session_id='session-1'`, [])).rows[0]!;
  const receipts = Number((await db.observer.query<{ n: string }>(
    "SELECT count(*)::bigint AS n FROM orchestration_terminal_non_submission_disposition", [])).rows[0]!.n);
  return { recovery, pending, receipts };
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

async function proveBlocked(db: B1fDatabase, a: RealPostgresExecutor,
  b: RealPostgresExecutor): Promise<void> {
  await bounded((async () => { while (b.lastTransactionPid === undefined)
    await new Promise((resolve) => setTimeout(resolve, 5)); })(), "D3 B transaction PID");
  const aPid = a.lastTransactionPid, bPid = b.lastTransactionPid;
  expect(aPid).toBeDefined(); expect(bPid).toBeDefined(); expect(aPid).not.toBe(bPid);
  expect(db.introspection).toBe(true);
  await db.blocking(bPid!, aPid!);
}

async function leaseRace<A, B>(db: B1fDatabase, runA: () => Promise<A>, runB: () => Promise<B>):
  Promise<readonly [PromiseSettledResult<A>, PromiseSettledResult<B>]> {
  const locked = deferred(), release = deferred(), bQueryStarted = deferred();
  db.a.afterQuery = async (marker) => {
    if (marker === "orchestration-state-store-postgres:lease-lock") {
      locked.resolve(); await release.promise;
    }
  };
  db.b.beforeQuery = (marker) => {
    if (marker === "orchestration-state-store-postgres:lease-lock") bQueryStarted.resolve();
  };
  const a = runA();
  let b: Promise<B> | undefined;
  try {
    await bounded(locked.promise, "D3 A acquired lease row lock");
    b = runB();
    await bounded(bQueryStarted.promise, "D3 B issued lease lock SQL");
    await proveBlocked(db, db.a, db.b);
    release.resolve();
    return await bounded(Promise.allSettled([a, b]) as Promise<
      readonly [PromiseSettledResult<A>, PromiseSettledResult<B>]>, "D3 race workers");
  } finally {
    release.resolve();
    try { await bounded(Promise.allSettled([a, ...(b ? [b] : [])]), "D3 race cleanup"); }
    finally { db.a.afterQuery = undefined; db.b.beforeQuery = undefined; }
  }
}

describe.sequential("D3 real PostgreSQL atomic terminal commit", () => {
  it("closes historical definite non-submission, preserves authority, and retries exactly once", () => realTest(async (db) => {
    const request = await prepared(db);
    expect((await service(db).commitTerminalNonSubmissionDisposition(request)).status).toBe("COMMITTED");
    const state = await snapshot(db);
    expect(state.recovery).toMatchObject({ schema_version: "ORCHESTRATION_RECOVERY_RECORD_V2",
      revision: "3", fence_token: "3", terminal_non_submission_disposition_ref: "terminal-1",
      execution_authority_checkpoint_ref: request.disposition.executionAuthorityCheckpointRefBefore });
    expect(state.pending).toMatchObject({ schema_version: "ORCHESTRATION_PENDING_EFFECT_V2",
      state: "RESOLVED", resolution_kind: "TERMINAL_NON_SUBMISSION",
      resolved_authority_ref: "terminal-1" });
    expect(state.receipts).toBe(1);
    expect((await service(db, "b").commitTerminalNonSubmissionDisposition({ ...request,
      ownerId: "old-owner" as never, expectedFence: 9 as never })).status).toBe("ALREADY_COMMITTED");
    expect(await snapshot(db)).toEqual(state);
    await code(service(db).commitTerminalNonSubmissionDisposition({ ...request,
      disposition: { ...request.disposition, proof: { ...request.disposition.proof,
        sourceEventRef: "other" } } }), "RECEIPT_CONFLICT");
    expect(await snapshot(db)).toEqual(state);
  }));

  it("recovers a lost COMMIT response without advancing revision twice", () => realTest(async (db) => {
    const request = await prepared(db);
    db.a.loseNextCommitResponse = true;
    await expect(service(db).commitTerminalNonSubmissionDisposition(request))
      .rejects.toSatisfy((error: unknown) => error instanceof PersistenceInfrastructureError
        && error.cause instanceof LostCommitResponseError);
    expect((await service(db, "b").commitTerminalNonSubmissionDisposition(request)).status)
      .toBe("ALREADY_COMMITTED");
    expect((await snapshot(db)).receipts).toBe(1);
    expect((await snapshot(db)).recovery.revision).toBe("3");
  }));

  it("rejects missing capability, wrong database, and nonterminal broker status without writing", () => realTest(async (db) => {
    const request = await prepared(db, "OUTCOME_UNKNOWN");
    await code(new PostgresTerminalNonSubmissionCommitService(db.a,
      { ...db.target, database: "wrong" }).commitTerminalNonSubmissionDisposition(request),
    "CAPABILITY_UNAVAILABLE");
    await code(new PostgresTerminalNonSubmissionCommitService(db.a,
      { ...db.target, schema: "public" }).commitTerminalNonSubmissionDisposition(request),
    "CAPABILITY_UNAVAILABLE");
    await code(service(db).commitTerminalNonSubmissionDisposition(request), "IDEMPOTENCY_STATE_CONFLICT");
    const state = await snapshot(db);
    expect(state.recovery.revision).toBe("2"); expect(state.pending.state).toBe("PENDING");
    expect(state.receipts).toBe(0);
  }));

  it("fails closed when the coordinated migration ledger loses D2C capability", () => realTest(async (db) => {
    const request = await prepared(db);
    await db.observer.query("DELETE FROM ulte_schema_migrations WHERE stream='INTEGRATION'", []);
    await code(service(db).commitTerminalNonSubmissionDisposition(request), "CAPABILITY_UNAVAILABLE");
    const state = await snapshot(db);
    expect(state.recovery.revision).toBe("2"); expect(state.pending.state).toBe("PENDING");
    expect(state.receipts).toBe(0);
  }));

  it("requires the exact durable broker idempotency row", () => realTest(async (db) => {
    const request = await prepared(db);
    await db.observer.query("DELETE FROM broker_idempotency_records", []);
    await code(service(db).commitTerminalNonSubmissionDisposition(request), "IDEMPOTENCY_STATE_CONFLICT");
    const state = await snapshot(db);
    expect(state.recovery.revision).toBe("2"); expect(state.pending.state).toBe("PENDING");
    expect(state.receipts).toBe(0);
  }));

  it("rejects stale fence, old owner after takeover, and an already resolved pending effect", () => realTest(async (db) => {
    const request = await prepared(db);
    await code(service(db).commitTerminalNonSubmissionDisposition({ ...request,
      expectedFence: 4 as never }), "FENCE_CONFLICT");
    await db.observer.query("UPDATE orchestration_recovery_lease SET expires_at_ms = $1 WHERE session_id='session-1'",
      [await db.nowMs() - 1]);
    const takeover = await new PostgresOrchestrationRecoveryLeaseStore(db.b).acquireRecoveryLease({
      sessionId: request.disposition.sessionId, ownerId: "owner-2" as never,
      leaseDurationMs: 30000 as never });
    expect(takeover.status).toBe("ACQUIRED");
    await code(service(db).commitTerminalNonSubmissionDisposition(request), "LEASE_LOST");
    await db.observer.query(`UPDATE orchestration_pending_effect SET schema_version='ORCHESTRATION_PENDING_EFFECT_V2',
      state='RESOLVED',resolution_kind='EXTERNAL_OUTCOME',resolved_authority_ref='other',
      resolved_revision=3,resolved_fence=4 WHERE session_id='session-1'`, []);
    await code(service(db, "b").commitTerminalNonSubmissionDisposition({ ...request,
      ownerId: "owner-2" as never, expectedFence: 4 as never }), "PENDING_CONFLICT");
    const state = await snapshot(db);
    expect(state.recovery.revision).toBe("2"); expect(state.receipts).toBe(0);
  }));

  it("rolls back when the lease expires at the final authority check", () => realTest(async (db) => {
    const request = await prepared(db);
    const expiry = await db.nowMs() + 1800;
    await db.observer.query("UPDATE orchestration_recovery_lease SET expires_at_ms = $1 WHERE session_id='session-1'", [expiry]);
    db.a.afterQuery = async (marker) => {
      if (marker === "orchestration-state-store-postgres:terminal-update") await db.untilDbTime(expiry);
    };
    try { await code(service(db).commitTerminalNonSubmissionDisposition(request), "LEASE_LOST"); }
    finally { db.a.afterQuery = undefined; }
    const state = await snapshot(db);
    expect(state.recovery.revision).toBe("2"); expect(state.pending.state).toBe("PENDING");
    expect(state.receipts).toBe(0);
  }));

  it.each(["receipt:terminal-insert", "effect:terminal-resolve",
    "orchestration-state-store-postgres:terminal-update"] as const)(
    "rolls back every write on failure at %s", (marker) => realTest(async (db) => {
      const request = await prepared(db);
      db.a.afterQuery = (seen) => { if (seen === marker) throw new Error("injected failure"); };
      await expect(service(db).commitTerminalNonSubmissionDisposition(request)).rejects.toThrow();
      db.a.afterQuery = undefined;
      const state = await snapshot(db);
      expect(state.recovery.revision).toBe("2"); expect(state.pending.state).toBe("PENDING");
      expect(state.receipts).toBe(0);
    }));

  it("serializes identical concurrent commits to one receipt and one revision advance", () => realTest(async (db) => {
    const request = await prepared(db);
    const [a, b] = await leaseRace(db,
      () => service(db).commitTerminalNonSubmissionDisposition(request),
      () => service(db, "b").commitTerminalNonSubmissionDisposition(request));
    expect(a.status).toBe("fulfilled"); expect(b.status).toBe("fulfilled");
    if (a.status === "fulfilled") expect(a.value.status).toBe("COMMITTED");
    if (b.status === "fulfilled") expect(b.value.status).toBe("ALREADY_COMMITTED");
    const state = await snapshot(db);
    expect(state.receipts).toBe(1); expect(state.recovery.revision).toBe("3");
    expect(state.recovery.terminal_non_submission_disposition_ref).toBe("terminal-1");
    expect(state.pending).toMatchObject({ state: "RESOLVED",
      resolution_kind: "TERMINAL_NON_SUBMISSION", resolved_authority_ref: "terminal-1" });
  }));

  it("serializes conflicting concurrent payloads and enforces receipt immutability", () => realTest(async (db) => {
    const request = await prepared(db);
    const other = { ...request, disposition: { ...request.disposition,
      proof: { ...request.disposition.proof, sourceEventRef: "different-evidence" } } };
    const [winner, loser] = await leaseRace(db,
      () => service(db).commitTerminalNonSubmissionDisposition(request),
      () => service(db, "b").commitTerminalNonSubmissionDisposition(other));
    expect(winner.status).toBe("fulfilled");
    if (winner.status === "fulfilled") expect(winner.value.status).toBe("COMMITTED");
    expect(loser.status).toBe("rejected");
    if (loser.status === "rejected") {
      expect(loser.reason).toBeInstanceOf(TerminalCommitError);
      expect(loser.reason.code).toBe("RECEIPT_CONFLICT");
    }
    const state = await snapshot(db);
    expect(state.receipts).toBe(1); expect(state.recovery.revision).toBe("3");
    expect(state.pending).toMatchObject({ state: "RESOLVED",
      resolution_kind: "TERMINAL_NON_SUBMISSION", resolved_authority_ref: "terminal-1" });
    await expect(db.observer.query("UPDATE orchestration_terminal_non_submission_disposition SET source_event_ref='x'", []))
      .rejects.toThrow();
    await expect(db.observer.query("DELETE FROM orchestration_terminal_non_submission_disposition", []))
      .rejects.toThrow();
    expect(await snapshot(db)).toEqual(state);
  }));

  it("rejects a linked canonical outcome before terminal closure", () => realTest(async (db) => {
    const request = await prepared(db);
    const outcome = adoptionFixture("rejection").outcome;
    expect((await new PostgresOrchestrationEffectStore(db.observer).appendOutcome(outcome)).status).toBe("APPENDED");
    await code(service(db).commitTerminalNonSubmissionDisposition(request), "IDEMPOTENCY_STATE_CONFLICT");
    const state = await snapshot(db);
    expect(state.recovery.revision).toBe("2"); expect(state.pending.state).toBe("PENDING");
    expect(state.receipts).toBe(0);
  }));

  it.each(["STILL_UNKNOWN", "CONFIRMED_ACCEPTED", "CONFIRMED_REJECTED"] as const)(
    "rejects linked %s broker disposition before terminal closure", (status) => realTest(async (db) => {
      const request = await prepared(db);
      const outcome = createOrchestrationExternalOutcome({
        schemaVersion: "ORCHESTRATION_EXTERNAL_OUTCOME_V1", outcomeKey: `disposition-${status}`,
        sessionId: request.disposition.sessionId,
        executionAttemptId: request.disposition.executionAttemptId,
        observedAt: 103, observedFence: 3,
        pendingEffectIdentity: request.disposition.pendingEffectIdentity,
        observation: { kind: "BROKER_DISPOSITION", disposition: { status } },
      });
      expect((await new PostgresOrchestrationEffectStore(db.observer).appendOutcome(outcome)).status)
        .toBe("APPENDED");
      await code(service(db).commitTerminalNonSubmissionDisposition(request), "IDEMPOTENCY_STATE_CONFLICT");
      const state = await snapshot(db);
      expect(state.recovery.revision).toBe("2"); expect(state.pending.state).toBe("PENDING");
      expect(state.receipts).toBe(0);
    }));

  it("blocks unlinked fill adoption behind terminal closure on the shared lease row", () => realTest(async (db) => {
    const request = await prepared(db, "FAILED_NOT_SUBMITTED", "cancellation");
    const cancellation = cancellationFixture();
    const fill = adoptionFixture("fill-next");
    const transition = fill.outcome.observation;
    if (transition.kind !== "CANONICAL_EXECUTION_TRANSITION") throw new Error("Expected canonical fill fixture");
    const prior = cancellation.request.committedCheckpoint;
    const committed = createExecutionAuthorityCheckpoint({ ...prior,
      checkpointRef: "fill-after-cancellation-request",
      evidence: { ...prior.evidence,
        transitions: [...prior.evidence.transitions, transition.transition] } });
    expect(fill.outcome.pendingEffectIdentity).toBeNull();
    expect(proveOutcomeAdoptionCheckpointAdvance({ previousCheckpoint: prior,
      committedCheckpoint: committed, outcome: fill.outcome,
      nextPendingEffect: null }).status).toBe("PROVEN");
    expect((await new PostgresOrchestrationEffectStore(db.observer).appendOutcome(fill.outcome)).status)
      .toBe("APPENDED");
    const adoptionRequest = { ...fill.request,
      expectedRevision: 2 as typeof fill.request.expectedRevision,
      previousCheckpointRef: prior.checkpointRef, committedCheckpoint: committed,
      resultingRecoveryState: { ...fill.request.resultingRecoveryState,
        executionAuthorityCheckpointRef: committed.checkpointRef } };
    const [terminal, adopted] = await leaseRace(db,
      () => service(db).commitTerminalNonSubmissionDisposition(request),
      () => new PostgresOrchestrationCommitService(db.b).adoptOutcome(adoptionRequest));
    expect(terminal.status).toBe("fulfilled");
    if (terminal.status === "fulfilled") expect(terminal.value.status).toBe("COMMITTED");
    expect(adopted.status).toBe("rejected");
    if (adopted.status === "rejected") {
      expect(adopted.reason).toBeInstanceOf(PersistenceConflictError);
      expect(adopted.reason.code).toBe("TERMINAL_STATE_CONFLICT");
    }
    const state = await snapshot(db);
    expect(state.receipts).toBe(1); expect(state.recovery.revision).toBe("3");
    expect(state.recovery.terminal_non_submission_disposition_ref).toBe("terminal-1");
    expect(state.pending).toMatchObject({ state: "RESOLVED",
      resolution_kind: "TERMINAL_NON_SUBMISSION", resolved_authority_ref: "terminal-1" });
    const adoptionReceipts = await db.observer.query<{ n: string }>(
      "SELECT count(*)::bigint AS n FROM orchestration_external_outcome_adoption", []);
    expect(adoptionReceipts.rows[0]?.n).toBe("0");
  }));
});
