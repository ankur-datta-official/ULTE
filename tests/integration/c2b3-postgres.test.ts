import { describe, expect, it } from "vitest";
import { createBrokerAdapterDescriptor, createBrokerFailure, type BrokerAdapter } from
  "../../packages/broker-adapters/src/index.js";
import { createCancellationAcknowledgement, createEntryAcknowledgement,
  createProtectionAcknowledgement, requestEntryCancellation, requestEntrySubmission,
  requestProtection, restoreExecutionAttemptFromEvidence,
  type EntrySubmissionRequest } from "../../packages/execution-engine/src/index.js";
import { createPostgresRecoverableOrchestrationRuntime, RecoverableOrchestrationRuntime,
  PostgresOrchestrationCommitService, PostgresOrchestrationFencedWriterService,
  PostgresRecoveryBootLoader, PostgresTerminalNonSubmissionCommitService,
  type PostgresSnapshotExecutor, type RecoverableSubmissionInput } from
  "../../packages/orchestration-state-store-postgres/src/index.js";
import { createExecutionAuthorityCheckpoint } from "../../packages/orchestration-state-store/src/index.js";
import { B1fDatabase } from "./b1f-postgres-helper.js";
import { deferred } from "./b1f-postgres-helper.js";
import { adoptionFixture, cancellationFixture, pendingFixture, seed } from "./b1f-postgres-fixture.js";

async function realTest(work: (db: B1fDatabase) => Promise<void>): Promise<void> {
  const db = await B1fDatabase.create(true);
  try { await db.proveConnections(); await work(db); }
  finally { await db.dispose(); }
}

function request(): EntrySubmissionRequest {
  const restored = restoreExecutionAttemptFromEvidence(pendingFixture().previous.evidence);
  if (restored.status !== "EXECUTION_ATTEMPT_RESTORED") throw new Error("Invalid fixture");
  const result = requestEntrySubmission(restored.executionAttempt, {
    supportsClientIdempotency: false, supportsCloseOnlyExit: true,
    supportsNativeBracketProtection: false, supportsProtectionModification: true,
    supportsOrderCancellation: true, supportsPartialFillReporting: true });
  if (result.status !== "ENTRY_SUBMISSION_READY") throw new Error("Invalid entry fixture");
  return result.request;
}
const capabilities = { supportsClientIdempotency: false, supportsCloseOnlyExit: true,
  supportsNativeBracketProtection: false, supportsProtectionModification: true,
  supportsOrderCancellation: true, supportsPartialFillReporting: true } as const;
function adapter(submit: BrokerAdapter["submitEntry"]): BrokerAdapter {
  return { descriptor: createBrokerAdapterDescriptor({ adapterId: "adapter-1", environment: "SANDBOX",
    credentialProfileRef: "test-only-profile", capabilities }), capabilities, submitEntry: submit,
    submitProtection: async () => { throw new Error("Unexpected protection call"); },
    cancelEntry: async () => { throw new Error("Unexpected cancellation call"); } };
}
function input(submit: BrokerAdapter["submitEntry"], rejection = false): RecoverableSubmissionInput {
  const fixture = pendingFixture();
  const adopted = adoptionFixture(rejection ? "rejection" : "ack");
  return { sessionId: fixture.request.sessionId, ownerId: fixture.request.ownerId,
    adapter: adapter(submit), request: request(), claimedAt: 2_100_099 as never,
    submittedAt: 2_100_100 as never, observedAt: 2_100_102 as never,
    outcomeKey: "runtime-outcome-1", terminalDispositionRef: "runtime-terminal-1",
    failureEventRef: "runtime-failure-1", currentCheckpoint: fixture.request.committedCheckpoint,
    currentRecoveryState: fixture.request.resultingRecoveryState,
    adoptedCheckpoint: adopted.request.committedCheckpoint,
    adoptedRecoveryState: adopted.request.resultingRecoveryState };
}
async function pending(db: B1fDatabase): Promise<void> {
  const fixture = pendingFixture();
  await seed(db, fixture.previous, { leaseMs: 30_000 });
  expect((await new PostgresOrchestrationCommitService(db.a).commitPendingIntent(fixture.request)).status)
    .toBe("COMMITTED");
}
function runtime(db: B1fDatabase) {
  return createPostgresRecoverableOrchestrationRuntime(db.a, db.target);
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
async function brokerStatus(db: B1fDatabase): Promise<string> {
  const record = await db.observer.query<{ status: string }>(
    "SELECT status FROM broker_idempotency_records", []);
  return record.rows[0]?.status ?? "ABSENT";
}

describe("C2B3 recoverable runtime, real PostgreSQL", () => {
  it("commits SUBMITTED before adapter I/O, calls outside a transaction, and adopts canonical acceptance", async () => {
    await realTest(async (db) => {
      await pending(db);
      let calls = 0;
      const tracked = trackedRuntime(db);
      const live = tracked.live;
      const result = await live.submit(input(async (entry) => {
        calls += 1;
        expect(tracked.transactionOpen()).toBe(false);
        expect(await brokerStatus(db)).toBe("SUBMITTED");
        expect(db.a.lastTransactionPid).toBeDefined();
        return createEntryAcknowledgement({ executionAttemptId: entry.executionAttemptId,
          idempotencyKey: entry.idempotencyKey, adapterOrderId: "order-1", acknowledgedAt: 2_100_101 });
      }));
      expect(result.status).toBe("ADOPTED");
      expect(calls).toBe(1);
      expect(await brokerStatus(db)).toBe("CONFIRMED");
      expect((await live.boot("session-1" as never, "owner-1")).status).not.toBe("RECONCILIATION_REQUIRED");
    });
  });

  it("persists and adopts a typed cancellation acknowledgement", async () => {
    await realTest(async (db) => {
      const fixture = cancellationFixture();
      await seed(db, fixture.previous, { leaseMs: 30_000 });
      expect((await new PostgresOrchestrationCommitService(db.a).commitPendingIntent(fixture.request)).status)
        .toBe("COMMITTED");
      const restored = restoreExecutionAttemptFromEvidence(fixture.previous.evidence);
      if (restored.status !== "EXECUTION_ATTEMPT_RESTORED") throw new Error("Invalid cancellation fixture");
      const cancellation = requestEntryCancellation(restored.executionAttempt);
      if (cancellation.status !== "CANCELLATION_REQUEST_READY") throw new Error("Invalid cancellation request");
      const ack = createCancellationAcknowledgement({
        executionAttemptId: cancellation.request.executionAttemptId,
        idempotencyKey: cancellation.request.idempotencyKey,
        cancellationRequestId: cancellation.request.cancellationRequestId,
        adapterOrderId: cancellation.request.adapterOrderId, acknowledgedAt: 2_100_102 });
      const { kind: _kind, ...acknowledgement } = ack;
      const adoptedCheckpoint = createExecutionAuthorityCheckpoint({
        schemaVersion: "EXECUTION_AUTHORITY_CHECKPOINT_V1", checkpointRef: "cancel-adopted",
        evidence: { ...fixture.request.committedCheckpoint.evidence,
          transitions: [...fixture.request.committedCheckpoint.evidence.transitions,
            { kind: "ENTRY_CANCELLATION_ACKNOWLEDGED", acknowledgement }] } });
      const adapterForCancel = adapter(async () => { throw new Error("Unexpected entry submission"); });
      const live = runtime(db);
      const result = await live.submit({ ...input(adapterForCancel.submitEntry),
        adapter: { ...adapterForCancel, cancelEntry: async () => {
          expect(await brokerStatus(db)).toBe("SUBMITTED");
          return ack;
        } },
        request: cancellation.request, currentCheckpoint: fixture.request.committedCheckpoint,
        currentRecoveryState: fixture.request.resultingRecoveryState,
        adoptedCheckpoint, adoptedRecoveryState: {
          ...fixture.request.resultingRecoveryState, executionAuthorityCheckpointRef: adoptedCheckpoint.checkpointRef },
        observedAt: 2_100_103 as never });
      expect(result.status).toBe("ADOPTED");
      expect(await brokerStatus(db)).toBe("CONFIRMED");
    });
  });

  it("persists and adopts a typed protection acknowledgement", async () => {
    await realTest(async (db) => {
      const fixture = adoptionFixture("fill-next");
      await seed(db, fixture.previous, { leaseMs: 30_000, outcomes: [fixture.outcome] });
      expect((await new PostgresOrchestrationCommitService(db.a).adoptOutcome(fixture.request)).status)
        .toBe("ADOPTED");
      const current = fixture.request.committedCheckpoint;
      const restored = restoreExecutionAttemptFromEvidence({ ...current.evidence,
        transitions: current.evidence.transitions.slice(0, -1) });
      if (restored.status !== "EXECUTION_ATTEMPT_RESTORED") throw new Error("Invalid protection fixture");
      const protection = requestProtection(restored.executionAttempt);
      if (protection.status !== "PROTECTION_REQUEST_READY") throw new Error("Invalid protection request");
      const ack = createProtectionAcknowledgement({ executionAttemptId: protection.request.executionAttemptId,
        idempotencyKey: protection.request.idempotencyKey,
        protectionRequestId: protection.request.protectionRequestId,
        protectedQuantity: protection.request.protectedQuantity, acknowledgedAt: 2_100_104 });
      const { kind: _kind, ...acknowledgement } = ack;
      const adoptedCheckpoint = createExecutionAuthorityCheckpoint({
        schemaVersion: "EXECUTION_AUTHORITY_CHECKPOINT_V1", checkpointRef: "protection-adopted",
        evidence: { ...current.evidence, transitions: [...current.evidence.transitions,
          { kind: "PROTECTION_ACKNOWLEDGED", acknowledgement }] } });
      const adapterForProtection = adapter(async () => { throw new Error("Unexpected entry submission"); });
      const result = await runtime(db).submit({ ...input(adapterForProtection.submitEntry),
        adapter: { ...adapterForProtection, submitProtection: async () => {
          expect(await brokerStatus(db)).toBe("SUBMITTED");
          return ack;
        } },
        request: protection.request, currentCheckpoint: current,
        currentRecoveryState: fixture.request.resultingRecoveryState,
        adoptedCheckpoint, adoptedRecoveryState: {
          ...fixture.request.resultingRecoveryState, executionAuthorityCheckpointRef: adoptedCheckpoint.checkpointRef },
        claimedAt: 2_100_103 as never, submittedAt: 2_100_103 as never,
        observedAt: 2_100_105 as never });
      expect(result.status).toBe("ADOPTED");
      expect(await brokerStatus(db)).toBe("CONFIRMED");
    });
  });

  it("uses D3N atomically for trusted definite non-submission", async () => {
    await realTest(async (db) => {
      await pending(db);
      const live = runtime(db);
      const result = await live.submit(input(async () => {
        expect(await brokerStatus(db)).toBe("SUBMITTED");
        throw createBrokerFailure({ category: "INVALID_REQUEST", certainty: "DEFINITE_FAILURE",
          submissionExposure: "NOT_SUBMITTED" });
      }));
      expect(result.status).toBe("TERMINAL_NON_SUBMISSION");
      expect(await brokerStatus(db)).toBe("FAILED_NOT_SUBMITTED");
      expect((await live.boot("session-1" as never, "owner-1")).status).toBe("TERMINAL_NON_SUBMISSION");
      let calls = 0;
      expect((await live.submit(input(async () => { calls += 1; throw new Error("unreachable"); }))).status)
        .toBe("TERMINAL_NON_SUBMISSION");
      expect((await live.reconcile({ sessionId: "session-1" as never, ownerId: "owner-1",
        observedAt: 2_100_104 as never, outcomeKey: "never-reconcile",
        provider: { reconcile: async () => { calls += 1; return { status: "STILL_UNKNOWN" }; } } })).status)
        .toBe("TERMINAL_NON_SUBMISSION");
      expect((await live.adoptAvailable({ sessionId: "session-1" as never, ownerId: "owner-1",
        adoptedCheckpoint: input(async () => { throw new Error("unreachable"); }).adoptedCheckpoint,
        adoptedRecoveryState: input(async () => { throw new Error("unreachable"); }).adoptedRecoveryState })).status)
        .toBe("TERMINAL_NON_SUBMISSION");
      expect(calls).toBe(0);
    });
  });

  it("leaves ambiguous failure for reconciliation and never resubmits on restart", async () => {
    await realTest(async (db) => {
      await pending(db);
      const live = runtime(db);
      let calls = 0;
      expect((await live.submit(input(async () => { calls += 1;
        throw createBrokerFailure({ category: "NETWORK", certainty: "OUTCOME_UNKNOWN",
          submissionExposure: "MAY_HAVE_BEEN_SUBMITTED" }); }))).status)
        .toBe("RECONCILIATION_REQUIRED");
      expect(await brokerStatus(db)).toBe("OUTCOME_UNKNOWN");
      expect((await live.submit(input(async () => { calls += 1; throw new Error("unreachable"); }))).status)
        .toBe("BLOCKED");
      expect(calls).toBe(1);
    });
  });

  it("keeps CLAIMED without SUBMITTED as intent disposition and blocks a blind restart", async () => {
    await realTest(async (db) => {
      await pending(db);
      const live = runtime(db);
      const boot = await live.boot("session-1" as never, "owner-1");
      expect(boot.status).toBe("INTENT_DISPOSITION_REQUIRED");
      if (boot.status !== "INTENT_DISPOSITION_REQUIRED" || boot.checkpointRef === null) return;
      const p = boot.pendingEffect;
      const claim = await new PostgresOrchestrationFencedWriterService(db.a).claimPendingIdempotency({
        sessionId: boot.sessionId, ownerId: boot.ownerId, expectedFence: boot.fenceToken,
        expectedRecoveryRevision: boot.recoveryRevision, expectedCheckpointRef: boot.checkpointRef,
        pendingEffectIdentity: { adapterId: p.adapterId, environment: p.environment,
          operation: p.operation, executionAttemptId: p.executionAttemptId,
          idempotencyKey: p.idempotencyKey, requestFingerprint: p.requestFingerprint },
        claim: { adapterId: p.adapterId, environment: p.environment, operation: p.operation,
          executionAttemptId: p.executionAttemptId, idempotencyKey: p.idempotencyKey,
          requestFingerprint: p.requestFingerprint, claimedAt: 2_100_099 as never } });
      expect(claim.status).toBe("PERSISTED");
      let calls = 0;
      expect((await live.submit(input(async () => { calls += 1; throw new Error("unreachable"); }))).status)
        .toBe("BLOCKED");
      expect(calls).toBe(0);
      expect(await brokerStatus(db)).toBe("CLAIMED");
    });
  });

  it("keeps a durable SUBMITTED marker on restart without another submission", async () => {
    await realTest(async (db) => {
      await pending(db);
      const live = runtime(db);
      const boot = await live.boot("session-1" as never, "owner-1");
      if (boot.status !== "INTENT_DISPOSITION_REQUIRED" || boot.checkpointRef === null) throw new Error("Unexpected boot");
      const p = boot.pendingEffect;
      const writer = new PostgresOrchestrationFencedWriterService(db.a);
      const a = { sessionId: boot.sessionId, ownerId: boot.ownerId, expectedFence: boot.fenceToken,
        expectedRecoveryRevision: boot.recoveryRevision, expectedCheckpointRef: boot.checkpointRef,
        pendingEffectIdentity: { adapterId: p.adapterId, environment: p.environment,
          operation: p.operation, executionAttemptId: p.executionAttemptId,
          idempotencyKey: p.idempotencyKey, requestFingerprint: p.requestFingerprint } };
      expect((await writer.claimPendingIdempotency({ ...a, claim: {
        ...a.pendingEffectIdentity, claimedAt: 2_100_099 as never } })).status).toBe("PERSISTED");
      expect((await writer.recordPendingIdempotencyOutcome({ ...a, update: {
        adapterId: p.adapterId, environment: p.environment, idempotencyKey: p.idempotencyKey,
        requestFingerprint: p.requestFingerprint, status: "SUBMITTED", updatedAt: 2_100_100 as never } })).status)
        .toBe("PERSISTED");
      expect((await live.boot("session-1" as never, "owner-1")).status).toBe("RECONCILIATION_REQUIRED");
      let calls = 0;
      expect((await live.submit(input(async () => { calls += 1; throw new Error("unreachable"); }))).status)
        .toBe("BLOCKED");
      expect(calls).toBe(0);
    });
  });

  it("boots to reconciliation while adapter I/O is in flight before outcome persistence", async () => {
    await realTest(async (db) => {
      await pending(db);
      const live = runtime(db);
      const invoked = deferred();
      const resume = deferred();
      const running = live.submit(input(async (entry) => {
        invoked.resolve();
        await resume.promise;
        return createEntryAcknowledgement({ executionAttemptId: entry.executionAttemptId,
          idempotencyKey: entry.idempotencyKey, adapterOrderId: "order-1", acknowledgedAt: 2_100_101 });
      }));
      try {
        await invoked.promise;
        expect(await brokerStatus(db)).toBe("SUBMITTED");
        expect((await live.boot("session-1" as never, "owner-1")).status).toBe("RECONCILIATION_REQUIRED");
      } finally { resume.resolve(); await running; }
    });
  });

  it("adopts a committed canonical outcome after its response is lost without resubmission", async () => {
    await realTest(async (db) => {
      await pending(db);
      const live = runtime(db);
      let calls = 0;
      await expect(live.submit(input(async (entry) => {
        calls += 1;
        db.a.loseNextCommitResponse = true;
        return createEntryAcknowledgement({ executionAttemptId: entry.executionAttemptId,
          idempotencyKey: entry.idempotencyKey, adapterOrderId: "order-1", acknowledgedAt: 2_100_101 });
      }))).rejects.toThrow();
      expect((await live.boot("session-1" as never, "owner-1")).status).toBe("OUTCOME_AVAILABLE");
      const adopted = adoptionFixture("ack");
      expect((await live.adoptAvailable({ sessionId: "session-1" as never, ownerId: "owner-1",
        adoptedCheckpoint: adopted.request.committedCheckpoint,
        adoptedRecoveryState: adopted.request.resultingRecoveryState })).status).toBe("ADOPTED");
      expect((await live.submit(input(async () => { calls += 1; throw new Error("unreachable"); }))).status)
        .toBe("BLOCKED");
      expect(calls).toBe(1);
    });
  });

  it("does not fabricate a canonical rejection from a generic ORDER_REJECTED error", async () => {
    await realTest(async (db) => {
      await pending(db);
      const result = await runtime(db).submit(input(async () => { throw new Error("ORDER_REJECTED"); }, true));
      expect(result.status).toBe("RECONCILIATION_REQUIRED");
      expect(await brokerStatus(db)).toBe("OUTCOME_UNKNOWN");
    });
  });

  it("blocks stale fence before adapter I/O", async () => {
    await realTest(async (db) => {
      await pending(db);
      await db.observer.query("UPDATE orchestration_recovery_lease SET owner_id='other', fence_token=4", []);
      await db.observer.query("UPDATE orchestration_recovery_state SET fence_token=4", []);
      let calls = 0;
      const result = await runtime(db).submit(input(async () => { calls += 1; throw new Error("unreachable"); }));
      expect(result.status).toBe("BLOCKED");
      expect(calls).toBe(0);
      expect(await brokerStatus(db)).toBe("ABSENT");
    });
  });

  it("reauthorizes a boot snapshot after lease takeover before adapter I/O", async () => {
    await realTest(async (db) => {
      await pending(db);
      const loader = new PostgresRecoveryBootLoader(db.a, db.target);
      const live = new RecoverableOrchestrationRuntime({
        boot: { boot: async (sessionId, ownerId) => {
          const result = await loader.boot(sessionId, ownerId);
          await db.observer.query("UPDATE orchestration_recovery_lease SET owner_id='other', fence_token=4", []);
          await db.observer.query("UPDATE orchestration_recovery_state SET fence_token=4", []);
          return result;
        } },
        pending: new PostgresOrchestrationFencedWriterService(db.a),
        terminal: new PostgresTerminalNonSubmissionCommitService(db.a, db.target),
        adoption: new PostgresOrchestrationCommitService(db.a),
      });
      let calls = 0;
      const result = await live.submit(input(async () => { calls += 1; throw new Error("unreachable"); }));
      expect(result.status).toBe("AUTHORITY_LOST");
      expect(calls).toBe(0);
      expect(await brokerStatus(db)).toBe("ABSENT");
    });
  });

  it("returns retry authorization only for explicitly retry-safe definite failure", async () => {
    await realTest(async (db) => {
      await pending(db);
      const live = runtime(db);
      const first = await live.submit(input(async () => { throw createBrokerFailure({
        category: "RATE_LIMIT", certainty: "DEFINITE_FAILURE", submissionExposure: "NOT_SUBMITTED" }); }));
      expect(first.status).toBe("RETRY_AUTHORIZED");
      expect(await brokerStatus(db)).toBe("RETRY_AUTHORIZED");
      let calls = 0;
      expect((await live.submit(input(async () => { calls += 1; throw new Error("unreachable"); }))).status)
        .toBe("BLOCKED");
      expect(calls).toBe(0);
      const retry = { ...input(async () => {
        calls += 1;
        expect(await brokerStatus(db)).toBe("SUBMITTED");
        throw createBrokerFailure({ category: "NETWORK", certainty: "OUTCOME_UNKNOWN",
          submissionExposure: "MAY_HAVE_BEEN_SUBMITTED" });
      }), explicitSameKeyRetry: true as const, claimedAt: 2_100_103 as never,
        submittedAt: 2_100_104 as never, observedAt: 2_100_105 as never };
      expect((await live.submit(retry)).status).toBe("RECONCILIATION_REQUIRED");
      expect(calls).toBe(1);
    });
  });

  it("keeps CONFIRMED_NOT_SUBMITTED as explicit same-key retry authority", async () => {
    await realTest(async (db) => {
      await pending(db);
      const live = runtime(db);
      expect((await live.submit(input(async () => { throw new Error("ambiguous"); }))).status)
        .toBe("RECONCILIATION_REQUIRED");
      const observed = await live.reconcile({ sessionId: "session-1" as never, ownerId: "owner-1",
        observedAt: 2_100_103 as never, outcomeKey: "reconciliation-1",
        provider: { reconcile: async () => ({ status: "CONFIRMED_NOT_SUBMITTED" }) } });
      expect(observed.status).toBe("RETRY_AUTHORIZED");
      expect(await brokerStatus(db)).toBe("RETRY_AUTHORIZED");
      let calls = 0;
      expect((await live.submit(input(async () => { calls += 1; throw new Error("unreachable"); }))).status)
        .toBe("BLOCKED");
      expect(calls).toBe(0);
      const retry = { ...input(async () => {
        calls += 1;
        expect(await brokerStatus(db)).toBe("SUBMITTED");
        throw createBrokerFailure({ category: "NETWORK", certainty: "OUTCOME_UNKNOWN",
          submissionExposure: "MAY_HAVE_BEEN_SUBMITTED" });
      }), explicitSameKeyRetry: true as const, claimedAt: 2_100_104 as never,
        submittedAt: 2_100_105 as never, observedAt: 2_100_106 as never };
      expect((await live.submit(retry)).status).toBe("RECONCILIATION_REQUIRED");
      expect(calls).toBe(1);
    });
  });

  it("keeps reconciliation-confirmed rejection blocked without canonical payload", async () => {
    await realTest(async (db) => {
      await pending(db);
      const tracked = trackedRuntime(db);
      const live = tracked.live;
      expect((await live.submit(input(async () => { throw new Error("ambiguous"); }))).status)
        .toBe("RECONCILIATION_REQUIRED");
      const result = await live.reconcile({ sessionId: "session-1" as never, ownerId: "owner-1",
        observedAt: 2_100_103 as never, outcomeKey: "reconciliation-1",
        provider: { reconcile: async () => {
          expect(tracked.transactionOpen()).toBe(false);
          return { status: "CONFIRMED_REJECTED" };
        } } });
      expect(result.status).toBe("CANONICAL_OUTCOME_REQUIRED");
      expect(await brokerStatus(db)).toBe("REJECTED");
      expect((await live.boot("session-1" as never, "owner-1")).status).toBe("CANONICAL_OUTCOME_REQUIRED");
    });
  });

  it("keeps reconciliation-confirmed acceptance blocked without canonical acknowledgement", async () => {
    await realTest(async (db) => {
      await pending(db);
      const live = runtime(db);
      expect((await live.submit(input(async () => { throw new Error("ambiguous"); }))).status)
        .toBe("RECONCILIATION_REQUIRED");
      expect((await live.reconcile({ sessionId: "session-1" as never, ownerId: "owner-1",
        observedAt: 2_100_103 as never, outcomeKey: "reconciliation-1",
        provider: { reconcile: async () => ({ status: "CONFIRMED_ACCEPTED", adapterOrderId: "order-1" }) } })).status)
        .toBe("CANONICAL_OUTCOME_REQUIRED");
      expect((await live.boot("session-1" as never, "owner-1")).status).toBe("CANONICAL_OUTCOME_REQUIRED");
    });
  });

  it("keeps provider failure ambiguous after a committed fenced preflight", async () => {
    await realTest(async (db) => {
      await pending(db);
      const tracked = trackedRuntime(db);
      expect((await tracked.live.submit(input(async () => { throw new Error("ambiguous"); }))).status)
        .toBe("RECONCILIATION_REQUIRED");
      const result = await tracked.live.reconcile({ sessionId: "session-1" as never, ownerId: "owner-1",
        observedAt: 2_100_103 as never, outcomeKey: "unused-outcome",
        provider: { reconcile: async () => {
          expect(tracked.transactionOpen()).toBe(false);
          throw new Error("provider unavailable");
        } } });
      expect(result.status).toBe("RECONCILIATION_REQUIRED");
      expect(await brokerStatus(db)).toBe("OUTCOME_UNKNOWN");
    });
  });
});
