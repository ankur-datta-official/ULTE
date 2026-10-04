import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  createOrchestrationExternalOutcome, createOrchestrationPendingEffect,
  orchestrationFenceToken, orchestrationOutcomeKey, orchestrationRevision, orchestrationSessionId,
} from "@ulte/orchestration-state-store";
import {
  appendOutcomeInTransaction, createPendingEffectInTransaction, resolvePendingEffectInTransaction,
  listUnresolvedEffectsInTransaction, listExecutionOutcomesInTransaction,
  PersistenceCorruptionError, PostgresOrchestrationEffectStore,
  type PostgresExecutor, type PostgresQueryResult, type PostgresTransaction,
} from "./index.js";
import { mapOutcomeRow, mapPendingRow } from "./effect-mapping.js";

type Row = Record<string, unknown>;
const sessionId = orchestrationSessionId("session-1");
const identity = { adapterId: "adapter-1", environment: "SANDBOX", operation: "ENTRY_SUBMISSION",
  executionAttemptId: "attempt-1", idempotencyKey: "key-1", requestFingerprint: "fingerprint-1" } as const;
function effect(overrides: Record<string, unknown> = {}) {
  return createOrchestrationPendingEffect({ schemaVersion: "ORCHESTRATION_PENDING_EFFECT_V1",
    sessionId, ...identity, createdRevision: orchestrationRevision(2), createdFence: orchestrationFenceToken(3),
    state: "PENDING", resolvedOutcomeKey: null, resolvedRevision: null, resolvedFence: null, ...overrides });
}
function outcome(overrides: Record<string, unknown> = {}) {
  return createOrchestrationExternalOutcome({ schemaVersion: "ORCHESTRATION_EXTERNAL_OUTCOME_V1",
    outcomeKey: orchestrationOutcomeKey("outcome-1"), sessionId, executionAttemptId: "attempt-1",
    observedAt: 100, observedFence: orchestrationFenceToken(3), pendingEffectIdentity: identity,
    observation: { kind: "BROKER_DISPOSITION", disposition: { status: "CONFIRMED_ACCEPTED", adapterOrderId: "order-1" } },
    ...overrides });
}
const pendingFields = ["schema_version", "session_id", "adapter_id", "environment", "operation",
  "execution_attempt_id", "idempotency_key", "request_fingerprint", "created_revision", "created_fence",
  "state", "resolved_outcome_key", "resolved_revision", "resolved_fence"];
const outcomeFields = ["schema_version", "outcome_key", "session_id", "execution_attempt_id", "observed_at_ms",
  "observed_fence", "pending_adapter_id", "pending_environment", "pending_operation",
  "pending_execution_attempt_id", "pending_idempotency_key", "pending_request_fingerprint",
  "observation_kind", "observation_payload"];
function pendingRow(value = effect()): Row {
  const values = [value.schemaVersion, value.sessionId, value.adapterId, value.environment, value.operation,
    value.executionAttemptId, value.idempotencyKey, value.requestFingerprint, String(value.createdRevision),
    String(value.createdFence), value.state, value.resolvedOutcomeKey, value.resolvedRevision, value.resolvedFence];
  return Object.fromEntries(pendingFields.map((field, index) => [field, values[index]]));
}
function outcomeRow(value = outcome()): Row {
  const pending = value.pendingEffectIdentity;
  const values = [value.schemaVersion, value.outcomeKey, value.sessionId, value.executionAttemptId,
    String(value.observedAt), String(value.observedFence), pending?.adapterId ?? null,
    pending?.environment ?? null, pending?.operation ?? null, pending?.executionAttemptId ?? null,
    pending?.idempotencyKey ?? null, pending?.requestFingerprint ?? null, value.observation.kind,
    value.observation.kind === "BROKER_DISPOSITION" ? value.observation.disposition : value.observation.transition];
  return Object.fromEntries(outcomeFields.map((field, index) => [field, values[index]]));
}
function result<T>(rows: readonly Row[]): PostgresQueryResult<T> { return { rows: rows as readonly T[], rowCount: rows.length }; }
class FakePostgres implements PostgresExecutor {
  public pending = new Map<string, Row>();
  public outcomes = new Map<string, Row>();
  public sql: string[] = [];
  public failResolution = false;
  private key(row: Row) { return `${row["adapter_id"]}:${row["idempotency_key"]}`; }
  public async transaction<T>(work: (transaction: PostgresTransaction) => Promise<T>): Promise<T> {
    const before = new Map([...this.pending].map(([key, row]) => [key, { ...row }]));
    const beforeOutcomes = new Map([...this.outcomes].map(([key, row]) => [key, { ...row }]));
    try { return await work(this); }
    catch (error) { this.pending = before; this.outcomes = beforeOutcomes; throw error; }
  }
  public async query<T>(sql: string, params: readonly unknown[]): Promise<PostgresQueryResult<T>> {
    this.sql.push(sql);
    const op = /effect:([a-z-]+)/.exec(sql)?.[1];
    if (op === "pending-insert") {
      const row = Object.fromEntries(pendingFields.map((field, index) => [field, params[index]]));
      if (this.pending.has(this.key(row))) return result<T>([]);
      this.pending.set(this.key(row), row); return result<T>([row]);
    }
    if (op === "pending-load") {
      const row = this.pending.get(`${params[0]}:${params[1]}`); return result<T>(row ? [row] : []);
    }
    if (op === "pending-list") return result<T>([...this.pending.values()]
      .filter((row) => row["session_id"] === params[0] && row["state"] === "PENDING")
      .sort((a, b) => Number(a["created_revision"]) - Number(b["created_revision"])
        || String(a["adapter_id"]).localeCompare(String(b["adapter_id"]))
        || String(a["idempotency_key"]).localeCompare(String(b["idempotency_key"]))));
    if (op === "pending-resolve") {
      const row = this.pending.get(`${params[0]}:${params[1]}`);
      if (this.failResolution || !row || row["state"] !== "PENDING") return result<T>([]);
      const updated = { ...row, state: "RESOLVED", resolved_outcome_key: params[2],
        resolved_revision: params[3], resolved_fence: params[4] };
      this.pending.set(this.key(updated), updated); return result<T>([updated]);
    }
    if (op === "outcome-insert") {
      expect(sql).toContain("ON CONFLICT (outcome_key) DO NOTHING");
      const row = Object.fromEntries(outcomeFields.map((field, index) => [field,
        field === "observation_payload" ? JSON.parse(String(params[index])) : params[index]]));
      if (this.outcomes.has(String(row["outcome_key"]))) return result<T>([]);
      this.outcomes.set(String(row["outcome_key"]), row); return result<T>([row]);
    }
    if (op === "outcome-load") { const row = this.outcomes.get(String(params[0])); return result<T>(row ? [row] : []); }
    if (op === "outcome-list") return result<T>([...this.outcomes.values()]
      .filter((row) => row["session_id"] === params[0] && row["execution_attempt_id"] === params[1])
      .sort((a, b) => Number(a["observed_at_ms"]) - Number(b["observed_at_ms"])
        || String(a["outcome_key"]).localeCompare(String(b["outcome_key"]))));
    throw new Error(`Unexpected SQL: ${op}`);
  }
}

describe("pending effects and outcomes", () => {
  it("reads only unresolved effects for the exact session in durable order through the caller tx", async () => {
    const db = new FakePostgres();
    const first = effect({ adapterId: "adapter-a", idempotencyKey: "key-a", createdRevision: 1 });
    const second = effect({ adapterId: "adapter-b", idempotencyKey: "key-b" });
    const third = effect({ adapterId: "adapter-a", idempotencyKey: "key-b" });
    for (const value of [second, third, first]) await createPendingEffectInTransaction(db, value);
    db.pending.set("adapter-c:key-c", pendingRow(effect({ adapterId: "adapter-c", idempotencyKey: "key-c",
      sessionId: orchestrationSessionId("other") })));
    db.pending.set("adapter-d:key-d", pendingRow(effect({ adapterId: "adapter-d", idempotencyKey: "key-d",
      state: "RESOLVED", resolvedOutcomeKey: orchestrationOutcomeKey("resolved"),
      resolvedRevision: 3, resolvedFence: 3 })));
    const tx: PostgresTransaction = { query: (sql, params) => db.query(sql, params) };
    const selected = await listUnresolvedEffectsInTransaction(tx, sessionId);
    expect(selected).toEqual([first, third, second]);
    expect(db.sql.at(-1)).toContain("state = 'PENDING'");
    expect(db.sql.at(-1)).toContain("ORDER BY created_revision ASC, adapter_id ASC, idempotency_key ASC");
    expect(await new PostgresOrchestrationEffectStore(db).listUnresolvedEffects(sessionId)).toEqual(selected);
    db.pending.set("adapter-a:key-a", { ...pendingRow(first), environment: "LIVE" });
    await expect(listUnresolvedEffectsInTransaction(tx, sessionId)).rejects.toBeInstanceOf(PersistenceCorruptionError);
  });

  it("reads exact attempt outcomes with both observation kinds and rejects malformed rows", async () => {
    const db = new FakePostgres(), store = new PostgresOrchestrationEffectStore(db);
    const disposition = outcome({ outcomeKey: orchestrationOutcomeKey("b"), observedAt: 200 });
    const canonical = outcome({ outcomeKey: orchestrationOutcomeKey("a"), observedAt: 100,
      pendingEffectIdentity: null, observation: { kind: "CANONICAL_EXECUTION_TRANSITION", transition: {
        kind: "ENTRY_FILL_APPLIED", fill: { executionAttemptId: "attempt-1", adapterOrderId: "order-1",
          fillId: "fill-1", filledQuantity: "1", fillPrice: "10", filledAt: 100 },
      } } });
    const otherAttempt = outcome({ outcomeKey: orchestrationOutcomeKey("other-attempt"), executionAttemptId: "attempt-2",
      pendingEffectIdentity: { ...identity, executionAttemptId: "attempt-2" } });
    const otherSession = outcome({ outcomeKey: orchestrationOutcomeKey("other-session"),
      sessionId: orchestrationSessionId("other") });
    for (const value of [disposition, otherAttempt, canonical, otherSession]) await store.appendOutcome(value);
    const tx: PostgresTransaction = { query: (sql, params) => db.query(sql, params) };
    expect(await listExecutionOutcomesInTransaction(tx, sessionId, "attempt-1")).toEqual([canonical, disposition]);
    expect(await store.listExecutionOutcomes(sessionId, "attempt-1")).toEqual([canonical, disposition]);
    expect(db.sql.at(-1)).toContain("ORDER BY observed_at_ms ASC, outcome_key ASC");
    db.outcomes.set("a", { ...outcomeRow(canonical), observation_payload: [] });
    await expect(listExecutionOutcomesInTransaction(tx, sessionId, "attempt-1"))
      .rejects.toBeInstanceOf(PersistenceCorruptionError);
  });

  it("routes transactional effect reads exclusively to the supplied query object", async () => {
    const db = new FakePostgres();
    const tx: PostgresTransaction = { query: (sql, params) => db.query(sql, params) };
    db.pending.set("adapter-1:key-1", pendingRow());
    db.outcomes.set("outcome-1", outcomeRow());
    expect(await listUnresolvedEffectsInTransaction(tx, sessionId)).toEqual([effect()]);
    expect(await listExecutionOutcomesInTransaction(tx, sessionId, "attempt-1")).toEqual([outcome()]);
    expect(db.sql.slice(-2).map((sql) => /effect:([a-z-]+)/.exec(sql)?.[1]))
      .toEqual(["pending-list", "outcome-list"]);
  });
  it("loads missing keys as null and returns NOT_FOUND for missing pending", async () => {
    const db = new FakePostgres(), store = new PostgresOrchestrationEffectStore(db);
    expect(await store.loadPendingEffect(identity as never)).toBeNull();
    expect(await store.loadOutcome(orchestrationOutcomeKey("missing"))).toBeNull();
    expect(await resolvePendingEffectInTransaction(db, { sessionId, pendingEffectIdentity: identity,
      outcomeKey: orchestrationOutcomeKey("missing"), expectedRevision: orchestrationRevision(3),
      expectedFence: orchestrationFenceToken(3) })).toEqual({ status: "NOT_FOUND" });
  });
  it("creates once and classifies identical creation even after resolution", async () => {
    const db = new FakePostgres(), value = effect();
    expect((await createPendingEffectInTransaction(db, value)).status).toBe("CREATED");
    expect((await createPendingEffectInTransaction(db, value)).status).toBe("DUPLICATE_SAME");
    db.pending.set("adapter-1:key-1", pendingRow(effect({ state: "RESOLVED", resolvedOutcomeKey: orchestrationOutcomeKey("outcome-1"),
      resolvedRevision: orchestrationRevision(3), resolvedFence: orchestrationFenceToken(4) })));
    expect((await createPendingEffectInTransaction(db, value)).status).toBe("DUPLICATE_SAME");
  });
  it.each([
    { sessionId: orchestrationSessionId("other") }, { environment: "DRY_RUN" },
    { operation: "ENTRY_CANCELLATION" }, { executionAttemptId: "other" },
    { requestFingerprint: "other" }, { createdRevision: orchestrationRevision(4) },
    { createdFence: orchestrationFenceToken(4) },
  ])("reports creation conflict for changed immutable facts %j", async (change) => {
    const db = new FakePostgres(); await createPendingEffectInTransaction(db, effect());
    expect((await createPendingEffectInTransaction(db, effect(change))).status).toBe("EFFECT_CONFLICT");
  });
  it("loads complete identity, filters unresolved and orders ties", async () => {
    const db = new FakePostgres(), store = new PostgresOrchestrationEffectStore(db);
    const first = effect({ adapterId: "adapter-a", idempotencyKey: "key-a", createdRevision: orchestrationRevision(1) });
    const second = effect({ adapterId: "adapter-b", idempotencyKey: "key-b" });
    const third = effect({ adapterId: "adapter-a", idempotencyKey: "key-b" });
    for (const value of [second, third, first]) await createPendingEffectInTransaction(db, value);
    expect((await store.listUnresolvedEffects(sessionId)).map((item) => item.idempotencyKey)).toEqual(["key-a", "key-b", "key-b"]);
    expect(await store.loadPendingEffect({ adapterId: first.adapterId, environment: first.environment,
      operation: first.operation, executionAttemptId: first.executionAttemptId,
      idempotencyKey: first.idempotencyKey, requestFingerprint: first.requestFingerprint })).toEqual(first);
    await expect(store.loadPendingEffect({ adapterId: first.adapterId, environment: first.environment,
      operation: "ENTRY_CANCELLATION", executionAttemptId: first.executionAttemptId,
      idempotencyKey: first.idempotencyKey, requestFingerprint: first.requestFingerprint })).rejects.toBeInstanceOf(PersistenceCorruptionError);
    db.pending.set("adapter-a:key-a", pendingRow(effect({ ...first, state: "RESOLVED",
      resolvedOutcomeKey: orchestrationOutcomeKey("outcome-1"), resolvedRevision: orchestrationRevision(2),
      resolvedFence: orchestrationFenceToken(3) })));
    expect((await store.listUnresolvedEffects(sessionId))).toHaveLength(2);
  });
  it("fails the entire read for corrupt pending rows and unsafe BIGINT", async () => {
    const db = new FakePostgres(), store = new PostgresOrchestrationEffectStore(db);
    db.pending.set("adapter-1:key-1", { ...pendingRow(), environment: "LIVE" });
    await expect(store.listUnresolvedEffects(sessionId)).rejects.toBeInstanceOf(PersistenceCorruptionError);
    expect(() => mapPendingRow({ ...pendingRow(), created_revision: "01" } as never)).toThrow(PersistenceCorruptionError);
    expect(() => mapPendingRow({ ...pendingRow(), created_fence: "9007199254740992" } as never)).toThrow(PersistenceCorruptionError);
  });
  it("appends only once, detects contradictory keys, and accepts historical fences", async () => {
    const db = new FakePostgres(), store = new PostgresOrchestrationEffectStore(db);
    const value = outcome({ observedFence: orchestrationFenceToken(1) });
    expect((await store.appendOutcome(value)).status).toBe("APPENDED");
    expect((await store.appendOutcome(value)).status).toBe("DUPLICATE_SAME");
    expect((await store.appendOutcome(outcome({ observedFence: orchestrationFenceToken(4) }))).status).toBe("OUTCOME_CONFLICT");
    expect(await store.loadOutcome(value.outcomeKey)).toEqual(value);
    expect(db.sql.filter((sql) => /UPDATE orchestration_external_outcome/i.test(sql))).toHaveLength(0);
  });
  it("supports outcomes without pending and orders by observation time then key", async () => {
    const db = new FakePostgres(), store = new PostgresOrchestrationEffectStore(db);
    const a = outcome({ outcomeKey: orchestrationOutcomeKey("a"), observedAt: 200 });
    const b = outcome({ outcomeKey: orchestrationOutcomeKey("b"), observedAt: 100 });
    const c = outcome({ outcomeKey: orchestrationOutcomeKey("c"), observedAt: 100 });
    for (const value of [a, c, b]) await store.appendOutcome(value);
    expect((await store.listExecutionOutcomes(sessionId, "attempt-1")).map((item) => item.outcomeKey)).toEqual(["b", "c", "a"]);
    const unlinked = outcome({ outcomeKey: orchestrationOutcomeKey("unlinked"), pendingEffectIdentity: null,
      observation: { kind: "CANONICAL_EXECUTION_TRANSITION", transition: {
        kind: "ENTRY_FILL_APPLIED", fill: { executionAttemptId: "attempt-1", adapterOrderId: "order-1",
          fillId: "fill-1", filledQuantity: "1", fillPrice: "10", filledAt: 101 },
      } } });
    expect((await store.appendOutcome(unlinked)).status).toBe("APPENDED");
    expect(await store.loadOutcome(unlinked.outcomeKey)).toEqual(unlinked);
    expect(() => outcome({ pendingEffectIdentity: null })).toThrow();
  });
  it("fails closed on malformed JSONB and unsafe outcome BIGINT", () => {
    expect(() => mapOutcomeRow({ ...outcomeRow(), observation_payload: [] } as never)).toThrow(PersistenceCorruptionError);
    expect(() => mapOutcomeRow({ ...outcomeRow(), observed_at_ms: "01" } as never)).toThrow(PersistenceCorruptionError);
    expect(() => mapOutcomeRow({ ...outcomeRow(), observed_fence: Number.MAX_SAFE_INTEGER + 1 } as never)).toThrow(PersistenceCorruptionError);
  });
  it("resolves with a newer fence, preserves creation, and rejects conflicting replay", async () => {
    const db = new FakePostgres(), store = new PostgresOrchestrationEffectStore(db);
    await createPendingEffectInTransaction(db, effect()); await store.appendOutcome(outcome());
    const request = { sessionId, pendingEffectIdentity: identity, outcomeKey: orchestrationOutcomeKey("outcome-1"),
      expectedRevision: orchestrationRevision(4), expectedFence: orchestrationFenceToken(5) };
    const first = await resolvePendingEffectInTransaction(db, request);
    expect(first.status).toBe("RESOLVED");
    if (first.status === "RESOLVED") {
      expect(first.effect.createdFence).toBe(3);
      expect(first.effect.resolvedFence).toBe(5);
    }
    expect((await resolvePendingEffectInTransaction(db, request)).status).toBe("ALREADY_RESOLVED");
    await expect(resolvePendingEffectInTransaction(db, { ...request, expectedFence: orchestrationFenceToken(6) }))
      .rejects.toBeInstanceOf(PersistenceCorruptionError);
  });
  it("requires a matching outcome and fails on impossible conditional update", async () => {
    const db = new FakePostgres(), store = new PostgresOrchestrationEffectStore(db);
    await createPendingEffectInTransaction(db, effect());
    const request = { sessionId, pendingEffectIdentity: identity, outcomeKey: orchestrationOutcomeKey("outcome-1"),
      expectedRevision: orchestrationRevision(4), expectedFence: orchestrationFenceToken(5) };
    expect((await resolvePendingEffectInTransaction(db, request)).status).toBe("OUTCOME_NOT_FOUND");
    await store.appendOutcome(outcome({ sessionId: orchestrationSessionId("other") }));
    await expect(resolvePendingEffectInTransaction(db, request)).rejects.toBeInstanceOf(PersistenceCorruptionError);
    db.outcomes.set("outcome-1", outcomeRow()); db.failResolution = true;
    await expect(resolvePendingEffectInTransaction(db, request)).rejects.toBeInstanceOf(PersistenceCorruptionError);
  });
  it("rolls back pending mutations with the caller transaction", async () => {
    const db = new FakePostgres();
    await expect(db.transaction(async (tx) => {
      await createPendingEffectInTransaction(tx, effect()); throw new Error("rollback");
    })).rejects.toThrow("rollback");
    expect(db.pending.size).toBe(0);
  });
  it("rolls back a resolution when the outer transaction fails", async () => {
    const db = new FakePostgres(), store = new PostgresOrchestrationEffectStore(db);
    await createPendingEffectInTransaction(db, effect());
    await store.appendOutcome(outcome());
    await expect(db.transaction(async (tx) => {
      const resolved = await resolvePendingEffectInTransaction(tx, { sessionId,
        pendingEffectIdentity: identity, outcomeKey: orchestrationOutcomeKey("outcome-1"),
        expectedRevision: orchestrationRevision(3), expectedFence: orchestrationFenceToken(4) });
      expect(resolved.status).toBe("RESOLVED");
      throw new Error("rollback");
    })).rejects.toThrow("rollback");
    expect((await store.loadPendingEffect(identity as never))?.state).toBe("PENDING");
  });
  it("appends both observation kinds through only the caller query object", async () => {
    const db = new FakePostgres(), calls: string[] = [];
    const tx: PostgresTransaction = { query: (sql, params) => {
      calls.push(/effect:([a-z-]+)/.exec(sql)?.[1] ?? "unknown");
      return db.query(sql, params);
    } };
    const disposition = outcome();
    const canonical = outcome({ outcomeKey: orchestrationOutcomeKey("canonical"), pendingEffectIdentity: null,
      observation: { kind: "CANONICAL_EXECUTION_TRANSITION", transition: {
        kind: "ENTRY_FILL_APPLIED", fill: { executionAttemptId: "attempt-1", adapterOrderId: "order-1",
          fillId: "fill-1", filledQuantity: "1", fillPrice: "10", filledAt: 100 },
      } } });
    expect(await appendOutcomeInTransaction(tx, disposition)).toEqual({ status: "APPENDED", outcome: disposition });
    expect(await appendOutcomeInTransaction(tx, canonical)).toEqual({ status: "APPENDED", outcome: canonical });
    expect(calls).toEqual(["outcome-insert", "outcome-insert"]);
    expect(db.pending.size).toBe(0);
    expect(mapOutcomeRow(db.outcomes.get("outcome-1") as never)).toEqual(disposition);
    expect(mapOutcomeRow(db.outcomes.get("canonical") as never)).toEqual(canonical);
    expect(await new PostgresOrchestrationEffectStore(db).loadOutcome(canonical.outcomeKey)).toEqual(canonical);
  });
  it("preserves exact duplicate and immutable conflict results in both entry points", async () => {
    const db = new FakePostgres(), store = new PostgresOrchestrationEffectStore(db);
    const tx: PostgresTransaction = { query: (sql, params) => db.query(sql, params) };
    const value = outcome();
    expect((await appendOutcomeInTransaction(tx, value)).status).toBe("APPENDED");
    expect(await store.appendOutcome(value)).toEqual({ status: "DUPLICATE_SAME", outcome: value });
    const changed = outcome({ observedFence: orchestrationFenceToken(4) });
    expect(await appendOutcomeInTransaction(tx, changed)).toEqual({ status: "OUTCOME_CONFLICT", existing: value });
    expect((await store.appendOutcome(changed)).status).toBe("OUTCOME_CONFLICT");
    expect(db.sql.filter((sql) => /effect:(pending|lease|recovery|checkpoint|receipt)/.test(sql))).toHaveLength(0);
    expect(db.sql.filter((sql) => /UPDATE/i.test(sql))).toHaveLength(0);
  });
  it("fails closed on malformed durable outcome and leaves rollback to the owner", async () => {
    const db = new FakePostgres();
    const tx: PostgresTransaction = { query: (sql, params) => db.query(sql, params) };
    db.outcomes.set("outcome-1", { ...outcomeRow(), observation_payload: [] });
    await expect(appendOutcomeInTransaction(tx, outcome())).rejects.toBeInstanceOf(PersistenceCorruptionError);
    db.outcomes.clear();
    await expect(db.transaction(async (ownedTx) => {
      await appendOutcomeInTransaction(ownedTx, outcome());
      throw new Error("owner rollback");
    })).rejects.toThrow("owner rollback");
    expect(db.outcomes.size).toBe(0);
  });
  it("migration is additive and constrains the durable model", () => {
    const migration = readFileSync(fileURLToPath(new URL("../migrations/0003_orchestration_pending_effects_and_outcomes.sql", import.meta.url)), "utf8");
    expect(migration).toContain("CREATE TABLE orchestration_pending_effect");
    expect(migration).toContain("CREATE TABLE orchestration_external_outcome");
    expect(migration).toContain("PRIMARY KEY (adapter_id, idempotency_key)");
    expect(migration).toContain("outcome_key TEXT NOT NULL PRIMARY KEY");
    expect(migration).toContain("jsonb_typeof(observation_payload) = 'object'");
    expect(migration).toContain("resolved_revision >= created_revision");
    expect(migration).toContain("WHERE state = 'PENDING'");
    expect(migration).toContain("(session_id, execution_attempt_id, observed_at_ms, outcome_key)");
    expect(migration).not.toMatch(/\bLIVE\b|\bUUID\b|\brandom\b|\bNOW\s*\(|CURRENT_TIMESTAMP|clock_timestamp/i);
  });
});
