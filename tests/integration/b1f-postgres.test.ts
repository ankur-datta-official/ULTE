import { describe, expect, it } from "vitest";
import { createExternalOutcomeAdoptionReceipt,
  createPendingIntentCommitReceipt, proveOutcomeAdoptionCheckpointAdvance,
  provePendingIntentCheckpointAdvance, type AdoptOutcomeRequest,
  type CommitPendingIntentRequest } from "../../packages/orchestration-state-store/src/index.js";
import { PersistenceCorruptionError, PostgresOrchestrationCommitService,
  PostgresOrchestrationRecoveryLeaseStore, PostgresExecutionAuthorityCheckpointStore,
  appendPendingIntentCommitReceiptInTransaction, appendExternalOutcomeAdoptionReceiptInTransaction,
  createPendingEffectInTransaction } from "../../packages/orchestration-state-store-postgres/src/index.js";
import { B1fDatabase, LostCommitResponseError, bounded, deferred,
  type Marker, type RealPostgresExecutor } from "./b1f-postgres-helper.js";
import { adoptionFixture, cancellationFixture, pendingFixture, seed } from "./b1f-postgres-fixture.js";

type Workflow = "pending" | "adoption";
async function realTest(work: (db: B1fDatabase) => Promise<void>): Promise<void> {
  const db = await B1fDatabase.create();
  try { await db.proveConnections(); await work(db); }
  finally { await db.dispose(); }
}
async function count(db: B1fDatabase, table: string): Promise<number> {
  const allowed = ["orchestration_recovery_state", "orchestration_recovery_lease",
    "orchestration_pending_effect", "orchestration_external_outcome",
    "orchestration_execution_authority_checkpoint", "orchestration_pending_intent_commit",
    "orchestration_external_outcome_adoption"];
  if (!allowed.includes(table)) throw new Error("Unapproved B1F table");
  const result = await db.observer.query<{ n: string }>(`SELECT count(*)::bigint AS n FROM ${table}`, []);
  return Number(result.rows[0]!.n);
}
async function recovery(db: B1fDatabase) {
  const result = await db.observer.query<{ revision: string; fence_token: string;
    execution_authority_checkpoint_ref: string }>(
    "SELECT revision,fence_token,execution_authority_checkpoint_ref FROM orchestration_recovery_state WHERE session_id='session-1'", []);
  return result.rows[0]!;
}
async function lease(db: B1fDatabase) {
  const result = await db.observer.query<{ owner_id: string; fence_token: string; expires_at_ms: string }>(
    "SELECT owner_id,fence_token,expires_at_ms FROM orchestration_recovery_lease WHERE session_id='session-1'", []);
  return result.rows[0]!;
}
async function assertDurable(db: B1fDatabase, kind: Workflow, revision: number,
  checkpointCount: number, pendingCount: number): Promise<void> {
  expect(Number((await recovery(db)).revision)).toBe(revision);
  expect(await count(db, "orchestration_execution_authority_checkpoint")).toBe(checkpointCount);
  expect(await count(db, "orchestration_pending_effect")).toBe(pendingCount);
  expect(await count(db, "orchestration_pending_intent_commit")).toBe(kind === "pending" && revision > 1 ? 1 : 0);
  expect(await count(db, "orchestration_external_outcome_adoption")).toBe(kind === "adoption" && revision > 1 ? 1 : 0);
}

async function blockedBy(db: B1fDatabase, a: RealPostgresExecutor, b: RealPostgresExecutor,
  bResult: Promise<unknown>): Promise<void> {
  await bounded((async () => { while (b.lastTransactionPid === undefined)
    await new Promise((r) => setTimeout(r, 5)); })(), "B physical transaction PID");
  const aPid = a.lastTransactionPid!, bPid = b.lastTransactionPid!;
  expect(aPid).toBeDefined(); expect(bPid).toBeDefined(); expect(aPid).not.toBe(bPid);
  if (db.introspection) await db.blocking(bPid, aPid);
  else {
    // B started its SQL query and stays unsettled for this bounded observation window.
    const result = await Promise.race([bResult.then(() => "settled", () => "settled"),
      new Promise<"blocked">((resolve) => setTimeout(() => resolve("blocked"), 150))]);
    expect(result).toBe("blocked");
  }
}

async function workflowRace(db: B1fDatabase, kind: Workflow,
  aRequest: CommitPendingIntentRequest | AdoptOutcomeRequest,
  bRequest: CommitPendingIntentRequest | AdoptOutcomeRequest = aRequest,
  bKind: Workflow = kind) {
  const load: Marker = kind === "pending" ? "receipt:pending-load" : "receipt:adoption-load";
  const bLoad: Marker = bKind === "pending" ? "receipt:pending-load" : "receipt:adoption-load";
  const insert: Marker = kind === "pending" ? "receipt:pending-insert" : "receipt:adoption-insert";
  const aLeaseGate = deferred(), bLeaseGate = deferred(), bRead = deferred(), aInserted = deferred();
  const aRelease = deferred(), bLockStarted = deferred();
  let aLoads = 0, bLoads = 0;
  db.a.afterQuery = async (marker) => {
    if (marker === load) aLoads++;
    if (marker === insert) { aInserted.resolve(); await aRelease.promise; }
  };
  db.a.beforeQuery = async (marker) => {
    if (marker === "orchestration-state-store-postgres:lease-lock") await aLeaseGate.promise;
  };
  db.b.afterQuery = (marker) => { if (marker === bLoad) { bLoads++; bRead.resolve(); } };
  db.b.beforeQuery = async (marker) => {
    if (marker === "orchestration-state-store-postgres:lease-lock") {
      bLockStarted.resolve(); await bLeaseGate.promise;
    }
  };
  const aService = new PostgresOrchestrationCommitService(db.a);
  const bService = new PostgresOrchestrationCommitService(db.b);
  const run = (service: PostgresOrchestrationCommitService,
    request: CommitPendingIntentRequest | AdoptOutcomeRequest, operation: Workflow) => operation === "pending"
    ? service.commitPendingIntent(request as CommitPendingIntentRequest)
    : service.adoptOutcome(request as AdoptOutcomeRequest);
  const a = run(aService, aRequest, kind);
  let b: Promise<{ status: string }> | undefined;
  try {
    // A's first receipt read completed, but its lease query has not run.
    await bounded((async () => { while (aLoads === 0) await new Promise((r) => setTimeout(r, 5)); })(), "A first receipt read");
    b = run(bService, bRequest, bKind);
    try {
      await bounded(bRead.promise, "B first receipt read");
      expect(aLoads).toBe(1); expect(bLoads).toBe(1);
      aLeaseGate.resolve();
      await bounded(aInserted.promise, "A inserted receipt");
      await bounded(bLockStarted.promise, "B lease query started");
      bLeaseGate.resolve();
      await blockedBy(db, db.a, db.b, b);
      aRelease.resolve();
      return [await bounded<{ status: string }>(a, "A transaction"),
        await bounded<{ status: string }>(b, "B transaction")] as const;
    } finally { bLeaseGate.resolve(); aRelease.resolve(); }
  } finally {
    aLeaseGate.resolve(); bLeaseGate.resolve(); aRelease.resolve();
    await bounded(Promise.allSettled([a, ...(b ? [b] : [])]), "race worker cleanup");
    db.a.beforeQuery = undefined; db.a.afterQuery = undefined;
    db.b.beforeQuery = undefined; db.b.afterQuery = undefined;
  }
}

async function takeover(db: B1fDatabase, expiresAt: number) {
  await db.untilDbTime(expiresAt);
  const result = await new PostgresOrchestrationRecoveryLeaseStore(db.b).acquireRecoveryLease({
    sessionId: "session-1" as never, ownerId: "owner-2" as never, leaseDurationMs: 5000 as never });
  expect(result.status).toBe("ACQUIRED");
  expect(Number((await lease(db)).fence_token)).toBe(4);
  expect(Number((await recovery(db)).fence_token)).toBe(4);
  return result;
}

async function expiryRollback(db: B1fDatabase, kind: Workflow,
  request: CommitPendingIntentRequest | AdoptOutcomeRequest, expiresAt: number) {
  const insert: Marker = kind === "pending" ? "receipt:pending-insert" : "receipt:adoption-insert";
  const inserted = deferred(), release = deferred();
  db.a.afterQuery = async (marker) => { if (marker === insert) { inserted.resolve(); await release.promise; } };
  const service = new PostgresOrchestrationCommitService(db.a);
  const operation = kind === "pending"
    ? service.commitPendingIntent(request as CommitPendingIntentRequest)
    : service.adoptOutcome(request as AdoptOutcomeRequest);
  try {
    await bounded(inserted.promise, `${kind} receipt insert`);
    await db.untilDbTime(expiresAt);
    release.resolve();
    expect((await bounded<{ status: string }>(operation, `${kind} final lease`)).status).toBe("LEASE_LOST");
  } finally {
    release.resolve();
    await bounded(Promise.allSettled([operation]), `${kind} rollback worker cleanup`);
    db.a.afterQuery = undefined;
  }
  await assertDurable(db, kind, 1, 1, kind === "adoption" && (request as AdoptOutcomeRequest).outcomeKey !== "outcome-fill-next" ? 1 : 0);
}

describe.sequential("B1F real PostgreSQL concurrency and recovery", () => {
  it("P1 concurrent duplicate pending commit serializes on lease and retries historically", () => realTest(async (db) => {
    const f = pendingFixture(); await seed(db, f.previous);
    const [a, b] = await workflowRace(db, "pending", f.request);
    expect(a.status).toBe("COMMITTED");
    expect(b).toMatchObject({ status: "REVISION_CONFLICT", currentRevision: 2 });
    await assertDurable(db, "pending", 2, 2, 1);
    expect((await new PostgresOrchestrationCommitService(db.b).commitPendingIntent(f.request)).status).toBe("ALREADY_COMMITTED");
    expect(await count(db, "orchestration_pending_effect")).toBe(1);
  }));

  it("P2 real committed pending intent with lost response is durable and retriable after takeover", () => realTest(async (db) => {
    const f = pendingFixture(), expiry = await seed(db, f.previous, { leaseMs: 4000 });
    db.a.loseNextCommitResponse = true;
    await expect(new PostgresOrchestrationCommitService(db.a).commitPendingIntent(f.request))
      .rejects.toBeInstanceOf(LostCommitResponseError);
    await assertDurable(db, "pending", 2, 2, 1);
    await takeover(db, expiry);
    const retry = await new PostgresOrchestrationCommitService(db.b).commitPendingIntent(f.request);
    expect(retry.status).toBe("ALREADY_COMMITTED");
    const row = await db.observer.query<{ committed_fence: string }>(
      "SELECT committed_fence FROM orchestration_pending_intent_commit", []);
    expect(Number(row.rows[0]!.committed_fence)).toBe(3);
  }));

  it("P3 stale fence rejects a fresh commit while new owner can commit", () => realTest(async (db) => {
    const f = pendingFixture(), expiry = await seed(db, f.previous, { leaseMs: 4000 });
    await takeover(db, expiry);
    expect((await new PostgresOrchestrationCommitService(db.a).commitPendingIntent(f.request)).status).toBe("LEASE_LOST");
    await assertDurable(db, "pending", 1, 1, 0);
    const current = { ...f.request, ownerId: "owner-2" as typeof f.request.ownerId,
      expectedFence: 4 as typeof f.request.expectedFence,
      pendingEffect: { ...f.request.pendingEffect, createdFence: 4 as typeof f.request.pendingEffect.createdFence } };
    expect((await new PostgresOrchestrationCommitService(db.b).commitPendingIntent(current)).status).toBe("COMMITTED");
    await assertDurable(db, "pending", 2, 2, 1);
  }));

  it("P4 final lease expiry rolls back pending transaction after all writes", () => realTest(async (db) => {
    const f = pendingFixture(), expiry = await seed(db, f.previous, { leaseMs: 4000 });
    await expiryRollback(db, "pending", f.request, expiry);
    expect((await recovery(db)).execution_authority_checkpoint_ref).toBe(f.previous.checkpointRef);
  }));

  it("A1 concurrent duplicate adoption serializes and retries historically", () => realTest(async (db) => {
    const f = adoptionFixture(); await seed(db, f.previous, { linked: f.linked, outcomes: [f.outcome] });
    const [a, b] = await workflowRace(db, "adoption", f.request);
    expect(a.status).toBe("ADOPTED");
    expect(b).toMatchObject({ status: "REVISION_CONFLICT", currentRevision: 2 });
    await assertDurable(db, "adoption", 2, 2, 1);
    const linked = await db.observer.query<{ state: string; resolved_outcome_key: string }>(
      "SELECT state,resolved_outcome_key FROM orchestration_pending_effect", []);
    expect(linked.rows[0]).toMatchObject({ state: "RESOLVED", resolved_outcome_key: f.outcome.outcomeKey });
    expect((await new PostgresOrchestrationCommitService(db.b).adoptOutcome(f.request)).status).toBe("ALREADY_ADOPTED");
  }));

  it("A2 real committed adoption with lost response is durable and retriable after takeover", () => realTest(async (db) => {
    const f = adoptionFixture(), expiry = await seed(db, f.previous,
      { linked: f.linked, outcomes: [f.outcome], leaseMs: 4000 });
    db.a.loseNextCommitResponse = true;
    await expect(new PostgresOrchestrationCommitService(db.a).adoptOutcome(f.request))
      .rejects.toBeInstanceOf(LostCommitResponseError);
    await assertDurable(db, "adoption", 2, 2, 1);
    expect((await db.observer.query<{ state: string }>(
      "SELECT state FROM orchestration_pending_effect", [])).rows[0]?.state).toBe("RESOLVED");
    await takeover(db, expiry);
    expect((await new PostgresOrchestrationCommitService(db.b).adoptOutcome(f.request)).status).toBe("ALREADY_ADOPTED");
    expect(Number((await db.observer.query<{ adopted_fence: string }>(
      "SELECT adopted_fence FROM orchestration_external_outcome_adoption", [])).rows[0]!.adopted_fence)).toBe(3);
  }));

  it("A3 competing linked outcomes cannot adopt the resolved pending effect", () => realTest(async (db) => {
    const a = adoptionFixture("ack"), b = adoptionFixture("rejection");
    expect(a.previous.checkpointRef).toBe(b.previous.checkpointRef);
    expect(a.previous.evidence).toEqual(b.previous.evidence);
    expect(a.outcome.outcomeKey).not.toBe(b.outcome.outcomeKey);
    expect(a.outcome.pendingEffectIdentity).toEqual(b.outcome.pendingEffectIdentity);
    await seed(db, a.previous, { linked: a.linked, outcomes: [a.outcome, b.outcome] });
    const [winner, stale] = await workflowRace(db, "adoption", a.request, b.request);
    expect(winner.status).toBe("ADOPTED");
    expect(stale).toMatchObject({ status: "REVISION_CONFLICT", currentRevision: 2 });
    await assertDurable(db, "adoption", 2, 2, 1);
    expect((await db.observer.query<{ resolved_outcome_key: string }>(
      "SELECT resolved_outcome_key FROM orchestration_pending_effect", [])).rows[0]!.resolved_outcome_key)
      .toBe(a.outcome.outcomeKey);
    const later: AdoptOutcomeRequest = { ...b.request, expectedRevision: 2 as never,
      previousCheckpointRef: a.request.committedCheckpoint.checkpointRef };
    await expect(new PostgresOrchestrationCommitService(db.b).adoptOutcome(later))
      .rejects.toBeInstanceOf(PersistenceCorruptionError);
    expect(await count(db, "orchestration_external_outcome_adoption")).toBe(1);
  }));

  it("A4 next-pending adoption race creates exactly one nested pending without a pending receipt", () => realTest(async (db) => {
    const f = adoptionFixture("fill-next"); await seed(db, f.previous, { outcomes: [f.outcome] });
    const [a, b] = await workflowRace(db, "adoption", f.request);
    expect(a.status).toBe("ADOPTED");
    expect(b).toMatchObject({ status: "REVISION_CONFLICT", currentRevision: 2 });
    await assertDurable(db, "adoption", 2, 2, 1);
    expect(await count(db, "orchestration_pending_intent_commit")).toBe(0);
    expect((await new PostgresOrchestrationCommitService(db.b).adoptOutcome(f.request)).status).toBe("ALREADY_ADOPTED");
  }));

  it("A5 final lease expiry rolls back adoption checkpoint, next pending and receipt", () => realTest(async (db) => {
    const f = adoptionFixture("fill-next"), expiry = await seed(db, f.previous,
      { outcomes: [f.outcome], leaseMs: 4000 });
    await expiryRollback(db, "adoption", f.request, expiry);
  }));

  it("L1 lease takeover waits for both commit and rollback of a held row lock", () => realTest(async (db) => {
    const f = pendingFixture(); await seed(db, f.previous, { leaseMs: 7000 });
    for (const finish of ["COMMIT", "ROLLBACK"] as const) {
      const locked = deferred(), release = deferred(), bLeaseQueryStarted = deferred();
      const a = db.a.transaction(async (tx) => {
        await tx.query("SELECT session_id FROM orchestration_recovery_lease WHERE session_id='session-1' FOR UPDATE", []);
        locked.resolve(); await release.promise;
        if (finish === "ROLLBACK") throw new Error("controlled rollback");
      });
      await bounded(locked.promise, "A lease lock");
      db.b.beforeQuery = (marker) => {
        if (marker === "orchestration-state-store-postgres:lease-lock") bLeaseQueryStarted.resolve();
      };
      const b = new PostgresOrchestrationRecoveryLeaseStore(db.b).acquireRecoveryLease({
        sessionId: "session-1" as never, ownerId: "owner-2" as never, leaseDurationMs: 3000 as never });
      try {
        await bounded(bLeaseQueryStarted.promise, "B lease query started");
        await blockedBy(db, db.a, db.b, b);
      }
      finally {
        release.resolve();
        try { await bounded(Promise.allSettled([a, b]), "lease worker cleanup"); }
        finally { db.b.beforeQuery = undefined; }
      }
      if (finish === "ROLLBACK") await expect(a).rejects.toThrow("controlled rollback");
      else await a;
      expect((await b).status).toBe("HELD_BY_OTHER");
    }
    await takeover(db, Number((await lease(db)).expires_at_ms));
  }));

  it("L2 takeover synchronizes lease and recovery fences without revision advance", () => realTest(async (db) => {
    const f = pendingFixture(), expiry = await seed(db, f.previous, { leaseMs: 1200 });
    await takeover(db, expiry);
    expect(Number((await recovery(db)).revision)).toBe(1);
  }));

  it("L3 old owner loses both fresh mutation paths and current owner can proceed", async () => {
    for (const kind of ["pending", "adoption"] as const) {
      await realTest(async (db) => {
        const f = kind === "pending" ? pendingFixture() : adoptionFixture();
        const adoption = f as ReturnType<typeof adoptionFixture>;
        const expiry = kind === "pending" ? await seed(db, f.previous, { leaseMs: 1200 })
          : await seed(db, f.previous, { linked: adoption.linked,
            outcomes: [adoption.outcome], leaseMs: 1200 });
        await takeover(db, expiry);
        const serviceA = new PostgresOrchestrationCommitService(db.a);
        const serviceB = new PostgresOrchestrationCommitService(db.b);
        if (kind === "pending") {
          const request = f.request as CommitPendingIntentRequest;
          expect((await serviceA.commitPendingIntent(request)).status).toBe("LEASE_LOST");
          await assertDurable(db, kind, 1, 1, 0);
          const current = { ...request, ownerId: "owner-2" as typeof request.ownerId,
            expectedFence: 4 as typeof request.expectedFence,
            pendingEffect: { ...request.pendingEffect, createdFence: 4 as typeof request.pendingEffect.createdFence } };
          expect((await serviceB.commitPendingIntent(current)).status).toBe("COMMITTED");
          await assertDurable(db, kind, 2, 2, 1);
        } else {
          const request = f.request as AdoptOutcomeRequest;
          expect((await serviceA.adoptOutcome(request)).status).toBe("LEASE_LOST");
          await assertDurable(db, kind, 1, 1, 1);
          const current = { ...request, ownerId: "owner-2" as typeof request.ownerId,
            expectedFence: 4 as typeof request.expectedFence };
          expect((await serviceB.adoptOutcome(current)).status).toBe("ADOPTED");
          await assertDurable(db, kind, 2, 2, 1);
        }
      });
    }
  });

  it("X1 commit and adoption share lease lock order without deadlock", () => realTest(async (db) => {
    const commit = cancellationFixture(), adoption = adoptionFixture("fill-next");
    expect(commit.previous.checkpointRef).toBe(adoption.previous.checkpointRef);
    await seed(db, commit.previous, { outcomes: [adoption.outcome] });
    const [winner, loser] = await workflowRace(db, "pending", commit.request, adoption.request, "adoption");
    expect(winner.status).toBe("COMMITTED");
    expect(loser).toMatchObject({ status: "REVISION_CONFLICT", currentRevision: 2 });
    await assertDurable(db, "pending", 2, 2, 1);
    expect(await count(db, "orchestration_external_outcome_adoption")).toBe(0);
  }));

  it("X2 controlled PostgreSQL receipt errors roll back every earlier workflow write", async () => {
    for (const kind of ["pending", "adoption"] as const) {
      await realTest(async (db) => {
        const f = kind === "pending" ? pendingFixture() : adoptionFixture("ack");
        if (kind === "pending") await seed(db, f.previous);
        else {
          const adoption = f as ReturnType<typeof adoptionFixture>;
          await seed(db, adoption.previous, { linked: adoption.linked, outcomes: [adoption.outcome] });
        }
        const table = kind === "pending" ? "orchestration_pending_intent_commit"
          : "orchestration_external_outcome_adoption";
        await db.observer.query(`CREATE FUNCTION b1f_fail_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
          BEGIN RAISE EXCEPTION 'b1f controlled receipt failure'; END; $$`, []);
        await db.observer.query(`CREATE TRIGGER b1f_fail_receipt_before_insert
          BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION b1f_fail_receipt()`, []);
        const service = new PostgresOrchestrationCommitService(db.a);
        if (kind === "pending") await expect(service.commitPendingIntent(f.request as CommitPendingIntentRequest)).rejects.toThrow();
        else await expect(service.adoptOutcome(f.request as AdoptOutcomeRequest)).rejects.toThrow();
        await assertDurable(db, kind, 1, 1, kind === "pending" ? 0 : 1);
        expect((await recovery(db)).execution_authority_checkpoint_ref).toBe(f.previous.checkpointRef);
        if (kind === "adoption") {
          expect((await db.observer.query<{ state: string }>(
            "SELECT state FROM orchestration_pending_effect", [])).rows[0]?.state).toBe("PENDING");
        }
      });
    }
  });

  it("X3 competing receipt inserts serialize on real unique indexes with immutable first payload", async () => {
    for (const kind of ["pending", "adoption"] as const) {
      for (const conflict of [false, true]) {
        await realTest(async (db) => {
          const f = kind === "pending" ? pendingFixture() : adoptionFixture("ack");
          const pending = f as ReturnType<typeof pendingFixture>;
          const adoption = f as ReturnType<typeof adoptionFixture>;
          if (kind === "pending") await seed(db, f.previous);
          else await seed(db, f.previous, { linked: adoption.linked, outcomes: [adoption.outcome] });
          const checkpointStore = new PostgresExecutionAuthorityCheckpointStore(db.observer);
          expect((await checkpointStore.appendExecutionAuthorityCheckpoint(f.request.committedCheckpoint)).status)
            .toBe("APPENDED");
          if (kind === "pending") {
            expect((await db.observer.transaction((tx) => createPendingEffectInTransaction(tx,
              pending.request.pendingEffect))).status).toBe("CREATED");
          }
          const proof = kind === "pending"
            ? provePendingIntentCheckpointAdvance({ previousCheckpoint: f.previous,
              committedCheckpoint: f.request.committedCheckpoint, pendingEffect: pending.request.pendingEffect })
            : proveOutcomeAdoptionCheckpointAdvance({ previousCheckpoint: f.previous,
              committedCheckpoint: f.request.committedCheckpoint, outcome: adoption.outcome, nextPendingEffect: null });
          if (kind === "adoption" && (proof as { status: string }).status !== "PROVEN")
            throw new Error("Invalid adoption receipt fixture");
          const first = kind === "pending" ? createPendingIntentCommitReceipt({
            schemaVersion: "ORCHESTRATION_PENDING_INTENT_COMMIT_RECEIPT_V1",
            sessionId: f.request.sessionId, expectedRevision: 1, committedRevision: 2, committedFence: 3,
            committingOwnerId: "owner-1", previousCheckpointRef: f.previous.checkpointRef,
            committedCheckpointRef: f.request.committedCheckpoint.checkpointRef,
            resultingRecoveryState: f.request.resultingRecoveryState,
            pendingEffect: pending.request.pendingEffect, advanceProof: proof,
          }, f.previous, f.request.committedCheckpoint) : createExternalOutcomeAdoptionReceipt({
            schemaVersion: "ORCHESTRATION_EXTERNAL_OUTCOME_ADOPTION_RECEIPT_V1",
            outcomeKey: adoption.outcome.outcomeKey, sessionId: f.request.sessionId,
            executionAttemptId: adoption.outcome.executionAttemptId, expectedRevision: 1,
            adoptedRevision: 2, adoptedFence: 3, adoptingOwnerId: "owner-1",
            previousCheckpointRef: f.previous.checkpointRef,
            committedCheckpointRef: f.request.committedCheckpoint.checkpointRef,
            resultingRecoveryState: f.request.resultingRecoveryState,
            linkedPendingResolution: { pendingEffectIdentity: adoption.outcome.pendingEffectIdentity,
              outcomeKey: adoption.outcome.outcomeKey, resolvedRevision: 2, resolvedFence: 3 },
            nextPendingEffect: null, nextPendingCommit: null,
            advanceProof: (proof as { proof: unknown }).proof,
          }, f.previous, f.request.committedCheckpoint, adoption.outcome);
          const second = conflict ? { ...first,
            ...(kind === "pending" ? { committingOwnerId: "owner-2" } : { adoptingOwnerId: "owner-2" }) } : first;
          const inserted = deferred(), release = deferred(), bStarted = deferred();
          const marker: Marker = kind === "pending" ? "receipt:pending-insert" : "receipt:adoption-insert";
          db.a.afterQuery = async (value) => { if (value === marker) { inserted.resolve(); await release.promise; } };
          db.b.beforeQuery = (value) => { if (value === marker) bStarted.resolve(); };
          const append = (executor: RealPostgresExecutor, receipt: unknown): Promise<{ status: string }> =>
            executor.transaction(async (tx) => kind === "pending"
              ? { status: (await appendPendingIntentCommitReceiptInTransaction(tx, receipt as never)).status }
              : { status: (await appendExternalOutcomeAdoptionReceiptInTransaction(tx, receipt as never)).status });
          const a = append(db.a, first);
          let b: Promise<{ status: string }> | undefined;
          try {
            await bounded(inserted.promise, "first receipt insert");
            b = append(db.b, second);
            await bounded(bStarted.promise, "competing receipt insert");
            await blockedBy(db, db.a, db.b, b);
            release.resolve();
            expect((await a).status).toBe("APPENDED");
            expect((await b).status).toBe(conflict ? "RECEIPT_CONFLICT" : "DUPLICATE_SAME");
          } finally {
            release.resolve();
            await bounded(Promise.allSettled([a, ...(b ? [b] : [])]), "receipt race worker cleanup");
            db.a.afterQuery = undefined; db.b.beforeQuery = undefined;
          }
          const table = kind === "pending" ? "orchestration_pending_intent_commit"
            : "orchestration_external_outcome_adoption";
          expect(await count(db, table)).toBe(1);
          const owner = kind === "pending" ? "committing_owner_id" : "adopting_owner_id";
          expect((await db.observer.query<{ owner: string }>(
            `SELECT ${owner} AS owner FROM ${table}`, [])).rows[0]?.owner).toBe("owner-1");
        });
      }
    }
  });
});
