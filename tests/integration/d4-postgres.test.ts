import { describe, expect, it } from "vitest";
import { createOrchestrationExternalOutcome, createTerminalNonSubmissionDispositionV1 } from
  "../../packages/orchestration-state-store/src/index.js";
import { PostgresOrchestrationCommitService, PostgresOrchestrationEffectStore,
  PostgresRecoveryBootLoader, PostgresTerminalNonSubmissionCommitService,
  type NormalTerminalNonSubmissionRequest, type PostgresSnapshotExecutor, type PostgresTransaction } from
  "../../packages/orchestration-state-store-postgres/src/index.js";
import { B1fDatabase, bounded, deferred } from "./b1f-postgres-helper.js";
import { pendingFixture, seed } from "./b1f-postgres-fixture.js";

async function realTest(work: (db: B1fDatabase) => Promise<void>): Promise<void> {
  const db = await B1fDatabase.create(true);
  try { await db.proveConnections(); await work(db); }
  finally { await db.dispose(); }
}

async function prepared(db: B1fDatabase, status: "SUBMITTED" | "FAILED_NOT_SUBMITTED") {
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
  const request: NormalTerminalNonSubmissionRequest = {
    ownerId: fixture.request.ownerId, expectedFence: fixture.request.expectedFence,
    brokerStatusUpdatedAt: 103 as never,
    disposition: { ...rest, proof: { ...rest.proof, sourceKind: "TRUSTED_ADAPTER_FAILURE" },
      resolution: { kind: resolution.kind, resolvedRevision: resolution.resolvedRevision } },
  };
  return request;
}

function boot(db: B1fDatabase, executor: PostgresSnapshotExecutor = db.b) {
  return new PostgresRecoveryBootLoader(executor, db.target).boot("session-1" as never, "owner-1");
}
function service(db: B1fDatabase) { return new PostgresTerminalNonSubmissionCommitService(db.a, db.target); }

interface TupleFacts {
  recoveryRef?: unknown;
  recoveryRevision?: unknown;
  pendingStates?: unknown[];
  terminalPendingStates?: unknown[];
  brokerStatuses?: unknown[];
  receiptRows?: number;
  checkpointRows?: number;
  outcomeRows?: number;
}
function capture(sql: string, rows: readonly unknown[], facts: TupleFacts): void {
  const first = rows[0] as Record<string, unknown> | undefined;
  if (sql.includes("orchestration-state-store-postgres:load")) {
    facts.recoveryRef = first?.["terminal_non_submission_disposition_ref"];
    facts.recoveryRevision = first?.["revision"];
  }
  if (sql.includes("effect:pending-list")) facts.pendingStates = rows.map((row) =>
    (row as Record<string, unknown>)["state"]);
  if (sql.includes("effect:terminal-pending-list")) facts.terminalPendingStates = rows.map((row) =>
    (row as Record<string, unknown>)["state"]);
  if (sql.includes("execution-store-postgres:read")) facts.brokerStatuses = rows.map((row) =>
    (row as Record<string, unknown>)["status"]);
  if (sql.includes("receipt:terminal-session-load")) facts.receiptRows = rows.length;
  if (sql.includes("checkpoint:load")) facts.checkpointRows = rows.length;
  if (sql.includes("effect:outcome-list")) facts.outcomeRows = rows.length;
}

describe.sequential("D4 real PostgreSQL coherent terminal boot", () => {
  it("boots a D3N closed tuple as stopped terminal authority", () => realTest(async (db) => {
    const request = await prepared(db, "SUBMITTED");
    expect((await service(db).commitNormalTerminalNonSubmissionDisposition(request)).status).toBe("COMMITTED");
    const result = await boot(db);
    expect(result).toMatchObject({ status: "TERMINAL_NON_SUBMISSION",
      dispositionRef: "terminal-1", sessionDisposition: "TERMINAL_NON_SUBMISSION" });
    expect(result.status).not.toBe("READY");
  }));

  it("boots a historical D3 closed tuple as stopped terminal authority", () => realTest(async (db) => {
    const request = await prepared(db, "FAILED_NOT_SUBMITTED");
    expect((await service(db).commitTerminalNonSubmissionDisposition(request)).status).toBe("COMMITTED");
    expect(await boot(db)).toMatchObject({ status: "TERMINAL_NON_SUBMISSION",
      dispositionRef: "terminal-1" });
  }));

  it("rejects bare historical failure and pending without inventing proof or required state", () =>
    realTest(async (db) => {
      await prepared(db, "FAILED_NOT_SUBMITTED");
      const result = await boot(db);
      expect(result).toMatchObject({ status: "RECOVERY_REJECTED",
        reason: "TERMINAL_NON_SUBMISSION_PROOF_UNAVAILABLE" });
      expect(result.status).not.toBe("TERMINAL_NON_SUBMISSION_REQUIRED");
      expect(result.status).not.toBe("INTENT_DISPOSITION_REQUIRED");
      expect(result.status).not.toBe("READY");
    }));

  it("rejects orphan terminal resolution before READY", () => realTest(async (db) => {
    await prepared(db, "FAILED_NOT_SUBMITTED");
    await db.observer.query(`UPDATE orchestration_pending_effect
      SET schema_version='ORCHESTRATION_PENDING_EFFECT_V2', state='RESOLVED',
        resolution_kind='TERMINAL_NON_SUBMISSION', resolved_authority_ref='orphan-terminal',
        resolved_revision=3, resolved_fence=3 WHERE session_id='session-1'`, []);
    const result = await boot(db);
    expect(result).toMatchObject({ status: "RECOVERY_REJECTED",
      reason: "PERSISTENCE_CORRUPTION" });
    expect(result.status).not.toBe("READY");
  }));

  it("rejects a partial terminal tuple with unresolved linked pending", () => realTest(async (db) => {
    const request = await prepared(db, "SUBMITTED");
    await service(db).commitNormalTerminalNonSubmissionDisposition(request);
    await db.observer.query(`UPDATE orchestration_pending_effect
      SET schema_version='ORCHESTRATION_PENDING_EFFECT_V1', state='PENDING',
        resolution_kind=NULL, resolved_authority_ref=NULL, resolved_revision=NULL, resolved_fence=NULL
      WHERE session_id='session-1'`, []);
    expect(await boot(db)).toMatchObject({ status: "RECOVERY_REJECTED",
      reason: "PERSISTENCE_CORRUPTION" });
  }));

  it("rejects a contradictory broker row supplied to the pinned snapshot", () => realTest(async (db) => {
    const request = await prepared(db, "SUBMITTED");
    await service(db).commitNormalTerminalNonSubmissionDisposition(request);
    const contradictory: PostgresSnapshotExecutor = {
      query: async () => { throw new Error("outside query"); },
      transaction: async () => { throw new Error("writer transaction"); },
      snapshot: (work) => db.b.snapshot((tx) => work({ query: async <Row>(sql: string,
        params: readonly unknown[]) => {
        const result = await tx.query<Row>(sql, params);
        return sql.includes("execution-store-postgres:read")
          ? { rows: result.rows.map((row) => ({ ...row, status: "CONFIRMED" })) as Row[],
            rowCount: result.rowCount } : result;
      } } as PostgresTransaction)),
    };
    expect(await boot(db, contradictory)).toMatchObject({ status: "RECOVERY_REJECTED",
      reason: "PERSISTENCE_CORRUPTION" });
  }));

  it("rejects a terminal ref whose immutable receipt is unavailable", () => realTest(async (db) => {
    const request = await prepared(db, "SUBMITTED");
    await service(db).commitNormalTerminalNonSubmissionDisposition(request);
    const missingReceipt: PostgresSnapshotExecutor = {
      query: async () => { throw new Error("outside query"); },
      transaction: async () => { throw new Error("writer transaction"); },
      snapshot: (work) => db.b.snapshot((tx) => work({ query: async <Row>(sql: string,
        params: readonly unknown[]) => {
        const result = await tx.query<Row>(sql, params);
        return sql.includes("receipt:terminal-session-load") || sql.includes("receipt:terminal-ref-load")
          ? { rows: [] as Row[], rowCount: 0 } : result;
      } } as PostgresTransaction)),
    };
    expect(await boot(db, missingReceipt)).toMatchObject({ status: "RECOVERY_REJECTED",
      reason: "PERSISTENCE_CORRUPTION" });
  }));

  it("returns typed rejection for malformed recovery V2 row", () => realTest(async (db) => {
    const request = await prepared(db, "SUBMITTED");
    await service(db).commitNormalTerminalNonSubmissionDisposition(request);
    const malformed: PostgresSnapshotExecutor = {
      query: async () => { throw new Error("outside query"); },
      transaction: async () => { throw new Error("writer transaction"); },
      snapshot: (work) => db.b.snapshot((tx) => work({ query: async <Row>(sql: string,
        params: readonly unknown[]) => {
        const result = await tx.query<Row>(sql, params);
        return sql.includes("orchestration-state-store-postgres:load")
          ? { rows: result.rows.map((row) => ({ ...row,
            terminal_non_submission_disposition_ref: null })) as Row[], rowCount: result.rowCount } : result;
      } } as PostgresTransaction)),
    };
    expect(await boot(db, malformed)).toMatchObject({ status: "RECOVERY_REJECTED",
      reason: "PERSISTENCE_CORRUPTION" });
  }));

  it("rejects a contradictory external outcome linked to terminal pending", () => realTest(async (db) => {
    const request = await prepared(db, "SUBMITTED");
    await service(db).commitNormalTerminalNonSubmissionDisposition(request);
    const outcome = createOrchestrationExternalOutcome({ schemaVersion: "ORCHESTRATION_EXTERNAL_OUTCOME_V1",
      outcomeKey: "contradiction-1", sessionId: request.disposition.sessionId,
      executionAttemptId: request.disposition.executionAttemptId, observedAt: 104, observedFence: 3,
      pendingEffectIdentity: request.disposition.pendingEffectIdentity,
      observation: { kind: "BROKER_DISPOSITION", disposition: { status: "CONFIRMED_REJECTED" } } });
    expect((await new PostgresOrchestrationEffectStore(db.observer).appendOutcome(outcome)).status).toBe("APPENDED");
    expect(await boot(db)).toMatchObject({ status: "RECOVERY_REJECTED",
      reason: "PERSISTENCE_CORRUPTION" });
  }));

  it("keeps terminal across fresh snapshots without broker or provider I/O", () => realTest(async (db) => {
    const request = await prepared(db, "SUBMITTED");
    await service(db).commitNormalTerminalNonSubmissionDisposition(request);
    const snapshotOnly: PostgresSnapshotExecutor = {
      query: async () => { throw new Error("outside query"); },
      transaction: async () => { throw new Error("writer transaction"); },
      snapshot: (work) => db.b.snapshot(work),
    };
    expect((await boot(db, snapshotOnly)).status).toBe("TERMINAL_NON_SUBMISSION");
    expect((await boot(db, snapshotOnly)).status).toBe("TERMINAL_NON_SUBMISSION");
    const state = await db.observer.query<{ status: string }>(
      "SELECT status FROM broker_idempotency_records", []);
    expect(state.rows[0]?.status).toBe("FAILED_NOT_SUBMITTED");
  }));

  it("sees a complete pre-commit tuple in B and a terminal post-commit tuple in C", () =>
    realTest(async (db) => {
      const request = await prepared(db, "SUBMITTED");
      const written = deferred(), releaseWriter = deferred();
      const readRecovery = deferred(), resumeReader = deferred();
      const before: TupleFacts = {}, after: TupleFacts = {};
      db.a.afterQuery = async (marker) => {
        if (marker === "orchestration-state-store-postgres:terminal-update") {
          written.resolve(); await releaseWriter.promise;
        }
      };
      const paused: PostgresSnapshotExecutor = {
        query: async () => { throw new Error("outside query"); },
        transaction: async () => { throw new Error("writer transaction"); },
        snapshot: (work) => db.b.snapshot((tx) => work({ query: async <Row>(sql: string,
          params: readonly unknown[]) => {
          const result = await tx.query<Row>(sql, params);
          capture(sql, result.rows, before);
          if (sql.includes("orchestration-state-store-postgres:load")) {
            readRecovery.resolve(); await bounded(resumeReader.promise, "resume D4 boot reader");
          }
          return result;
        } } as PostgresTransaction)),
      };
      const a = service(db).commitNormalTerminalNonSubmissionDisposition(request);
      let b: ReturnType<typeof boot> | undefined;
      try {
        await bounded(written.promise, "D3N terminal writes before commit");
        b = boot(db, paused);
        await bounded(readRecovery.promise, "D4 early recovery read");
        expect(db.a.lastTransactionPid).toBeDefined();
        expect(db.b.lastTransactionPid).toBeDefined();
        expect(db.a.lastTransactionPid).not.toBe(db.b.lastTransactionPid);
        releaseWriter.resolve();
        expect((await bounded(a, "D3N writer commit")).status).toBe("COMMITTED");
        resumeReader.resolve();
        const prior = await bounded(b, "D4 pre-commit snapshot");
        expect(prior.status).toBe("RECONCILIATION_REQUIRED");
        expect(prior.status).not.toBe("TERMINAL_NON_SUBMISSION");
        expect(before).toMatchObject({ recoveryRef: null, recoveryRevision: "2",
          pendingStates: ["PENDING"], terminalPendingStates: [], brokerStatuses: ["SUBMITTED"],
          receiptRows: 0, checkpointRows: 1, outcomeRows: 0 });
        const fresh: PostgresSnapshotExecutor = {
          query: async () => { throw new Error("outside query"); },
          transaction: async () => { throw new Error("writer transaction"); },
          snapshot: (work) => db.b.snapshot((tx) => work({ query: async <Row>(sql: string,
            params: readonly unknown[]) => {
            const result = await tx.query<Row>(sql, params);
            capture(sql, result.rows, after);
            return result;
          } } as PostgresTransaction)),
        };
        expect((await boot(db, fresh)).status).toBe("TERMINAL_NON_SUBMISSION");
        expect(after).toMatchObject({ recoveryRef: "terminal-1", recoveryRevision: "3",
          pendingStates: [], terminalPendingStates: ["RESOLVED"],
          brokerStatuses: ["FAILED_NOT_SUBMITTED"], receiptRows: 1,
          checkpointRows: 1, outcomeRows: 0 });
      } finally {
        releaseWriter.resolve(); resumeReader.resolve(); db.a.afterQuery = undefined;
        await bounded(Promise.allSettled([a, ...(b ? [b] : [])]), "D4 race cleanup");
      }
    }));
});
