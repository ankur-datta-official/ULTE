import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createInstrumentId } from "@ulte/instrument-model";
import {
  orchestrationFenceToken,
  orchestrationRevision,
  orchestrationSessionId,
  type OrchestrationRecoveryWrite,
} from "@ulte/orchestration-state-store";
import {
  PersistenceConflictError,
  PersistenceCorruptionError,
  PostgresOrchestrationRecoveryStore,
  saveRecoveryStateInTransaction,
  type PostgresExecutor,
  type PostgresQueryResult,
  type PostgresTransaction,
} from "./index.js";

type Row = Record<string, unknown>;
const instrument = createInstrumentId({ venue: "TEST", venueSymbol: "ONE", instrumentKind: "SPOT" });
const sessionId = orchestrationSessionId("session-1");

function write(revision = 0, fence = 7, full = false): OrchestrationRecoveryWrite {
  return {
    sessionId, expectedRevision: orchestrationRevision(revision), expectedFence: orchestrationFenceToken(fence),
    state: {
      mode: "SANDBOX", instrumentId: instrument,
      executionAuthorityCheckpointRef: full ? "checkpoint-1" as OrchestrationRecoveryWrite["state"]["executionAuthorityCheckpointRef"] : null,
      executionAuthorityIdentity: full ? {
        executionAttemptId: "attempt-1", executionPlanId: "plan-1", tradeIntentId: "intent-1",
        candidateId: "candidate-1", instrumentId: instrument,
      } : null,
      riskBasisCheckpointRef: full ? "risk-1" as OrchestrationRecoveryWrite["state"]["riskBasisCheckpointRef"] : null,
      latestROutcomeRef: full ? "r-1" as OrchestrationRecoveryWrite["state"]["latestROutcomeRef"] : null,
    },
  };
}

function result<T>(rows: readonly Row[]): PostgresQueryResult<T> {
  return { rows: rows as readonly T[], rowCount: rows.length };
}

class FakePostgres implements PostgresExecutor {
  public row: Row | null = null;
  public readonly calls: string[] = [];
  public failUpdate = false;
  public failQuery = false;
  public corruptReturn = false;
  public updateSql = "";

  public async transaction<T>(work: (transaction: PostgresTransaction) => Promise<T>): Promise<T> {
    this.calls.push("transaction:start");
    const before = this.row === null ? null : { ...this.row };
    try {
      const value = await work(this);
      this.calls.push("transaction:commit");
      return value;
    } catch (error) {
      this.row = before;
      this.calls.push("transaction:rollback");
      throw error;
    }
  }

  public async query<T>(sql: string, params: readonly unknown[]): Promise<PostgresQueryResult<T>> {
    if (this.failQuery) throw new Error("database unavailable");
    const marker = /orchestration-state-store-postgres:([a-z-]+)/.exec(sql)?.[1];
    this.calls.push(`query:${marker}`);
    if (marker === "load" || marker === "select-for-update") {
      if (marker === "select-for-update") expect(sql).toContain("FOR UPDATE");
      return result<T>(this.row !== null && this.row["session_id"] === params[0] ? [this.row] : []);
    }
    if (marker === "initialize-insert") {
      expect(sql).toContain("ON CONFLICT (session_id) DO NOTHING");
      if (this.row !== null) return result<T>([]);
      this.row = this.fromValues(params);
      return result<T>([this.row]);
    }
    if (marker === "save-update") {
      this.updateSql = sql;
      expect(sql).toMatch(/WHERE session_id = \$1 AND revision = \$2 AND fence_token = \$3/);
      if (this.failUpdate || this.row === null || this.row["session_id"] !== params[0]
        || Number(this.row["revision"]) !== params[1] || Number(this.row["fence_token"]) !== params[2]) {
        return result<T>([]);
      }
      this.row = { ...this.row, revision: params[3], mode: params[4], instrument_id: params[5],
        execution_authority_checkpoint_ref: params[6], execution_attempt_id: params[7],
        execution_plan_id: params[8], trade_intent_id: params[9], candidate_id: params[10],
        execution_instrument_id: params[11], risk_basis_checkpoint_ref: params[12],
        latest_r_outcome_ref: params[13] };
      return result<T>([this.corruptReturn ? { ...this.row, schema_version: "UNSUPPORTED" } : this.row]);
    }
    throw new Error(`Unexpected SQL operation: ${marker}`);
  }

  private fromValues(params: readonly unknown[]): Row {
    const keys = ["schema_version", "session_id", "revision", "fence_token", "mode", "instrument_id",
      "execution_authority_checkpoint_ref", "execution_attempt_id", "execution_plan_id", "trade_intent_id",
      "candidate_id", "execution_instrument_id", "risk_basis_checkpoint_ref", "latest_r_outcome_ref"];
    return Object.fromEntries(keys.map((key, index) => [key, params[index]]));
  }
}

describe("Postgres orchestration recovery store", () => {
  it("shares one CAS implementation with caller-owned transactions and rolls back outer failures", async () => {
    const db = new FakePostgres(), store = new PostgresOrchestrationRecoveryStore(db);
    await store.initializeRecoveryState(write());
    await expect(db.transaction(async (tx) => {
      expect((await saveRecoveryStateInTransaction(tx, write())).status).toBe("SAVED");
      throw new Error("outer rollback");
    })).rejects.toThrow("outer rollback");
    expect(db.row?.["revision"]).toBe(0);
    expect((await db.transaction((tx) => saveRecoveryStateInTransaction(tx, write()))).status).toBe("SAVED");
    expect(await db.transaction((tx) => saveRecoveryStateInTransaction(tx, write())))
      .toEqual({ status: "REVISION_CONFLICT", currentRevision: 1 });
    expect(await db.transaction((tx) => saveRecoveryStateInTransaction(tx, write(1, 8))))
      .toEqual({ status: "FENCE_CONFLICT", currentFence: 7 });
    db.row = null;
    expect(await db.transaction((tx) => saveRecoveryStateInTransaction(tx, write())))
      .toEqual({ status: "NOT_FOUND" });
    const source = readFileSync(fileURLToPath(new URL("./recovery-store.ts", import.meta.url)), "utf8");
    expect(source.match(/UPDATE orchestration_recovery_state/g)).toHaveLength(1);
    expect(source).toContain("saveRecoveryStateInTransaction(transaction, write)");
  });

  it("loads missing as null and returns NOT_FOUND on missing save", async () => {
    const db = new FakePostgres();
    const store = new PostgresOrchestrationRecoveryStore(db);
    expect(await store.loadRecoveryState(sessionId)).toBeNull();
    expect(await store.saveRecoveryState(write())).toEqual({ status: "NOT_FOUND" });
    expect(db.calls).toContain("query:select-for-update");
  });

  it("initializes revision zero without mutating input, then round-trips an empty session", async () => {
    const db = new FakePostgres();
    const store = new PostgresOrchestrationRecoveryStore(db);
    const input = write();
    const original = structuredClone(input);
    const saved = await store.initializeRecoveryState(input);
    expect(saved.status).toBe("SAVED");
    if (saved.status === "SAVED") expect(saved.newRevision).toBe(0);
    expect(await store.loadRecoveryState(sessionId)).toEqual(saved.status === "SAVED" ? saved.record : null);
    expect(input).toEqual(original);
    expect(db.row?.["fence_token"]).toBe(7);
  });

  it("classifies existing initialization by fence first and never overwrites", async () => {
    const db = new FakePostgres();
    const store = new PostgresOrchestrationRecoveryStore(db);
    await store.initializeRecoveryState(write());
    const original = { ...db.row };
    expect(await store.initializeRecoveryState(write())).toEqual({ status: "REVISION_CONFLICT", currentRevision: 0 });
    expect(await store.initializeRecoveryState(write(0, 8))).toEqual({ status: "FENCE_CONFLICT", currentFence: 7 });
    expect(db.row).toEqual(original);
    expect(() => store.initializeRecoveryState(write(1))).toThrow(RangeError);
  });

  it("saves twice with exact revision increments and preserves the fence and references", async () => {
    const db = new FakePostgres();
    const store = new PostgresOrchestrationRecoveryStore(db);
    await store.initializeRecoveryState(write());
    const input = write(0, 7, true);
    const original = structuredClone(input);
    const first = await store.saveRecoveryState(input);
    expect(first.status).toBe("SAVED");
    if (first.status === "SAVED") {
      expect(first.newRevision).toBe(1);
      expect(first.record.executionAuthorityIdentity).toEqual(input.state.executionAuthorityIdentity);
      expect(first.record.executionAuthorityCheckpointRef).toBe("checkpoint-1");
      expect(first.record.riskBasisCheckpointRef).toBe("risk-1");
      expect(first.record.latestROutcomeRef).toBe("r-1");
    }
    expect(input).toEqual(original);
    const second = await store.saveRecoveryState(write(1, 7, true));
    expect(second.status).toBe("SAVED");
    if (second.status === "SAVED") expect(second.newRevision).toBe(2);
    expect(db.row?.["fence_token"]).toBe(7);
    expect(db.updateSql).toContain("AND revision = $2 AND fence_token = $3");
  });

  it("rejects stale fence before stale revision and leaves the row unchanged", async () => {
    const db = new FakePostgres();
    const store = new PostgresOrchestrationRecoveryStore(db);
    await store.initializeRecoveryState(write());
    await store.saveRecoveryState(write());
    const original = { ...db.row };
    expect(await store.saveRecoveryState(write(0, 8))).toEqual({ status: "FENCE_CONFLICT", currentFence: 7 });
    expect(await store.saveRecoveryState(write(0, 7))).toEqual({ status: "REVISION_CONFLICT", currentRevision: 1 });
    expect(db.row).toEqual(original);
  });

  it("fails closed on malformed, unsupported, and unsafe BIGINT rows", async () => {
    const db = new FakePostgres();
    const store = new PostgresOrchestrationRecoveryStore(db);
    await store.initializeRecoveryState(write());
    for (const mutation of [
      { schema_version: "OLD" }, { mode: "LIVE" }, { revision: "01" },
      { revision: "9007199254740992" }, { fence_token: "-1" },
      { fence_token: Number.MAX_SAFE_INTEGER + 1 }, { execution_attempt_id: "orphan" },
    ]) {
      const original = db.row;
      db.row = { ...original, ...mutation };
      await expect(store.loadRecoveryState(sessionId)).rejects.toThrow(PersistenceCorruptionError);
      db.row = original;
    }
  });

  it("rejects revision overflow and impossible conditional update without claiming success", async () => {
    const db = new FakePostgres();
    const store = new PostgresOrchestrationRecoveryStore(db);
    await store.initializeRecoveryState(write());
    db.row = { ...db.row, revision: String(Number.MAX_SAFE_INTEGER) };
    await expect(store.saveRecoveryState(write(Number.MAX_SAFE_INTEGER))).rejects.toMatchObject({
      code: "REVISION_OVERFLOW",
    });
    db.row = { ...db.row, revision: 0 };
    db.failUpdate = true;
    await expect(store.saveRecoveryState(write())).rejects.toThrow(PersistenceConflictError);
    expect(db.row?.["revision"]).toBe(0);
  });

  it("propagates infrastructure errors and rejects corrupt RETURNING rows", async () => {
    const db = new FakePostgres();
    const store = new PostgresOrchestrationRecoveryStore(db);
    db.failQuery = true;
    await expect(store.loadRecoveryState(sessionId)).rejects.toThrow("database unavailable");
    db.failQuery = false;
    await store.initializeRecoveryState(write());
    db.corruptReturn = true;
    await expect(store.saveRecoveryState(write())).rejects.toThrow(PersistenceCorruptionError);
    expect(db.row?.["revision"]).toBe(0);
  });
});

describe("recovery migration", () => {
  const sql = readFileSync(fileURLToPath(new URL("../migrations/0001_orchestration_recovery_state.sql", import.meta.url)), "utf8");
  const source = readFileSync(fileURLToPath(new URL("./recovery-store.ts", import.meta.url)), "utf8");
  it("enforces Session V1 identity, bounds, dependencies and canonical references", () => {
    expect(sql).toContain("CREATE TABLE orchestration_recovery_state");
    expect(sql).toContain("PRIMARY KEY (session_id)");
    expect(sql).toContain("schema_version = 'ORCHESTRATION_RECOVERY_RECORD_V1'");
    expect(sql).toContain("revision BETWEEN 0 AND 9007199254740991");
    expect(sql).toContain("fence_token BETWEEN 1 AND 9007199254740991");
    expect(sql).toContain("mode IN ('DRY_RUN', 'SANDBOX')");
    expect(sql).toContain("execution_authority_checkpoint_ref IS NULL AND execution_attempt_id IS NULL");
    expect(sql).toContain("execution_authority_checkpoint_ref IS NOT NULL AND execution_attempt_id IS NOT NULL");
    expect(sql).toContain("execution_instrument_id = instrument_id");
    expect(sql).toContain("risk_basis_checkpoint_ref IS NULL OR execution_authority_checkpoint_ref IS NOT NULL");
    expect(sql).toContain("execution_authority_checkpoint_ref IS NOT NULL AND risk_basis_checkpoint_ref IS NOT NULL");
    for (const field of ["session_id", "execution_authority_checkpoint_ref", "execution_attempt_id",
      "execution_plan_id", "trade_intent_id", "candidate_id", "risk_basis_checkpoint_ref", "latest_r_outcome_ref"]) {
      expect(sql).toContain(`${field} !~ '^[[:space:]]|[[:space:]]$'`);
    }
    expect(sql).not.toMatch(/random_uuid|gen_random_uuid|\bnow\s*\(|CURRENT_TIMESTAMP/i);
    expect(source).not.toMatch(/ON CONFLICT DO UPDATE/i);
  });
});
