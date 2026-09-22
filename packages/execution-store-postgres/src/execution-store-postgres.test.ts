import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  brokerAdapterId,
  createBrokerAuditEvent,
  type BrokerAuditEvent,
  type IdempotencyClaimInput,
  type IdempotencyOperation,
  type IdempotencyRecordStatus,
  type RequestFingerprint,
} from "@ulte/broker-adapters";
import { unixMs } from "@ulte/instrument-model";
import {
  PersistenceConflictError,
  PersistenceCorruptionError,
  createPostgresBrokerAuditSink,
  createPostgresIdempotencyRepository,
  type PostgresExecutor,
  type PostgresQueryResult,
  type PostgresTransaction,
} from "./index.js";

type StoredRow = Record<string, unknown>;

function queryResult<Row>(rows: readonly StoredRow[]): PostgresQueryResult<Row> {
  return { rows: rows as readonly Row[], rowCount: rows.length };
}

function marker(sql: string): string {
  const match = /execution-store-postgres:([a-z-]+)/.exec(sql);
  if (match === null) throw new Error("Unexpected SQL without an operation marker");
  return match[1]!;
}

class FakePostgresExecutor implements PostgresExecutor {
  public readonly calls: string[] = [];
  public readonly idempotency = new Map<string, StoredRow>();
  public readonly audit = new Map<string, StoredRow>();

  public async transaction<T>(work: (transaction: PostgresTransaction) => Promise<T>): Promise<T> {
    this.calls.push("transaction:start");
    try {
      const result = await work(this);
      this.calls.push("transaction:commit");
      return result;
    } catch (error) {
      this.calls.push("transaction:rollback");
      throw error;
    }
  }

  public async query<Row>(sql: string, params: readonly unknown[]): Promise<PostgresQueryResult<Row>> {
    const operation = marker(sql);
    this.calls.push(`query:${operation}`);
    if (operation === "claim-insert") {
      const key = this.idempotencyKey(params[0], params[1], params[2]);
      if (this.idempotency.has(key)) return queryResult<Row>([]);
      const row = this.idempotencyRow(params);
      this.idempotency.set(key, row);
      return queryResult<Row>([row]);
    }
    if (operation === "claim-select-existing" || operation === "outcome-select") {
      const row = this.idempotency.get(this.idempotencyKey(params[0], params[1], params[2]));
      return queryResult<Row>(row === undefined ? [] : [row]);
    }
    if (operation === "read") {
      const rows = [...this.idempotency.values()].filter(
        (row) => row["adapter_id"] === params[0] && row["idempotency_key"] === params[1],
      ).slice(0, 2);
      return queryResult<Row>(rows);
    }
    if (operation === "outcome-update") {
      const key = this.idempotencyKey(params[0], params[1], params[2]);
      const current = this.idempotency.get(key);
      if (
        current === undefined
        || current["execution_attempt_id"] !== params[3]
        || current["operation"] !== params[4]
        || current["request_fingerprint"] !== params[5]
        || (current["updated_at_ms"] as number) > (params[7] as number)
        || (current["adapter_order_id"] !== null
          && params[8] !== null
          && current["adapter_order_id"] !== params[8])
      ) return queryResult<Row>([]);
      const updated: StoredRow = {
        ...current,
        status: params[6],
        updated_at_ms: params[7],
        adapter_order_id: current["adapter_order_id"] ?? params[8],
      };
      this.idempotency.set(key, updated);
      return queryResult<Row>([updated]);
    }
    if (operation === "audit-insert") {
      const key = this.auditKey(params[2], params[3], params[0]);
      if (this.audit.has(key)) return queryResult<Row>([]);
      const row: StoredRow = {
        event_id: params[0],
        occurred_at_ms: params[1],
        adapter_id: params[2],
        environment: params[3],
        execution_attempt_id: params[4],
        operation: params[5],
        idempotency_key: params[6],
        outcome: params[7],
        adapter_order_id: params[8],
        normalized_failure_category: params[9],
      };
      this.audit.set(key, row);
      return queryResult<Row>([row]);
    }
    if (operation === "audit-select-existing") {
      const row = this.audit.get(this.auditKey(params[0], params[1], params[2]));
      return queryResult<Row>(row === undefined ? [] : [row]);
    }
    throw new Error(`Unhandled fake SQL operation: ${operation}`);
  }

  private idempotencyKey(adapterId: unknown, environment: unknown, key: unknown): string {
    return JSON.stringify([adapterId, environment, key]);
  }

  private auditKey(adapterId: unknown, environment: unknown, eventId: unknown): string {
    return JSON.stringify([adapterId, environment, eventId]);
  }

  private idempotencyRow(params: readonly unknown[]): StoredRow {
    return {
      adapter_id: params[0],
      environment: params[1],
      idempotency_key: params[2],
      execution_attempt_id: params[3],
      operation: params[4],
      request_fingerprint: params[5],
      status: params[6],
      created_at_ms: params[7],
      updated_at_ms: params[8],
      adapter_order_id: params[9],
    };
  }
}

const fingerprint = "fingerprint-1" as RequestFingerprint;

function claimInput(overrides: Partial<IdempotencyClaimInput> = {}): IdempotencyClaimInput {
  return {
    adapterId: brokerAdapterId("adapter-one"),
    environment: "SANDBOX",
    idempotencyKey: "key-one",
    executionAttemptId: "attempt-one",
    operation: "ENTRY_SUBMISSION",
    requestFingerprint: fingerprint,
    claimedAt: unixMs(100),
    ...overrides,
  };
}

function auditEvent(overrides: Partial<BrokerAuditEvent> = {}): BrokerAuditEvent {
  return createBrokerAuditEvent({
    eventId: "event-one",
    occurredAt: 200,
    adapterId: "adapter-one",
    environment: "SANDBOX",
    executionAttemptId: "attempt-one",
    operation: "ENTRY_SUBMISSION",
    idempotencyKey: "key-one",
    outcome: "SUBMITTED",
    ...overrides,
  });
}

describe("PostgresIdempotencyRepository claim", () => {
  it("creates a new claim with insert as the first query", async () => {
    const executor = new FakePostgresExecutor();
    const result = await createPostgresIdempotencyRepository(executor).claim(claimInput());
    expect(result.status).toBe("CLAIMED_NEW");
    expect(result.record.status).toBe("CLAIMED");
    expect(Object.isFrozen(result.record)).toBe(true);
    expect(executor.calls).toEqual([
      "transaction:start",
      "query:claim-insert",
      "transaction:commit",
    ]);
  });

  it("returns an existing identical logical request after insert conflict", async () => {
    const executor = new FakePostgresExecutor();
    const repository = createPostgresIdempotencyRepository(executor);
    await repository.claim(claimInput());
    executor.calls.length = 0;
    const result = await repository.claim(claimInput());
    expect(result.status).toBe("EXISTING_SAME_REQUEST");
    expect(executor.calls).toEqual([
      "transaction:start",
      "query:claim-insert",
      "query:claim-select-existing",
      "transaction:commit",
    ]);
  });

  it.each([
    ["fingerprint", { requestFingerprint: "fingerprint-2" as RequestFingerprint }],
    ["execution attempt", { executionAttemptId: "attempt-two" }],
    ["operation", { operation: "ENTRY_CANCELLATION" as IdempotencyOperation }],
  ])("rejects the same durable key with a changed %s", async (_label, override) => {
    const executor = new FakePostgresExecutor();
    const repository = createPostgresIdempotencyRepository(executor);
    await repository.claim(claimInput());
    const result = await repository.claim(claimInput(override));
    expect(result).toMatchObject({ status: "CONFLICT", reason: "IDEMPOTENCY_CONFLICT" });
    expect(result.record.executionAttemptId).toBe("attempt-one");
  });

  it("keeps SANDBOX and LIVE in distinct durable namespaces", async () => {
    const executor = new FakePostgresExecutor();
    const repository = createPostgresIdempotencyRepository(executor);
    expect((await repository.claim(claimInput())).status).toBe("CLAIMED_NEW");
    expect((await repository.claim(claimInput({ environment: "LIVE" }))).status).toBe("CLAIMED_NEW");
    expect(executor.idempotency.size).toBe(2);
  });

  it("includes adapter ID in the durable namespace", async () => {
    const executor = new FakePostgresExecutor();
    const repository = createPostgresIdempotencyRepository(executor);
    expect((await repository.claim(claimInput())).status).toBe("CLAIMED_NEW");
    expect((await repository.claim(claimInput({ adapterId: brokerAdapterId("adapter-two") }))).status)
      .toBe("CLAIMED_NEW");
    expect(executor.idempotency.size).toBe(2);
  });

  it("models simultaneous identical claims as one new and one existing", async () => {
    const executor = new FakePostgresExecutor();
    const repository = createPostgresIdempotencyRepository(executor);
    const results = await Promise.all([repository.claim(claimInput()), repository.claim(claimInput())]);
    expect(results.map((result) => result.status)).toEqual(["CLAIMED_NEW", "EXISTING_SAME_REQUEST"]);
    expect(executor.idempotency.size).toBe(1);
  });
});

describe("PostgresIdempotencyRepository outcomes", () => {
  it("persists CLAIMED to SUBMITTED without changing logical identity and reloads it", async () => {
    const executor = new FakePostgresExecutor();
    const repository = createPostgresIdempotencyRepository(executor);
    const claimed = (await repository.claim(claimInput())).record;
    const submitted = await repository.recordOutcome({
      adapterId: claimed.adapterId,
      environment: claimed.environment,
      idempotencyKey: claimed.idempotencyKey,
      requestFingerprint: claimed.requestFingerprint,
      status: "SUBMITTED",
      updatedAt: unixMs(101),
    });
    const loaded = await repository.read(claimed.adapterId, claimed.idempotencyKey);
    expect(submitted).toMatchObject({
      status: "SUBMITTED",
      executionAttemptId: claimed.executionAttemptId,
      operation: claimed.operation,
      requestFingerprint: claimed.requestFingerprint,
      createdAt: claimed.createdAt,
    });
    expect(loaded).toEqual(submitted);
  });

  it.each<Exclude<IdempotencyRecordStatus, "CLAIMED">>([
    "SUBMITTED",
    "CONFIRMED",
    "REJECTED",
    "OUTCOME_UNKNOWN",
    "RETRY_AUTHORIZED",
    "FAILED_NOT_SUBMITTED",
  ])("persists the public %s status", async (status) => {
    const executor = new FakePostgresExecutor();
    const repository = createPostgresIdempotencyRepository(executor);
    const record = (await repository.claim(claimInput())).record;
    const updated = await repository.recordOutcome({
      adapterId: record.adapterId,
      environment: record.environment,
      idempotencyKey: record.idempotencyKey,
      requestFingerprint: record.requestFingerprint,
      status,
      updatedAt: unixMs(100),
    });
    expect(updated.status).toBe(status);
    expect(updated.updatedAt).toBe(100);
  });

  it("rejects backward time but permits an equal timestamp", async () => {
    const executor = new FakePostgresExecutor();
    const repository = createPostgresIdempotencyRepository(executor);
    const record = (await repository.claim(claimInput({ claimedAt: unixMs(200) }))).record;
    await expect(repository.recordOutcome({
      adapterId: record.adapterId,
      environment: record.environment,
      idempotencyKey: record.idempotencyKey,
      requestFingerprint: record.requestFingerprint,
      status: "SUBMITTED",
      updatedAt: unixMs(199),
    })).rejects.toMatchObject({ code: "MONOTONIC_TIME_VIOLATION" });
    expect((await repository.recordOutcome({
      adapterId: record.adapterId,
      environment: record.environment,
      idempotencyKey: record.idempotencyKey,
      requestFingerprint: record.requestFingerprint,
      status: "SUBMITTED",
      updatedAt: unixMs(200),
    })).updatedAt).toBe(200);
  });

  it("rejects a cross-environment outcome without mutating the SANDBOX row", async () => {
    const executor = new FakePostgresExecutor();
    const repository = createPostgresIdempotencyRepository(executor);
    const record = (await repository.claim(claimInput())).record;
    await expect(repository.recordOutcome({
      adapterId: record.adapterId,
      environment: "LIVE",
      idempotencyKey: record.idempotencyKey,
      requestFingerprint: record.requestFingerprint,
      status: "CONFIRMED",
      updatedAt: unixMs(101),
    })).rejects.toThrow("unclaimed");
    expect((await repository.read(record.adapterId, record.idempotencyKey))?.status).toBe("CLAIMED");
  });

  it("rejects fingerprint and optional immutable identity assertion changes", async () => {
    const executor = new FakePostgresExecutor();
    const repository = createPostgresIdempotencyRepository(executor);
    const record = (await repository.claim(claimInput())).record;
    const base = {
      adapterId: record.adapterId,
      environment: record.environment,
      idempotencyKey: record.idempotencyKey,
      requestFingerprint: record.requestFingerprint,
      status: "SUBMITTED" as const,
      updatedAt: unixMs(101),
    };
    await expect(repository.recordOutcome({
      ...base,
      requestFingerprint: "changed" as RequestFingerprint,
    })).rejects.toMatchObject({ code: "IMMUTABLE_IDENTITY_CONFLICT" });
    await expect(repository.recordOutcome({
      ...base,
      executionAttemptId: "changed",
    })).rejects.toMatchObject({ code: "IMMUTABLE_IDENTITY_CONFLICT" });
    await expect(repository.recordOutcome({
      ...base,
      operation: "ENTRY_CANCELLATION",
    })).rejects.toMatchObject({ code: "IMMUTABLE_IDENTITY_CONFLICT" });
  });

  it("sets an adapter order ID once and rejects replacement", async () => {
    const executor = new FakePostgresExecutor();
    const repository = createPostgresIdempotencyRepository(executor);
    const record = (await repository.claim(claimInput())).record;
    const base = {
      adapterId: record.adapterId,
      environment: record.environment,
      idempotencyKey: record.idempotencyKey,
      requestFingerprint: record.requestFingerprint,
      status: "CONFIRMED" as const,
    };
    await repository.recordOutcome({ ...base, updatedAt: unixMs(101), adapterOrderId: "A" });
    await expect(repository.recordOutcome({
      ...base,
      updatedAt: unixMs(102),
      adapterOrderId: "B",
    })).rejects.toMatchObject({ code: "ADAPTER_ORDER_ID_CONFLICT" });
    expect((await repository.read(record.adapterId, record.idempotencyKey))?.adapterOrderId).toBe("A");
  });

  it("rejects invalid persisted rows as corruption", async () => {
    const executor = new FakePostgresExecutor();
    const key = JSON.stringify(["adapter-one", "SANDBOX", "key-one"]);
    executor.idempotency.set(key, {
      adapter_id: "adapter-one",
      environment: "INVALID",
      idempotency_key: "key-one",
      execution_attempt_id: "attempt-one",
      operation: "ENTRY_SUBMISSION",
      request_fingerprint: fingerprint,
      status: "CLAIMED",
      created_at_ms: "100",
      updated_at_ms: "100",
      adapter_order_id: null,
    });
    await expect(
      createPostgresIdempotencyRepository(executor).read(brokerAdapterId("adapter-one"), "key-one"),
    ).rejects.toBeInstanceOf(PersistenceCorruptionError);
  });
});

describe("PostgresBrokerAuditSink", () => {
  it("appends a sanitized event without mutating the caller object", async () => {
    const executor = new FakePostgresExecutor();
    const sink = createPostgresBrokerAuditSink(executor);
    const event = Object.freeze({
      ...auditEvent(),
      credentialProfileRef: "must-not-persist",
    }) as BrokerAuditEvent;
    const before = JSON.stringify(event);
    await sink.append(event);
    expect(executor.audit.size).toBe(1);
    expect(JSON.stringify(event)).toBe(before);
    expect([...executor.audit.values()][0]).not.toHaveProperty("credentialProfileRef");
    expect(JSON.stringify([...executor.audit.values()][0])).not.toContain("must-not-persist");
    expect(executor.calls).not.toContain("query:audit-update");
    expect(executor.calls).not.toContain("query:audit-delete");
  });

  it("treats an identical duplicate as idempotent success", async () => {
    const executor = new FakePostgresExecutor();
    const sink = createPostgresBrokerAuditSink(executor);
    await sink.append(auditEvent());
    await expect(sink.append(auditEvent())).resolves.toBeUndefined();
    expect(executor.audit.size).toBe(1);
    expect(executor.calls).toContain("query:audit-select-existing");
  });

  it("rejects a duplicate namespaced event ID with different payload", async () => {
    const executor = new FakePostgresExecutor();
    const sink = createPostgresBrokerAuditSink(executor);
    await sink.append(auditEvent());
    await expect(sink.append(auditEvent({ outcome: "CONFIRMED" })))
      .rejects.toBeInstanceOf(PersistenceConflictError);
  });

  it("keeps the same audit event ID distinct across SANDBOX and LIVE", async () => {
    const executor = new FakePostgresExecutor();
    const sink = createPostgresBrokerAuditSink(executor);
    await sink.append(auditEvent());
    await sink.append(auditEvent({ environment: "LIVE" }));
    expect(executor.audit.size).toBe(2);
  });

  it("exposes append only", () => {
    const sink = createPostgresBrokerAuditSink(new FakePostgresExecutor());
    expect(Object.getOwnPropertyNames(Object.getPrototypeOf(sink))).toEqual(["constructor", "append"]);
    expect("update" in sink).toBe(false);
    expect("delete" in sink).toBe(false);
  });
});

describe("execution store migration", () => {
  const migrationPath = fileURLToPath(
    new URL("../migrations/0001_execution_store.sql", import.meta.url),
  );
  const sql = readFileSync(migrationPath, "utf8");

  it("binds idempotency and audit uniqueness to adapter and environment", () => {
    expect(sql).toContain("PRIMARY KEY (adapter_id, environment, idempotency_key)");
    expect(sql).toContain("PRIMARY KEY (adapter_id, environment, event_id)");
  });

  it("uses explicit core columns and no generated current time", () => {
    for (const column of [
      "execution_attempt_id",
      "operation",
      "request_fingerprint",
      "created_at_ms",
      "updated_at_ms",
      "occurred_at_ms",
      "outcome",
    ]) expect(sql).toContain(column);
    expect(sql).not.toMatch(/\bNOW\s*\(/i);
    expect(sql).not.toMatch(/CURRENT_TIMESTAMP/i);
  });

  it("defines no credential or authentication columns", () => {
    expect(sql).not.toMatch(
      /api_key|api_secret|secret_key|password|authorization_header|private_key|access_token|refresh_token/i,
    );
  });
});
