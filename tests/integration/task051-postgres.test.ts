import { describe, expect, it } from "vitest";
import { createBrokerAdapterDescriptor, type BrokerAdapter } from "../../packages/broker-adapters/src/index.js";
import { createCancellationRejection, createEntryRejection, createProtectionRejection,
  requestEntrySubmission, restoreExecutionAttemptFromEvidence } from
  "../../packages/execution-engine/src/index.js";
import { createExecutionAuthorityCheckpoint } from
  "../../packages/orchestration-state-store/src/index.js";
import { createPostgresRecoverableOrchestrationRuntime, PostgresOrchestrationCommitService,
  PostgresOrchestrationEffectStore, PostgresOrchestrationFencedWriterService,
  type PostgresSnapshotExecutor } from
  "../../packages/orchestration-state-store-postgres/src/index.js";
import { B1fDatabase } from "./b1f-postgres-helper.js";
import { adoptionFixture, cancellationFixture, pendingFixture, seed } from "./b1f-postgres-fixture.js";

async function database(work: (db: B1fDatabase) => Promise<void>): Promise<void> {
  const db = await B1fDatabase.create(true);
  try { await db.proveConnections(); await work(db); }
  finally { await db.dispose(); }
}

async function pending(db: B1fDatabase, operation: "ENTRY_SUBMISSION" | "PROTECTION_SUBMISSION" | "ENTRY_CANCELLATION") {
  if (operation === "ENTRY_SUBMISSION") {
    const fixture = pendingFixture();
    await seed(db, fixture.previous, { leaseMs: 120_000 });
    expect((await new PostgresOrchestrationCommitService(db.a).commitPendingIntent(fixture.request)).status).toBe("COMMITTED");
    return fixture.request.committedCheckpoint;
  }
  if (operation === "ENTRY_CANCELLATION") {
    const fixture = cancellationFixture();
    await seed(db, fixture.previous, { leaseMs: 120_000 });
    expect((await new PostgresOrchestrationCommitService(db.a).commitPendingIntent(fixture.request)).status).toBe("COMMITTED");
    return fixture.request.committedCheckpoint;
  }
  const fixture = adoptionFixture("fill-next");
  await seed(db, fixture.previous, { leaseMs: 120_000, outcomes: [fixture.outcome] });
  expect((await new PostgresOrchestrationCommitService(db.a).adoptOutcome(fixture.request)).status).toBe("ADOPTED");
  return fixture.request.committedCheckpoint;
}

async function markUnknown(db: B1fDatabase) {
  const live = createPostgresRecoverableOrchestrationRuntime(db.a, db.target);
  const boot = await live.boot("session-1" as never, "owner-1");
  if (boot.status !== "INTENT_DISPOSITION_REQUIRED" || boot.checkpointRef === null) throw new Error("Invalid pending fixture");
  const p = boot.pendingEffect;
  const authority = { sessionId: boot.sessionId, ownerId: boot.ownerId,
    expectedFence: boot.fenceToken, expectedRecoveryRevision: boot.recoveryRevision,
    expectedCheckpointRef: boot.checkpointRef,
    pendingEffectIdentity: { adapterId: p.adapterId, environment: p.environment,
      operation: p.operation, executionAttemptId: p.executionAttemptId,
      idempotencyKey: p.idempotencyKey, requestFingerprint: p.requestFingerprint } };
  const writer = new PostgresOrchestrationFencedWriterService(db.a);
  expect((await writer.claimPendingIdempotency({ ...authority,
    claim: { ...authority.pendingEffectIdentity, claimedAt: 2_100_099 as never } })).status).toBe("PERSISTED");
  for (const [status, updatedAt] of [["SUBMITTED", 2_100_100], ["OUTCOME_UNKNOWN", 2_100_102]] as const) {
    expect((await writer.recordPendingIdempotencyOutcome({ ...authority,
      update: { adapterId: p.adapterId, environment: p.environment,
        idempotencyKey: p.idempotencyKey, requestFingerprint: p.requestFingerprint,
        status, updatedAt: updatedAt as never } })).status).toBe("PERSISTED");
  }
  expect((await live.boot(boot.sessionId, boot.ownerId)).status).toBe("RECONCILIATION_REQUIRED");
  return { live, boot };
}

function rejection(operation: "ENTRY_SUBMISSION" | "PROTECTION_SUBMISSION" | "ENTRY_CANCELLATION",
  checkpoint: ReturnType<typeof pendingFixture>["request"]["committedCheckpoint"], boot: Awaited<ReturnType<typeof markUnknown>>["boot"]) {
  const p = boot.pendingEffect;
  const common = { executionAttemptId: p.executionAttemptId,
    idempotencyKey: p.idempotencyKey, adapterReasonCode: "venue-declined", rejectedAt: 2_100_103 };
  const restored = restoreExecutionAttemptFromEvidence(checkpoint.evidence);
  if (restored.status !== "EXECUTION_ATTEMPT_RESTORED") throw new Error("Invalid execution checkpoint");
  const payload = operation === "ENTRY_SUBMISSION" ? createEntryRejection(common)
    : operation === "PROTECTION_SUBMISSION" ? createProtectionRejection({ ...common,
      protectionRequestId: restored.executionAttempt.pendingProtectionRequest!.protectionRequestId })
      : createCancellationRejection({ ...common,
        cancellationRequestId: restored.executionAttempt.pendingCancellationRequest!.cancellationRequestId,
        adapterOrderId: restored.executionAttempt.adapterOrderId! });
  return { status: "CONFIRMED_REJECTED_WITH_CANONICAL" as const, operation,
    instrumentId: checkpoint.evidence.identity.instrumentId,
    requestFingerprint: p.requestFingerprint, rejection: payload };
}

function adopted(checkpoint: ReturnType<typeof pendingFixture>["request"]["committedCheckpoint"],
  transition: { readonly kind: "ENTRY_SUBMISSION_REJECTED" | "PROTECTION_REJECTED" |
    "ENTRY_CANCELLATION_REJECTED"; readonly rejection: object }) {
  const { kind: _kind, ...payload } = transition.rejection as { kind: string };
  const next = createExecutionAuthorityCheckpoint({ schemaVersion: "EXECUTION_AUTHORITY_CHECKPOINT_V1",
    checkpointRef: `task051-${transition.kind.toLowerCase()}`,
    evidence: { ...checkpoint.evidence, transitions: [...checkpoint.evidence.transitions,
      { kind: transition.kind, rejection: payload }] } });
  return { adoptedCheckpoint: next,
    adoptedRecoveryState: { mode: "SANDBOX" as const,
      instrumentId: checkpoint.evidence.identity.instrumentId,
      executionAuthorityCheckpointRef: next.checkpointRef,
      executionAuthorityIdentity: checkpoint.evidence.identity,
      riskBasisCheckpointRef: null, latestROutcomeRef: null } };
}

function trackedRuntime(db: B1fDatabase) {
  let inTransaction = false;
  const executor: PostgresSnapshotExecutor = {
    query: (sql, params) => db.a.query(sql, params),
    transaction: async (work) => {
      expect(inTransaction).toBe(false);
      inTransaction = true;
      try { return await db.a.transaction(work); }
      finally { inTransaction = false; }
    },
    snapshot: async (work) => {
      expect(inTransaction).toBe(false);
      inTransaction = true;
      try { return await db.a.snapshot(work); }
      finally { inTransaction = false; }
    },
  };
  return { live: createPostgresRecoverableOrchestrationRuntime(executor, db.target),
    transactionOpen: () => inTransaction };
}

describe("Task051 canonical reconciliation rejection, real PostgreSQL", () => {
  it.each(["ENTRY_SUBMISSION", "PROTECTION_SUBMISSION", "ENTRY_CANCELLATION"] as const)(
    "persists and adopts a typed %s rejection without submitting", async (operation) => {
      await database(async (db) => {
        const checkpoint = await pending(db, operation);
        const { boot } = await markUnknown(db);
        const tracked = trackedRuntime(db);
        const evidence = rejection(operation, checkpoint, boot);
        let calls = 0;
        const transition = { kind: operation === "ENTRY_SUBMISSION" ? "ENTRY_SUBMISSION_REJECTED"
          : operation === "PROTECTION_SUBMISSION" ? "PROTECTION_REJECTED" : "ENTRY_CANCELLATION_REJECTED",
        rejection: evidence.rejection } as const;
        const result = await tracked.live.reconcile({ sessionId: boot.sessionId, ownerId: boot.ownerId,
          observedAt: 2_100_104 as never, outcomeKey: `task051-${operation}`,
          provider: { reconcile: async () => { calls += 1;
            expect(tracked.transactionOpen()).toBe(false); return evidence as never; } },
          ...adopted(checkpoint, transition) });
        expect(result.status).toBe("ADOPTED");
        expect((await tracked.live.boot(boot.sessionId, boot.ownerId)).status).toBe("READY");
        expect(calls).toBe(1);
        const rows = await db.observer.query<{ status: string }>("SELECT status FROM broker_idempotency_records", []);
        expect(rows.rows[0]?.status).toBe("REJECTED");
      });
    });

  it("recovers durable rejection after a lost response with no second provider call", async () => {
    await database(async (db) => {
      const checkpoint = await pending(db, "ENTRY_SUBMISSION");
      const { live, boot } = await markUnknown(db);
      const evidence = rejection("ENTRY_SUBMISSION", checkpoint, boot);
      let calls = 0;
      await expect(live.reconcile({ sessionId: boot.sessionId, ownerId: boot.ownerId,
        observedAt: 2_100_104 as never, outcomeKey: "task051-lost",
        provider: { reconcile: async () => { calls += 1; db.a.loseNextCommitResponse = true;
          return evidence as never; } } })).rejects.toThrow();
      const restarted = createPostgresRecoverableOrchestrationRuntime(db.a, db.target);
      expect((await restarted.boot(boot.sessionId, boot.ownerId)).status).toBe("OUTCOME_AVAILABLE");
      const capabilities = { supportsClientIdempotency: false, supportsCloseOnlyExit: true,
        supportsNativeBracketProtection: false, supportsProtectionModification: true,
        supportsOrderCancellation: true, supportsPartialFillReporting: true } as const;
      const before = restoreExecutionAttemptFromEvidence(pendingFixture().previous.evidence);
      if (before.status !== "EXECUTION_ATTEMPT_RESTORED") throw new Error("Invalid entry fixture");
      const prepared = requestEntrySubmission(before.executionAttempt, capabilities);
      if (prepared.status !== "ENTRY_SUBMISSION_READY") throw new Error("Invalid entry request");
      let submissions = 0;
      const broker: BrokerAdapter = { descriptor: createBrokerAdapterDescriptor({
        adapterId: "adapter-1", environment: "SANDBOX", credentialProfileRef: "test-only-profile",
        capabilities }), capabilities,
        submitEntry: async () => { submissions += 1; throw new Error("duplicate submission"); },
        submitProtection: async () => { throw new Error("unexpected protection"); },
        cancelEntry: async () => { throw new Error("unexpected cancellation"); } };
      const fixture = pendingFixture();
      const retryInput = { sessionId: boot.sessionId, ownerId: boot.ownerId,
        adapter: broker, request: prepared.request, claimedAt: 2_100_105 as never,
        submittedAt: 2_100_106 as never, observedAt: 2_100_107 as never,
        outcomeKey: "task051-resubmit", terminalDispositionRef: "task051-terminal",
        failureEventRef: "task051-failure", currentCheckpoint: checkpoint,
        currentRecoveryState: fixture.request.resultingRecoveryState,
        ...adopted(checkpoint, { kind: "ENTRY_SUBMISSION_REJECTED", rejection: evidence.rejection }) };
      expect((await restarted.submit(retryInput)).status).toBe("BLOCKED");
      const transition = { kind: "ENTRY_SUBMISSION_REJECTED" as const, rejection: evidence.rejection };
      expect((await restarted.adoptAvailable({ sessionId: boot.sessionId, ownerId: boot.ownerId,
        ...adopted(checkpoint, transition) })).status).toBe("ADOPTED");
      expect((await restarted.boot(boot.sessionId, boot.ownerId)).status).toBe("READY");
      expect((await restarted.reconcile({ sessionId: boot.sessionId, ownerId: boot.ownerId,
        observedAt: 2_100_108 as never, outcomeKey: "task051-no-second-call",
        provider: { reconcile: async () => { calls += 1; throw new Error("second provider call"); } } })).status)
        .toBe("BLOCKED");
      expect((await restarted.submit(retryInput)).status).toBe("BLOCKED");
      expect(submissions).toBe(0);
      expect(calls).toBe(1);
    });
  });

  it("rejects malformed, mismatched, and conflicting canonical authority", async () => {
    for (const defect of ["operation", "attempt", "key", "instrument", "request", "reason",
      "missing-time", "conflict"] as const) {
      await database(async (db) => {
        const checkpoint = await pending(db, "ENTRY_SUBMISSION");
        const { live, boot } = await markUnknown(db);
        const valid = rejection("ENTRY_SUBMISSION", checkpoint, boot);
        const invalid = defect === "operation" ? { ...valid, operation: "PROTECTION_SUBMISSION" }
          : defect === "attempt" ? { ...valid, rejection: { ...valid.rejection, executionAttemptId: "other" } }
            : defect === "key" ? { ...valid, rejection: { ...valid.rejection, idempotencyKey: "other" } }
              : defect === "instrument" ? { ...valid, instrumentId: "other" }
                : defect === "request" ? { ...valid, requestFingerprint: "other" }
                  : defect === "reason" ? { ...valid, rejection: { ...valid.rejection, adapterReasonCode: "" } }
                    : defect === "missing-time" ? { ...valid, rejection: { ...valid.rejection,
                      rejectedAt: undefined } }
                    : valid;
        if (defect === "conflict") {
          const competing = adoptionFixture("ack").outcome;
          const provider = { reconcile: async () => {
            expect((await new PostgresOrchestrationEffectStore(db.observer).appendOutcome(competing)).status).toBe("APPENDED");
            return invalid as never;
          } };
          expect((await live.reconcile({ sessionId: boot.sessionId, ownerId: boot.ownerId,
            observedAt: 2_100_104 as never, outcomeKey: "task051-canonical",
            provider })).status).toBe("AUTHORITY_LOST");
        } else {
          await expect(live.reconcile({ sessionId: boot.sessionId, ownerId: boot.ownerId,
            observedAt: 2_100_104 as never, outcomeKey: "task051-malformed",
            provider: { reconcile: async () => invalid as never } })).rejects.toThrow();
        }
        const rows = await db.observer.query<{ status: string }>("SELECT status FROM broker_idempotency_records", []);
        expect(rows.rows[0]?.status).toBe("OUTCOME_UNKNOWN");
      });
    }
  });

  it.each(["PROTECTION_SUBMISSION", "ENTRY_CANCELLATION"] as const)(
    "rejects a %s payload with a different pending request identity", async (operation) => {
      await database(async (db) => {
        const checkpoint = await pending(db, operation);
        const { live, boot } = await markUnknown(db);
        const valid = rejection(operation, checkpoint, boot);
        const invalid = operation === "PROTECTION_SUBMISSION"
          ? { ...valid, rejection: { ...valid.rejection, protectionRequestId: "other" } }
          : { ...valid, rejection: { ...valid.rejection, cancellationRequestId: "other" } };
        await expect(live.reconcile({ sessionId: boot.sessionId, ownerId: boot.ownerId,
          observedAt: 2_100_104 as never, outcomeKey: "task051-request-mismatch",
          provider: { reconcile: async () => invalid as never } })).rejects.toThrow();
        const rows = await db.observer.query<{ status: string }>("SELECT status FROM broker_idempotency_records", []);
        expect(rows.rows[0]?.status).toBe("OUTCOME_UNKNOWN");
      });
    });

  it("rejects a cancellation rejection for another adapter order", async () => {
    await database(async (db) => {
      const checkpoint = await pending(db, "ENTRY_CANCELLATION");
      const { live, boot } = await markUnknown(db);
      const valid = rejection("ENTRY_CANCELLATION", checkpoint, boot);
      const invalid = { ...valid, rejection: { ...valid.rejection, adapterOrderId: "other" } };
      await expect(live.reconcile({ sessionId: boot.sessionId, ownerId: boot.ownerId,
        observedAt: 2_100_104 as never, outcomeKey: "task051-order-mismatch",
        provider: { reconcile: async () => invalid as never } })).rejects.toThrow();
      const rows = await db.observer.query<{ status: string }>("SELECT status FROM broker_idempotency_records", []);
      expect(rows.rows[0]?.status).toBe("OUTCOME_UNKNOWN");
    });
  });
});
