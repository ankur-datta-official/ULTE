import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createExecutionAuthorityCheckpoint, executionAuthorityCheckpointId,
  EXECUTION_AUTHORITY_CHECKPOINT_SCHEMA_VERSION } from "@ulte/orchestration-state-store";
import { checkpointEvidence } from "../../../tests/integration/phase33b-checkpoint-fixture.js";
import { mapCheckpointRow } from "./checkpoint-mapping.js";
import { appendExecutionAuthorityCheckpointInTransaction, PersistenceCorruptionError,
  PersistenceInfrastructureError, PostgresExecutionAuthorityCheckpointStore,
  type PostgresExecutor, type PostgresQueryResult, type PostgresTransaction } from "./index.js";

type Row = Record<string, unknown>;
const fields = ["schema_version", "checkpoint_ref", "evidence_schema_version", "execution_attempt_id",
  "execution_plan_id", "trade_intent_id", "candidate_id", "instrument_id", "evidence_payload"];
const ref = executionAuthorityCheckpointId("checkpoint-1");
function checkpoint(evidence: unknown = checkpointEvidence()) {
  return createExecutionAuthorityCheckpoint({ schemaVersion: EXECUTION_AUTHORITY_CHECKPOINT_SCHEMA_VERSION,
    checkpointRef: ref, evidence });
}
function row(value = checkpoint()): Row {
  const identity = value.evidence.identity;
  return Object.fromEntries(fields.map((field, index) => [field, [value.schemaVersion, value.checkpointRef,
    value.evidence.schemaVersion, identity.executionAttemptId, identity.executionPlanId,
    identity.tradeIntentId, identity.candidateId, identity.instrumentId, value.evidence][index]]));
}
function result<T>(rows: readonly Row[], rowCount = rows.length): PostgresQueryResult<T> {
  return { rows: rows as readonly T[], rowCount };
}
class FakePostgres implements PostgresExecutor {
  public rows = new Map<string, Row>();
  public calls: { sql: string; params: readonly unknown[] }[] = [];
  public impossible = false;
  public fail = false;
  public async transaction<T>(work: (transaction: PostgresTransaction) => Promise<T>): Promise<T> {
    const before = new Map(this.rows);
    try { return await work(this); }
    catch (error) { this.rows = before; throw error; }
  }
  public async query<T>(sql: string, params: readonly unknown[]): Promise<PostgresQueryResult<T>> {
    this.calls.push({ sql, params });
    if (this.fail) throw new Error("database unavailable");
    if (this.impossible) return result<T>([], 2);
    if (sql.includes("checkpoint:insert")) {
      const inserted = Object.fromEntries(fields.map((field, index) =>
        [field, field === "evidence_payload" ? JSON.parse(String(params[index])) : params[index]]));
      const key = String(inserted["checkpoint_ref"]);
      if (this.rows.has(key)) return result<T>([]);
      this.rows.set(key, inserted);
      return result<T>([inserted]);
    }
    if (sql.includes("checkpoint:load")) {
      const found = this.rows.get(String(params[0]));
      return result<T>(found === undefined ? [] : [found]);
    }
    throw new Error("Unexpected SQL");
  }
}

describe("PostgreSQL execution authority checkpoints", () => {
  it("loads missing as null, appends, round trips, and classifies exact repeat and changed evidence", async () => {
    const db = new FakePostgres(), store = new PostgresExecutionAuthorityCheckpointStore(db);
    expect(await store.loadExecutionAuthorityCheckpoint(ref)).toBeNull();
    const original = checkpoint();
    expect((await store.appendExecutionAuthorityCheckpoint(original)).status).toBe("APPENDED");
    expect(await store.loadExecutionAuthorityCheckpoint(ref)).toEqual(original);
    expect((await store.appendExecutionAuthorityCheckpoint(original)).status).toBe("DUPLICATE_SAME");
    const id = original.evidence.identity;
    const reordered = checkpoint({ transitions: original.evidence.transitions,
      initialization: original.evidence.initialization,
      identity: { instrumentId: id.instrumentId, candidateId: id.candidateId,
        tradeIntentId: id.tradeIntentId, executionPlanId: id.executionPlanId,
        executionAttemptId: id.executionAttemptId },
      schemaVersion: original.evidence.schemaVersion });
    expect((await store.appendExecutionAuthorityCheckpoint(reordered)).status).toBe("DUPLICATE_SAME");
    const requested = checkpoint(checkpointEvidence([{ kind: "ENTRY_SUBMISSION_REQUESTED", adapterCapabilities: {
      supportsClientIdempotency: false, supportsCloseOnlyExit: true,
      supportsNativeBracketProtection: false, supportsProtectionModification: true,
      supportsOrderCancellation: true, supportsPartialFillReporting: true,
    } }]));
    expect((await store.appendExecutionAuthorityCheckpoint(requested)).status).toBe("CHECKPOINT_CONFLICT");
    expect(db.calls.every(({ sql, params }) => !/UPDATE\s+orchestration_execution_authority_checkpoint/i.test(sql)
      && (sql.includes("checkpoint:insert") ? params.length === 9 && sql.includes("$9") : params.length === 1 && sql.includes("$1")))).toBe(true);
  });

  it("fails closed on malformed JSONB, unrestorable transitions, schemas, and every identity mismatch", () => {
    const valid = row();
    for (const bad of [
      { evidence_payload: [] },
      { evidence_payload: { ...valid["evidence_payload"] as object, transitions: [{ kind: "PROTECTION_REQUESTED" }] } },
      { schema_version: "OLD" }, { evidence_schema_version: "OLD" },
      { execution_attempt_id: "other" }, { execution_plan_id: "other" },
      { trade_intent_id: "other" }, { candidate_id: "other" }, { instrument_id: "other" },
    ]) expect(() => mapCheckpointRow({ ...valid, ...bad } as never)).toThrow(PersistenceCorruptionError);
  });

  it("rejects corrupt loaded rows and impossible driver counts", async () => {
    const db = new FakePostgres(), store = new PostgresExecutionAuthorityCheckpointStore(db);
    db.rows.set(ref, { ...row(), candidate_id: "other" });
    await expect(store.loadExecutionAuthorityCheckpoint(ref)).rejects.toBeInstanceOf(PersistenceCorruptionError);
    db.impossible = true;
    await expect(store.loadExecutionAuthorityCheckpoint(ref)).rejects.toBeInstanceOf(PersistenceCorruptionError);
    await expect(store.appendExecutionAuthorityCheckpoint(checkpoint())).rejects.toBeInstanceOf(PersistenceCorruptionError);
  });

  it("rolls back transaction scoped append with its caller and does not mutate the DTO", async () => {
    const db = new FakePostgres(), store = new PostgresExecutionAuthorityCheckpointStore(db);
    const value = checkpoint();
    await expect(db.transaction(async (tx) => {
      expect((await appendExecutionAuthorityCheckpointInTransaction(tx, value)).status).toBe("APPENDED");
      throw new Error("rollback");
    })).rejects.toThrow("rollback");
    expect(await store.loadExecutionAuthorityCheckpoint(ref)).toBeNull();
    expect(value).toEqual(checkpoint(value.evidence));
    expect(Object.isFrozen(value.evidence)).toBe(true);
  });

  it("wraps database failures as infrastructure errors", async () => {
    const db = new FakePostgres(), store = new PostgresExecutionAuthorityCheckpointStore(db);
    db.fail = true;
    await expect(store.loadExecutionAuthorityCheckpoint(ref)).rejects.toBeInstanceOf(PersistenceInfrastructureError);
    await expect(store.appendExecutionAuthorityCheckpoint(checkpoint())).rejects.toBeInstanceOf(PersistenceInfrastructureError);
  });

  it("migration 0004 is additive and constrains the checkpoint without a recovery FK", () => {
    const migration = readFileSync(fileURLToPath(new URL("../migrations/0004_execution_authority_checkpoint.sql", import.meta.url)), "utf8");
    expect(migration).toContain("CREATE TABLE orchestration_execution_authority_checkpoint");
    expect(migration).toMatch(/checkpoint_ref TEXT NOT NULL PRIMARY KEY/);
    expect(migration).toContain("schema_version = 'EXECUTION_AUTHORITY_CHECKPOINT_V1'");
    expect(migration).toContain("evidence_schema_version = 'EXECUTION_ATTEMPT_RECOVERY_EVIDENCE_V1'");
    for (const column of ["checkpoint_ref", "execution_attempt_id", "execution_plan_id",
      "trade_intent_id", "candidate_id"]) {
      expect(migration).toContain(`${column} <> '' AND ${column} !~ '^[[:space:]]|[[:space:]]$'`);
    }
    expect(migration).toContain("jsonb_typeof(evidence_payload) = 'object'");
    expect(migration).not.toMatch(/\b(?:UUID|random|NOW|CURRENT_TIMESTAMP|clock_timestamp|UPDATE|ALTER|REFERENCES)\b/i);
  });
});
