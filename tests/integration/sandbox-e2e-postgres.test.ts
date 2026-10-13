import { describe, expect, it } from "vitest";
import { createBrokerAdapterDescriptor, createBrokerFailure, type BrokerAdapter } from
  "../../packages/broker-adapters/src/index.js";
import { createCancellationAcknowledgement, createEntryAcknowledgement,
  createProtectionAcknowledgement, requestEntryCancellation, requestEntrySubmission,
  requestProtection, restoreExecutionAttemptFromEvidence, type EntrySubmissionRequest } from
  "../../packages/execution-engine/src/index.js";
import { createExecutionAuthorityCheckpoint } from "../../packages/orchestration-state-store/src/index.js";
import { createPostgresRecoverableOrchestrationRuntime, PostgresOrchestrationCommitService,
  PostgresOrchestrationFencedWriterService, type PostgresSnapshotExecutor,
  type RecoverableSubmissionInput } from
  "../../packages/orchestration-state-store-postgres/src/index.js";
import { B1fDatabase } from "./b1f-postgres-helper.js";
import { adoptionFixture, cancellationFixture, pendingFixture, seed } from "./b1f-postgres-fixture.js";

const capabilities = { supportsClientIdempotency: false, supportsCloseOnlyExit: true,
  supportsNativeBracketProtection: false, supportsProtectionModification: true,
  supportsOrderCancellation: true, supportsPartialFillReporting: true } as const;
const sessionId = "session-1" as never;
const ownerId = "owner-1";

async function database(work: (db: B1fDatabase) => Promise<void>): Promise<void> {
  const db = await B1fDatabase.create(true);
  try { await db.proveConnections(); await work(db); }
  finally { await db.dispose(); }
}
function runtime(db: B1fDatabase) {
  return createPostgresRecoverableOrchestrationRuntime(db.a, db.target);
}
function entryRequest(): EntrySubmissionRequest {
  const restored = restoreExecutionAttemptFromEvidence(pendingFixture().previous.evidence);
  if (restored.status !== "EXECUTION_ATTEMPT_RESTORED") throw new Error("Invalid entry fixture");
  const ready = requestEntrySubmission(restored.executionAttempt, capabilities);
  if (ready.status !== "ENTRY_SUBMISSION_READY") throw new Error("Entry request unavailable");
  return ready.request;
}
function adapter(overrides: Partial<Pick<BrokerAdapter,
  "submitEntry" | "submitProtection" | "cancelEntry">> = {}): BrokerAdapter {
  const unexpected = async (): Promise<never> => { throw new Error("Unexpected provider call"); };
  return { descriptor: createBrokerAdapterDescriptor({ adapterId: "adapter-1",
    environment: "SANDBOX", credentialProfileRef: "test-only-profile", capabilities }),
    capabilities, submitEntry: overrides.submitEntry ?? unexpected,
    submitProtection: overrides.submitProtection ?? unexpected,
    cancelEntry: overrides.cancelEntry ?? unexpected };
}
function entryInput(broker: BrokerAdapter): RecoverableSubmissionInput {
  const pending = pendingFixture().request, adopted = adoptionFixture("ack").request;
  return { sessionId: pending.sessionId, ownerId: pending.ownerId, adapter: broker,
    request: entryRequest(), claimedAt: 2_100_099 as never, submittedAt: 2_100_100 as never,
    observedAt: 2_100_102 as never, outcomeKey: "e2e-outcome",
    terminalDispositionRef: "e2e-terminal", failureEventRef: "e2e-failure",
    currentCheckpoint: pending.committedCheckpoint,
    currentRecoveryState: pending.resultingRecoveryState,
    adoptedCheckpoint: adopted.committedCheckpoint,
    adoptedRecoveryState: adopted.resultingRecoveryState };
}
function conflictingEntry(command: RecoverableSubmissionInput): RecoverableSubmissionInput {
  const original = command.request as EntrySubmissionRequest;
  return { ...command, request: { ...original,
    limitPrice: (original.limitPrice === "123.45" ? "123.46" : "123.45") as never } };
}
async function commitPending(db: B1fDatabase): Promise<void> {
  const fixture = pendingFixture();
  await seed(db, fixture.previous, { leaseMs: 120_000 });
  expect((await new PostgresOrchestrationCommitService(db.a).commitPendingIntent(fixture.request)).status)
    .toBe("COMMITTED");
}
function tracked(db: B1fDatabase, loseTransaction?: number) {
  let active = false, transactions = 0;
  const executor: PostgresSnapshotExecutor = {
    query: (sql, params) => db.a.query(sql, params),
    snapshot: async (work) => {
      expect(active).toBe(false);
      active = true;
      try { return await db.a.snapshot(work); }
      finally { active = false; }
    },
    transaction: async (work) => {
      expect(active).toBe(false);
      transactions += 1;
      if (transactions === loseTransaction) db.a.loseNextCommitResponse = true;
      active = true;
      try { return await db.a.transaction(work); }
      finally { active = false; }
    },
  };
  return { live: createPostgresRecoverableOrchestrationRuntime(executor, db.target),
    active: () => active, transactions: () => transactions };
}
async function durable(db: B1fDatabase) {
  const recovery = await db.observer.query<{ revision: string; checkpoint: string; schema: string }>(
    "SELECT revision::text, execution_authority_checkpoint_ref AS checkpoint, schema_version AS schema FROM orchestration_recovery_state", []);
  const pending = await db.observer.query<{ state: string; resolved: string | null }>(
    "SELECT state, resolved_authority_ref AS resolved FROM orchestration_pending_effect", []);
  const broker = await db.observer.query<{ status: string }>("SELECT status FROM broker_idempotency_records", []);
  const outcomes = await db.observer.query<{ outcome_key: string; observation_kind: string }>(
    "SELECT outcome_key, observation_kind FROM orchestration_external_outcome", []);
  const adoption = await db.observer.query<{ count: string }>(
    "SELECT count(*)::text AS count FROM orchestration_external_outcome_adoption", []);
  const intent = await db.observer.query<{ count: string }>(
    "SELECT count(*)::text AS count FROM orchestration_pending_intent_commit", []);
  const terminal = await db.observer.query<{ count: string }>(
    "SELECT count(*)::text AS count FROM orchestration_terminal_non_submission_disposition", []);
  return { recovery: recovery.rows[0]!, pending: pending.rows[0]!,
    broker: broker.rows[0], outcomes: outcomes.rows, adoption: adoption.rows[0]!.count,
    intent: intent.rows[0]!.count,
    terminal: terminal.rows[0]!.count };
}
async function repeatBoots(db: B1fDatabase, expected: string): Promise<void> {
  const before = await durable(db);
  for (let i = 0; i < 3; i += 1) {
    expect((await runtime(db).boot(sessionId, ownerId)).status).toBe(expected);
    expect((await durable(db)).recovery).toEqual(before.recovery);
  }
}
async function claimAndMaybeMark(db: B1fDatabase, submitted: boolean): Promise<void> {
  const boot = await runtime(db).boot(sessionId, ownerId);
  if (boot.status !== "INTENT_DISPOSITION_REQUIRED" || boot.checkpointRef === null)
    throw new Error("Expected pending intent");
  const p = boot.pendingEffect;
  const authority = { sessionId: boot.sessionId, ownerId: boot.ownerId,
    expectedFence: boot.fenceToken, expectedRecoveryRevision: boot.recoveryRevision,
    expectedCheckpointRef: boot.checkpointRef,
    pendingEffectIdentity: { adapterId: p.adapterId, environment: p.environment,
      operation: p.operation, executionAttemptId: p.executionAttemptId,
      idempotencyKey: p.idempotencyKey, requestFingerprint: p.requestFingerprint } };
  const writer = new PostgresOrchestrationFencedWriterService(db.a);
  expect((await writer.claimPendingIdempotency({ ...authority, claim: {
    ...authority.pendingEffectIdentity, claimedAt: 2_100_099 as never } })).status).toBe("PERSISTED");
  if (submitted) expect((await writer.recordPendingIdempotencyOutcome({ ...authority, update: {
    adapterId: p.adapterId, environment: p.environment, idempotencyKey: p.idempotencyKey,
    requestFingerprint: p.requestFingerprint, status: "SUBMITTED",
    updatedAt: 2_100_100 as never } })).status).toBe("PERSISTED");
}

describe("recoverable SANDBOX end-to-end, real PostgreSQL", () => {
  it("runs entry from boot through durable adoption and stable repeated reboot", async () => {
    await database(async (db) => {
      const fixture = pendingFixture();
      await seed(db, fixture.previous, { leaseMs: 120_000 });
      expect((await runtime(db).boot(sessionId, ownerId)).status).toBe("READY");
      expect((await new PostgresOrchestrationCommitService(db.a).commitPendingIntent(fixture.request)).status)
        .toBe("COMMITTED");
      expect((await runtime(db).boot(sessionId, ownerId)).status).toBe("INTENT_DISPOSITION_REQUIRED");
      let entryCalls = 0, protectionCalls = 0, cancelCalls = 0;
      const instrumentation = tracked(db);
      const broker = adapter({ submitEntry: async (request) => {
        entryCalls += 1;
        expect(instrumentation.active()).toBe(false);
        expect((await durable(db)).broker?.status).toBe("SUBMITTED");
        return createEntryAcknowledgement({ executionAttemptId: request.executionAttemptId,
          idempotencyKey: request.idempotencyKey, adapterOrderId: "order-1",
          acknowledgedAt: 2_100_101 });
      }, submitProtection: async () => { protectionCalls += 1; throw new Error("unexpected"); },
      cancelEntry: async () => { cancelCalls += 1; throw new Error("unexpected"); } });
      const command = entryInput(broker);
      expect((await instrumentation.live.submit(conflictingEntry(command))).status).toBe("BLOCKED");
      expect((await durable(db)).broker).toBeUndefined();
      expect((await instrumentation.live.submit(command)).status).toBe("ADOPTED");
      const state = await durable(db);
      expect(state.recovery).toEqual({ revision: "3", checkpoint: "adopt-ack",
        schema: "ORCHESTRATION_RECOVERY_RECORD_V1" });
      expect(state.pending).toEqual({ state: "RESOLVED", resolved: "e2e-outcome" });
      expect(state.broker?.status).toBe("CONFIRMED");
      expect(state.outcomes).toEqual([{ outcome_key: "e2e-outcome",
        observation_kind: "CANONICAL_EXECUTION_TRANSITION" }]);
      expect(state.adoption).toBe("1");
      expect(state.intent).toBe("1");
      await repeatBoots(db, "READY");
      expect((await runtime(db).submit(command)).status).toBe("BLOCKED");
      expect((await runtime(db).submit(conflictingEntry(command))).status).toBe("BLOCKED");
      expect(await durable(db)).toEqual(state);
      expect({ entryCalls, protectionCalls, cancelCalls }).toEqual({
        entryCalls: 1, protectionCalls: 0, cancelCalls: 0 });
    });
  });

  it("reboots safely after claim, after SUBMITTED, and after lost SUBMITTED commit response", async () => {
    for (const point of ["CLAIM", "SUBMITTED", "LOST_COMMIT"] as const) {
      await database(async (db) => {
        await commitPending(db);
        let calls = 0;
        const command = entryInput(adapter({ submitEntry: async () => {
          calls += 1; throw new Error("unexpected");
        } }));
        if (point === "LOST_COMMIT") {
          const instrumented = tracked(db, 2);
          await expect(instrumented.live.submit(command)).rejects.toThrow();
          expect(instrumented.transactions()).toBe(2);
        } else await claimAndMaybeMark(db, point === "SUBMITTED");
        const expected = point === "CLAIM" ? "INTENT_DISPOSITION_REQUIRED" : "RECONCILIATION_REQUIRED";
        await repeatBoots(db, expected);
        expect((await runtime(db).submit(command)).status).toBe("BLOCKED");
        expect(calls).toBe(0);
        expect((await durable(db)).broker?.status).toBe(point === "CLAIM" ? "CLAIMED" : "SUBMITTED");
      });
    }
  });

  it("reboots after adapter I/O with no outcome commit and after lost canonical response", async () => {
    for (const point of ["OUTCOME_ROLLBACK", "LOST_CANONICAL_RESPONSE"] as const) {
      await database(async (db) => {
        await commitPending(db);
        let calls = 0;
        const broker = adapter({ submitEntry: async (request) => {
          calls += 1;
          expect((await durable(db)).broker?.status).toBe("SUBMITTED");
          if (point === "OUTCOME_ROLLBACK") db.a.failNextCommit = true;
          else db.a.loseNextCommitResponse = true;
          return createEntryAcknowledgement({ executionAttemptId: request.executionAttemptId,
            idempotencyKey: request.idempotencyKey, adapterOrderId: "order-1",
            acknowledgedAt: 2_100_101 });
        } });
        const command = entryInput(broker);
        await expect(runtime(db).submit(command)).rejects.toThrow();
        const expected = point === "OUTCOME_ROLLBACK" ? "RECONCILIATION_REQUIRED" : "OUTCOME_AVAILABLE";
        expect((await runtime(db).boot(sessionId, ownerId)).status).toBe(expected);
        expect((await runtime(db).submit(command)).status).toBe("BLOCKED");
        expect(calls).toBe(1);
        if (point === "LOST_CANONICAL_RESPONSE") {
          const adopted = adoptionFixture("ack").request;
          expect((await runtime(db).adoptAvailable({ sessionId, ownerId,
            adoptedCheckpoint: adopted.committedCheckpoint,
            adoptedRecoveryState: adopted.resultingRecoveryState })).status).toBe("ADOPTED");
          await repeatBoots(db, "READY");
          expect((await durable(db)).adoption).toBe("1");
        } else {
          await repeatBoots(db, "RECONCILIATION_REQUIRED");
          expect((await durable(db)).outcomes).toEqual([]);
        }
        expect(calls).toBe(1);
      });
    }
  });

  it("keeps D3N terminal closure and ambiguous failure stable across three restarts", async () => {
    for (const kind of ["TERMINAL", "AMBIGUOUS"] as const) {
      await database(async (db) => {
        await commitPending(db);
        let submitCalls = 0, reconciliationCalls = 0;
        const broker = adapter({ submitEntry: async () => {
          submitCalls += 1;
          if (kind === "TERMINAL") throw createBrokerFailure({
            category: "INVALID_REQUEST", certainty: "DEFINITE_FAILURE",
            submissionExposure: "NOT_SUBMITTED" });
          throw createBrokerFailure({ category: "NETWORK", certainty: "OUTCOME_UNKNOWN",
            submissionExposure: "MAY_HAVE_BEEN_SUBMITTED" });
        } });
        const command = entryInput(broker);
        expect((await runtime(db).submit(command)).status).toBe(
          kind === "TERMINAL" ? "TERMINAL_NON_SUBMISSION" : "RECONCILIATION_REQUIRED");
        await repeatBoots(db, kind === "TERMINAL"
          ? "TERMINAL_NON_SUBMISSION" : "RECONCILIATION_REQUIRED");
        expect((await runtime(db).submit(command)).status).toBe(
          kind === "TERMINAL" ? "TERMINAL_NON_SUBMISSION" : "BLOCKED");
        if (kind === "TERMINAL") {
          expect((await runtime(db).reconcile({ sessionId, ownerId, observedAt: 2_100_103 as never,
            outcomeKey: "blocked", provider: { reconcile: async () => {
              reconciliationCalls += 1; return { status: "STILL_UNKNOWN" };
            } } })).status).toBe("TERMINAL_NON_SUBMISSION");
          const state = await durable(db);
          expect(state.recovery.schema).toBe("ORCHESTRATION_RECOVERY_RECORD_V2");
          expect(state.pending.state).toBe("RESOLVED");
          expect(state.broker?.status).toBe("FAILED_NOT_SUBMITTED");
          expect(state.terminal).toBe("1");
        } else {
          expect((await durable(db)).broker?.status).toBe("OUTCOME_UNKNOWN");
          expect((await durable(db)).terminal).toBe("0");
        }
        expect({ submitCalls, reconciliationCalls }).toEqual({ submitCalls: 1, reconciliationCalls: 0 });
      });
    }
  });

  it("blocks a stale lease before broker I/O", async () => {
    await database(async (db) => {
      await commitPending(db);
      await db.observer.query("UPDATE orchestration_recovery_lease SET owner_id='other', fence_token=4", []);
      await db.observer.query("UPDATE orchestration_recovery_state SET fence_token=4", []);
      let calls = 0;
      const result = await runtime(db).submit(entryInput(adapter({ submitEntry: async () => {
        calls += 1; throw new Error("unexpected");
      } })));
      expect(result.status).toBe("BLOCKED");
      expect(calls).toBe(0);
      expect((await durable(db)).broker).toBeUndefined();
    });
  });

  it("persists each reconciliation disposition outside provider transactions without extra calls", async () => {
    for (const status of ["CONFIRMED_ACCEPTED", "CONFIRMED_NOT_SUBMITTED",
      "STILL_UNKNOWN", "CONFIRMED_REJECTED"] as const) {
      await database(async (db) => {
        await commitPending(db);
        let submitCalls = 0, reconciliationCalls = 0;
        const broker = adapter({ submitEntry: async () => {
          submitCalls += 1; throw new Error("ambiguous network failure");
        } });
        const command = entryInput(broker);
        expect((await runtime(db).submit(command)).status).toBe("RECONCILIATION_REQUIRED");
        const instrumented = tracked(db);
        const result = await instrumented.live.reconcile({ sessionId, ownerId,
          observedAt: 2_100_103 as never, outcomeKey: "reconcile-e2e",
          provider: { reconcile: async () => {
            reconciliationCalls += 1;
            expect(instrumented.active()).toBe(false);
            return status === "CONFIRMED_ACCEPTED" ? { status, adapterOrderId: "order-1" }
              : { status };
          } } });
        expect(result.status).toBe(status === "CONFIRMED_NOT_SUBMITTED"
          ? "RETRY_AUTHORIZED" : status === "STILL_UNKNOWN"
            ? "RECONCILIATION_REQUIRED" : "CANONICAL_OUTCOME_REQUIRED");
        const bootStatus = status === "CONFIRMED_NOT_SUBMITTED" ? "INTENT_DISPOSITION_REQUIRED"
          : status === "STILL_UNKNOWN" ? "RECONCILIATION_REQUIRED" : "CANONICAL_OUTCOME_REQUIRED";
        await repeatBoots(db, bootStatus);
        const state = await durable(db);
        expect(state.outcomes).toEqual([{ outcome_key: "reconcile-e2e",
          observation_kind: "BROKER_DISPOSITION" }]);
        expect(state.adoption).toBe("0");
        expect((await runtime(db).submit(command)).status).toBe("BLOCKED");
        expect({ submitCalls, reconciliationCalls }).toEqual({ submitCalls: 1, reconciliationCalls: 1 });
      });
    }
  });

  it("runs protection and cancellation through the same recoverable runtime", async () => {
    for (const operation of ["PROTECTION", "CANCELLATION"] as const) {
      await database(async (db) => {
        const source = operation === "CANCELLATION" ? cancellationFixture() : adoptionFixture("fill-next");
        if (operation === "CANCELLATION") {
          await seed(db, source.previous, { leaseMs: 120_000 });
          expect((await new PostgresOrchestrationCommitService(db.a).commitPendingIntent(source.request as never)).status)
            .toBe("COMMITTED");
        } else {
          const fill = adoptionFixture("fill-next");
          await seed(db, fill.previous, { leaseMs: 120_000, outcomes: [fill.outcome] });
          expect((await new PostgresOrchestrationCommitService(db.a).adoptOutcome(fill.request)).status)
            .toBe("ADOPTED");
        }
        const current = operation === "CANCELLATION"
          ? cancellationFixture().request.committedCheckpoint : adoptionFixture("fill-next").request.committedCheckpoint;
        const priorEvidence = operation === "CANCELLATION"
          ? cancellationFixture().previous.evidence
          : { ...current.evidence, transitions: current.evidence.transitions.slice(0, -1) };
        const restored = restoreExecutionAttemptFromEvidence(priorEvidence);
        if (restored.status !== "EXECUTION_ATTEMPT_RESTORED") throw new Error("Invalid operation fixture");
        const prepared = operation === "CANCELLATION"
          ? requestEntryCancellation(restored.executionAttempt) : requestProtection(restored.executionAttempt);
        if (prepared.status !== "CANCELLATION_REQUEST_READY"
            && prepared.status !== "PROTECTION_REQUEST_READY") throw new Error("Operation unavailable");
        const request = prepared.request;
        const ack = operation === "CANCELLATION"
          ? createCancellationAcknowledgement({ executionAttemptId: request.executionAttemptId,
            idempotencyKey: request.idempotencyKey,
            cancellationRequestId: (request as Extract<typeof request, { kind: "ENTRY_CANCELLATION" }>).cancellationRequestId,
            adapterOrderId: (request as Extract<typeof request, { kind: "ENTRY_CANCELLATION" }>).adapterOrderId,
            acknowledgedAt: 2_100_104 })
          : createProtectionAcknowledgement({ executionAttemptId: request.executionAttemptId,
            idempotencyKey: request.idempotencyKey,
            protectionRequestId: (request as Extract<typeof request, { kind: "PROTECTION" }>).protectionRequestId,
            protectedQuantity: (request as Extract<typeof request, { kind: "PROTECTION" }>).protectedQuantity,
            acknowledgedAt: 2_100_104 });
        const { kind: _kind, ...payload } = ack;
        const committed = createExecutionAuthorityCheckpoint({
          schemaVersion: "EXECUTION_AUTHORITY_CHECKPOINT_V1", checkpointRef: "e2e-operation-adopted",
          evidence: { ...current.evidence, transitions: [...current.evidence.transitions,
            operation === "CANCELLATION"
              ? { kind: "ENTRY_CANCELLATION_ACKNOWLEDGED", acknowledgement: payload }
              : { kind: "PROTECTION_ACKNOWLEDGED", acknowledgement: payload }] } as never });
        let entryCalls = 0, protectionCalls = 0, cancelCalls = 0;
        const instrumented = tracked(db);
        const broker = adapter({
          submitEntry: async () => { entryCalls += 1; throw new Error("unexpected"); },
          submitProtection: async () => { protectionCalls += 1; expect(instrumented.active()).toBe(false);
            expect((await durable(db)).broker?.status).toBe("SUBMITTED"); return ack as never; },
          cancelEntry: async () => { cancelCalls += 1; expect(instrumented.active()).toBe(false);
            expect((await durable(db)).broker?.status).toBe("SUBMITTED"); return ack as never; },
        });
        const base = entryInput(broker);
        const result = await instrumented.live.submit({ ...base, request, currentCheckpoint: current,
          currentRecoveryState: operation === "CANCELLATION"
            ? cancellationFixture().request.resultingRecoveryState
            : adoptionFixture("fill-next").request.resultingRecoveryState,
          adoptedCheckpoint: committed,
          adoptedRecoveryState: { ...(operation === "CANCELLATION"
            ? cancellationFixture().request.resultingRecoveryState
            : adoptionFixture("fill-next").request.resultingRecoveryState),
            executionAuthorityCheckpointRef: committed.checkpointRef },
          claimedAt: 2_100_103 as never, submittedAt: 2_100_103 as never,
          observedAt: 2_100_105 as never });
        expect(result.status).toBe("ADOPTED");
        expect({ entryCalls, protectionCalls, cancelCalls }).toEqual(operation === "CANCELLATION"
          ? { entryCalls: 0, protectionCalls: 0, cancelCalls: 1 }
          : { entryCalls: 0, protectionCalls: 1, cancelCalls: 0 });
        expect((await durable(db)).broker?.status).toBe("CONFIRMED");
        expect((await runtime(db).boot(sessionId, ownerId)).status).toBe("READY");
      });
    }
  });
});
