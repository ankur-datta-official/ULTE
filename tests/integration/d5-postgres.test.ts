import { describe, expect, it } from "vitest";
import { PostgresOrchestrationCommitService, PostgresOrchestrationFencedWriterService,
  PostgresRecoveryBootLoader, type PostgresExecutor, type PostgresSnapshotExecutor,
  type PostgresTransaction } from "../../packages/orchestration-state-store-postgres/src/index.js";
import { B1fDatabase, bounded, deferred } from "./b1f-postgres-helper.js";
import { adoptionFixture, pendingFixture, seed } from "./b1f-postgres-fixture.js";

async function realTest(work: (db: B1fDatabase) => Promise<void>): Promise<void> {
  const db = await B1fDatabase.create(true);
  try { await db.proveConnections(); await work(db); }
  finally { await db.dispose(); }
}

type Boot = Awaited<ReturnType<PostgresRecoveryBootLoader["boot"]>>;
interface SnapshotFacts { recoveryRevision?: string; checkpointRef?: string;
  pendingStates?: string[]; idempotencyStatuses?: string[] }

/** The writer has performed its selected write but has not committed. B pins its snapshot
 * before A commits, then completes all other authority reads after that commit. */
async function race(db: B1fDatabase, marker: string,
  write: (executor: PostgresExecutor) => Promise<unknown>): Promise<{
    writer: unknown; before: Boot; after: Boot; facts: SnapshotFacts }> {
  const written = deferred(), releaseWriter = deferred();
  const readRecovery = deferred(), resumeReader = deferred();
  const facts: SnapshotFacts = {};
  const writerExecutor: PostgresExecutor = {
    query: (sql, params) => db.a.query(sql, params),
    transaction: (work) => db.a.transaction((tx) => work({
      query: async <Row>(sql: string, params: readonly unknown[]) => {
        const result = await tx.query<Row>(sql, params);
        if (sql.includes(marker)) {
          written.resolve();
          await bounded(releaseWriter.promise, "D5 release writer");
        }
        return result;
      },
    })),
  };
  const reader: PostgresSnapshotExecutor = {
    query: async () => { throw new Error("D5 boot queried outside snapshot"); },
    transaction: async () => { throw new Error("D5 boot opened writer transaction"); },
    snapshot: (work) => db.b.snapshot((tx) => work({
      query: async <Row>(sql: string, params: readonly unknown[]) => {
        const result = await tx.query<Row>(sql, params);
        if (sql.includes("orchestration-state-store-postgres:load")) {
          const row = result.rows[0] as Record<string, unknown> | undefined;
          facts.recoveryRevision = String(row?.["revision"]);
          facts.checkpointRef = String(row?.["execution_authority_checkpoint_ref"]);
          readRecovery.resolve();
          await bounded(resumeReader.promise, "D5 resume pinned boot");
        }
        if (sql.includes("effect:pending-list")) facts.pendingStates = result.rows.map((row) =>
          String((row as Record<string, unknown>)["state"]));
        if (sql.includes("execution-store-postgres:read")) facts.idempotencyStatuses = result.rows.map((row) =>
          String((row as Record<string, unknown>)["status"]));
        return result;
      },
    } as PostgresTransaction)),
  };
  const boot = (executor: PostgresSnapshotExecutor) => new PostgresRecoveryBootLoader(executor,
    db.target).boot("session-1" as never, "owner-1");
  const a = write(writerExecutor);
  let b: Promise<Boot> | undefined;
  try {
    await bounded(written.promise, `D5 writer ${marker}`);
    b = boot(reader);
    await bounded(readRecovery.promise, "D5 first snapshot read");
    expect(db.a.lastTransactionPid).toBeDefined();
    expect(db.b.lastTransactionPid).toBeDefined();
    expect(db.a.lastTransactionPid).not.toBe(db.b.lastTransactionPid);
    releaseWriter.resolve();
    const writer = await bounded(a, "D5 writer commit");
    resumeReader.resolve();
    const before = await bounded(b, "D5 pinned pre-commit boot");
    const after = await bounded(boot(db.b), "D5 fresh post-commit boot");
    return { writer, before, after, facts };
  } finally {
    releaseWriter.resolve(); resumeReader.resolve();
    await bounded(Promise.allSettled([a, ...(b ? [b] : [])]), "D5 race cleanup");
  }
}

describe.sequential("D5 real PostgreSQL final safety races", () => {
  it("boot never splits a pending commit from its checkpoint, recovery, and receipt", () =>
    realTest(async (db) => {
      const fixture = pendingFixture();
      await seed(db, fixture.previous, { leaseMs: 30000 });
      const result = await race(db, "receipt:pending-insert", (executor) =>
        new PostgresOrchestrationCommitService(executor).commitPendingIntent(fixture.request));
      expect(result.writer).toMatchObject({ status: "COMMITTED" });
      expect(result.before.status).toBe("READY");
      expect(result.after.status).toBe("INTENT_DISPOSITION_REQUIRED");
      expect(result.facts).toMatchObject({ recoveryRevision: "1", checkpointRef: "entry-before",
        pendingStates: [] });
      const durable = await db.observer.query<{ revision: string; checkpoint: string;
        pending: string; receipts: string }>(`SELECT r.revision, r.execution_authority_checkpoint_ref AS checkpoint,
        (SELECT count(*)::bigint FROM orchestration_pending_effect) AS pending,
        (SELECT count(*)::bigint FROM orchestration_pending_intent_commit) AS receipts
        FROM orchestration_recovery_state r WHERE r.session_id='session-1'`, []);
      expect(durable.rows[0]).toMatchObject({ revision: "2", checkpoint: "entry-after",
        pending: "1", receipts: "1" });
    }));

  it("boot sees either an available outcome or its complete adopted next-pending authority", () =>
    realTest(async (db) => {
      const fixture = adoptionFixture("fill-next");
      await seed(db, fixture.previous, { outcomes: [fixture.outcome], leaseMs: 30000 });
      const result = await race(db, "receipt:adoption-insert", (executor) =>
        new PostgresOrchestrationCommitService(executor).adoptOutcome(fixture.request));
      expect(result.writer).toMatchObject({ status: "ADOPTED" });
      expect(result.before.status).toBe("OUTCOME_AVAILABLE");
      expect(result.after.status).toBe("INTENT_DISPOSITION_REQUIRED");
      expect(result.facts).toMatchObject({ recoveryRevision: "1", checkpointRef: "fill-before",
        pendingStates: [] });
      const durable = await db.observer.query<{ revision: string; checkpoint: string;
        pending: string; receipts: string; outcomes: string }>(`SELECT r.revision,
        r.execution_authority_checkpoint_ref AS checkpoint,
        (SELECT count(*)::bigint FROM orchestration_pending_effect WHERE state='PENDING') AS pending,
        (SELECT count(*)::bigint FROM orchestration_external_outcome_adoption) AS receipts,
        (SELECT count(*)::bigint FROM orchestration_external_outcome) AS outcomes
        FROM orchestration_recovery_state r WHERE r.session_id='session-1'`, []);
      expect(durable.rows[0]).toMatchObject({ revision: "2", checkpoint: "adopt-fill-next",
        pending: "1", receipts: "1", outcomes: "1" });
    }));

  it("boot preserves ABSENT, CLAIMED, and may-have-started SUBMITTED across writer commits", () =>
    realTest(async (db) => {
      const fixture = pendingFixture();
      await seed(db, fixture.previous, { leaseMs: 30000 });
      expect((await new PostgresOrchestrationCommitService(db.a)
        .commitPendingIntent(fixture.request)).status).toBe("COMMITTED");
      const pending = fixture.request.pendingEffect;
      const identity = { adapterId: pending.adapterId, environment: pending.environment,
        operation: pending.operation, executionAttemptId: pending.executionAttemptId,
        idempotencyKey: pending.idempotencyKey, requestFingerprint: pending.requestFingerprint };
      const authority = { sessionId: pending.sessionId, ownerId: fixture.request.ownerId,
        expectedFence: fixture.request.expectedFence, expectedRecoveryRevision: pending.createdRevision,
        expectedCheckpointRef: fixture.request.committedCheckpoint.checkpointRef,
        pendingEffectIdentity: identity };
      const claimed = await race(db, "execution-store-postgres:claim-insert", (executor) =>
        new PostgresOrchestrationFencedWriterService(executor).claimPendingIdempotency({
          ...authority, claim: { ...identity, claimedAt: 100 as never } }));
      expect(claimed.writer).toMatchObject({ status: "PERSISTED" });
      expect(claimed.before.status).toBe("INTENT_DISPOSITION_REQUIRED");
      expect(claimed.after.status).toBe("INTENT_DISPOSITION_REQUIRED");
      expect(claimed.facts).toMatchObject({ recoveryRevision: "2", pendingStates: ["PENDING"],
        idempotencyStatuses: [] });
      const submitted = await race(db, "execution-store-postgres:outcome-update", (executor) =>
        new PostgresOrchestrationFencedWriterService(executor).recordPendingIdempotencyOutcome({
          ...authority, update: { adapterId: identity.adapterId, environment: identity.environment,
            idempotencyKey: identity.idempotencyKey, requestFingerprint: identity.requestFingerprint,
            status: "SUBMITTED", updatedAt: 101 as never } }));
      expect(submitted.writer).toMatchObject({ status: "PERSISTED" });
      expect(submitted.before.status).toBe("INTENT_DISPOSITION_REQUIRED");
      expect(submitted.after.status).toBe("RECONCILIATION_REQUIRED");
      expect(submitted.facts).toMatchObject({ recoveryRevision: "2", pendingStates: ["PENDING"],
        idempotencyStatuses: ["CLAIMED"] });
      const durable = await db.observer.query<{ revision: string; pending: string;
        broker: string }>(`SELECT r.revision,
        (SELECT count(*)::bigint FROM orchestration_pending_effect WHERE state='PENDING') AS pending,
        (SELECT status FROM broker_idempotency_records) AS broker
        FROM orchestration_recovery_state r WHERE r.session_id='session-1'`, []);
      expect(durable.rows[0]).toMatchObject({ revision: "2", pending: "1", broker: "SUBMITTED" });
    }));
});
