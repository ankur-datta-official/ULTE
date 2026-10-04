import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  orchestrationFenceToken, orchestrationLeaseDurationMs, orchestrationLeaseOwnerId,
  orchestrationSessionId,
} from "@ulte/orchestration-state-store";
import {
  assertActiveRecoveryLeaseInTransaction,
  PersistenceConflictError, PersistenceCorruptionError, PersistenceInfrastructureError,
  PostgresOrchestrationRecoveryLeaseStore,
  type PostgresExecutor, type PostgresQueryResult, type PostgresTransaction,
} from "./index.js";

type Row = Record<string, unknown>;
const sessionId = orchestrationSessionId("session-1");
const ownerA = orchestrationLeaseOwnerId("owner-a");
const ownerB = orchestrationLeaseOwnerId("owner-b");
const duration = orchestrationLeaseDurationMs(100);
const request = Object.freeze({ sessionId, ownerId: ownerA, leaseDurationMs: duration });

function result<T>(rows: readonly Row[]): PostgresQueryResult<T> {
  return { rows: rows as readonly T[], rowCount: rows.length };
}

class FakePostgres implements PostgresExecutor {
  public now = 1_000;
  public lease: Row | null = null;
  public state: Row | null = null;
  public readonly calls: string[] = [];
  public failQuery = false;
  public failMutation = false;
  public failStateFence = false;
  public corruptLeaseReturn = false;
  public nowOnLeaseLock: number | null = null;
  private tail: Promise<void> = Promise.resolve();

  public async transaction<T>(work: (transaction: PostgresTransaction) => Promise<T>): Promise<T> {
    let unlock!: () => void;
    const previous = this.tail;
    this.tail = new Promise<void>((resolve) => { unlock = resolve; });
    await previous;
    const beforeLease = this.lease === null ? null : { ...this.lease };
    const beforeState = this.state === null ? null : { ...this.state };
    try {
      const value = await work(this);
      this.calls.push("commit");
      return value;
    } catch (error) {
      this.lease = beforeLease;
      this.state = beforeState;
      this.calls.push("rollback");
      throw error;
    } finally {
      unlock();
    }
  }

  public async query<T>(sql: string, params: readonly unknown[]): Promise<PostgresQueryResult<T>> {
    if (this.failQuery) throw new Error("database unavailable");
    const marker = /orchestration-state-store-postgres:([a-z-]+)/.exec(sql)?.[1];
    this.calls.push(String(marker));
    if (marker === "lease-clock") {
      expect(sql).toContain("clock_timestamp()");
      expect(params).toEqual([]);
      return result<T>([{ now_ms: String(this.now) }]);
    }
    if (marker === "lease-insert") {
      expect(sql).toContain("ON CONFLICT (session_id) DO NOTHING");
      if (this.lease !== null) return result<T>([]);
      this.lease = { session_id: params[0], owner_id: params[1], fence_token: "1", expires_at_ms: 0 };
      return result<T>([this.lease]);
    }
    if (marker === "lease-lock") {
      expect(sql).toContain("FOR UPDATE");
      if (this.nowOnLeaseLock !== null) this.now = this.nowOnLeaseLock;
      return result<T>(this.lease !== null && (this.corruptLeaseReturn || this.lease["session_id"] === params[0]) ? [this.lease] : []);
    }
    if (marker === "lease-state-lock") {
      expect(sql).toContain("FOR UPDATE");
      return result<T>(this.state !== null && this.state["session_id"] === params[0] ? [this.state] : []);
    }
    if (this.failMutation) return result<T>([]);
    if (marker === "lease-first-fence") {
      if (this.lease === null || this.lease["session_id"] !== params[0]
        || this.lease["owner_id"] !== params[1] || Number(this.lease["fence_token"]) !== 1
        || Number(this.lease["expires_at_ms"]) !== 0) return result<T>([]);
      this.lease = { ...this.lease, fence_token: params[2], expires_at_ms: params[3] };
      return result<T>([this.lease]);
    }
    if (marker === "lease-state-fence") {
      if (this.failStateFence) return result<T>([]);
      if (this.state === null || this.state["session_id"] !== params[0]
        || Number(this.state["fence_token"]) !== params[1]) return result<T>([]);
      this.state = { ...this.state, fence_token: params[2] };
      return result<T>([this.state]);
    }
    if (marker === "lease-acquire-update") {
      expect(sql).toContain("owner_id IS NOT DISTINCT FROM $3");
      expect(sql).toContain("expires_at_ms IS NOT DISTINCT FROM $4");
      if (this.lease === null || this.lease["session_id"] !== params[0]
        || Number(this.lease["fence_token"]) !== params[1]
        || this.lease["owner_id"] !== params[2]
        || this.lease["expires_at_ms"] !== params[3]
        || (this.lease["owner_id"] !== null && Number(this.lease["expires_at_ms"]) > Number(params[7]))) return result<T>([]);
      this.lease = { ...this.lease, owner_id: params[4], fence_token: params[5], expires_at_ms: params[6] };
      return result<T>([this.lease]);
    }
    if (marker === "lease-renew" || marker === "lease-release") {
      expect(sql).toContain("expires_at_ms > $4");
      if (this.lease === null || this.lease["session_id"] !== params[0]
        || this.lease["owner_id"] !== params[1]
        || Number(this.lease["fence_token"]) !== params[2]
        || Number(this.lease["expires_at_ms"]) <= Number(params[3])) return result<T>([]);
      this.lease = marker === "lease-renew"
        ? { ...this.lease, expires_at_ms: params[4] }
        : { ...this.lease, owner_id: null, expires_at_ms: null };
      return result<T>([this.lease]);
    }
    throw new Error(`Unexpected SQL operation: ${marker}`);
  }
}

function store(db: FakePostgres): PostgresOrchestrationRecoveryLeaseStore {
  return new PostgresOrchestrationRecoveryLeaseStore(db);
}

describe("PostgreSQL recovery lease store", () => {
  it("asserts the locked lease with a fresh database clock on each call", async () => {
    const db = new FakePostgres();
    const check = () => db.transaction((tx) => assertActiveRecoveryLeaseInTransaction(tx, {
      sessionId, ownerId: ownerA, expectedFence: orchestrationFenceToken(1) }));
    expect(await check()).toEqual({ status: "LEASE_LOST" });
    db.lease = { session_id: sessionId, owner_id: ownerA, fence_token: "1", expires_at_ms: "1100" };
    await db.transaction(async (tx) => {
      expect(await assertActiveRecoveryLeaseInTransaction(tx, {
        sessionId, ownerId: ownerA, expectedFence: orchestrationFenceToken(1) })).toEqual({ status: "ACTIVE" });
      db.now = 1_100;
      expect(await assertActiveRecoveryLeaseInTransaction(tx, {
        sessionId, ownerId: ownerA, expectedFence: orchestrationFenceToken(1) })).toEqual({ status: "LEASE_LOST" });
    });
    db.now = 1_000;
    expect(await db.transaction((tx) => assertActiveRecoveryLeaseInTransaction(tx, {
      sessionId, ownerId: ownerB, expectedFence: orchestrationFenceToken(1) }))).toEqual({ status: "LEASE_LOST" });
    expect(await db.transaction((tx) => assertActiveRecoveryLeaseInTransaction(tx, {
      sessionId, ownerId: ownerA, expectedFence: orchestrationFenceToken(2) }))).toEqual({ status: "FENCE_CONFLICT" });
    db.lease = { ...db.lease, owner_id: null, expires_at_ms: null };
    expect(await check()).toEqual({ status: "LEASE_LOST" });
    expect(db.calls.filter((call) => call === "lease-clock")).toHaveLength(5);
  });

  it("acquires the first lease at fence one using DB time and leaves input unchanged", async () => {
    const db = new FakePostgres();
    const original = structuredClone(request);
    expect(await store(db).acquireRecoveryLease(request)).toEqual({ status: "ACQUIRED", lease: {
      sessionId, ownerId: ownerA, fenceToken: 1, expiresAt: 1_100,
    } });
    expect(request).toEqual(original);
    expect(db.calls).toContain("lease-insert");
    expect(db.calls).not.toContain("lease-acquire-update");
  });

  it("starts above a pre-existing recovery fence and preserves revision", async () => {
    const db = new FakePostgres();
    db.state = { session_id: sessionId, fence_token: "7", revision: "5" };
    const acquired = await store(db).acquireRecoveryLease(request);
    expect(acquired.status).toBe("ACQUIRED");
    if (acquired.status === "ACQUIRED") expect(acquired.lease.fenceToken).toBe(8);
    expect(db.lease?.["fence_token"]).toBe(8);
    expect(db.state).toEqual({ session_id: sessionId, fence_token: 8, revision: "5" });
  });

  it("serializes simultaneous first acquisition through a unique insert", async () => {
    const db = new FakePostgres();
    const [first, second] = await Promise.all([
      store(db).acquireRecoveryLease(request),
      store(db).acquireRecoveryLease({ ...request, ownerId: ownerB }),
    ]);
    expect(first.status).toBe("ACQUIRED");
    expect(second).toEqual({ status: "HELD_BY_OTHER", expiresAt: 1_100 });
    expect(db.calls.filter((call) => call === "lease-insert")).toHaveLength(2);
    expect(db.calls.filter((call) => call === "lease-state-fence")).toHaveLength(0);
  });

  it("keeps active same-owner acquisition unchanged and reports another holder", async () => {
    const db = new FakePostgres();
    const leaseStore = store(db);
    await leaseStore.acquireRecoveryLease(request);
    db.now = 1_050;
    const before = { ...db.lease };
    expect(await leaseStore.acquireRecoveryLease(request)).toEqual({ status: "ACQUIRED", lease: {
      sessionId, ownerId: ownerA, fenceToken: 1, expiresAt: 1_100,
    } });
    expect(await leaseStore.acquireRecoveryLease({ ...request, ownerId: ownerB }))
      .toEqual({ status: "HELD_BY_OTHER", expiresAt: 1_100 });
    expect(db.lease).toEqual(before);
    expect(db.calls).not.toContain("lease-acquire-update");
  });

  it("takes over at expiry, increments fence, synchronizes state, and leaves revision alone", async () => {
    const db = new FakePostgres();
    const leaseStore = store(db);
    await leaseStore.acquireRecoveryLease(request);
    db.state = { session_id: sessionId, fence_token: "1", revision: "9" };
    db.now = 1_100;
    const acquired = await leaseStore.acquireRecoveryLease({ ...request, ownerId: ownerB });
    expect(acquired).toEqual({ status: "ACQUIRED", lease: {
      sessionId, ownerId: ownerB, fenceToken: 2, expiresAt: 1_200,
    } });
    expect(db.state).toEqual({ session_id: sessionId, fence_token: 2, revision: "9" });
    expect(await leaseStore.renewRecoveryLease({ ...request, expectedFence: orchestrationFenceToken(1) }))
      .toEqual({ status: "LEASE_LOST" });
  });

  it("treats expiry for the same owner as a new acquisition", async () => {
    const db = new FakePostgres();
    const leaseStore = store(db);
    await leaseStore.acquireRecoveryLease(request);
    db.now = 1_100;
    const acquired = await leaseStore.acquireRecoveryLease(request);
    expect(acquired.status).toBe("ACQUIRED");
    if (acquired.status === "ACQUIRED") expect(acquired.lease.fenceToken).toBe(2);
  });

  it("renews with the same fence from DB time and rejects wrong owner, stale fence, and expiry", async () => {
    const db = new FakePostgres();
    const leaseStore = store(db);
    await leaseStore.acquireRecoveryLease(request);
    db.now = 1_050;
    expect(await leaseStore.renewRecoveryLease({ ...request, expectedFence: orchestrationFenceToken(1) }))
      .toEqual({ status: "RENEWED", lease: { sessionId, ownerId: ownerA, fenceToken: 1, expiresAt: 1_150 } });
    expect(await leaseStore.renewRecoveryLease({ ...request, ownerId: ownerB, expectedFence: orchestrationFenceToken(1) }))
      .toEqual({ status: "LEASE_LOST" });
    expect(await leaseStore.renewRecoveryLease({ ...request, expectedFence: orchestrationFenceToken(2) }))
      .toEqual({ status: "LEASE_LOST" });
    db.now = 1_150;
    expect(await leaseStore.renewRecoveryLease({ ...request, expectedFence: orchestrationFenceToken(1) }))
      .toEqual({ status: "LEASE_LOST" });
    expect(db.lease?.["expires_at_ms"]).toBe(1_150);
  });

  it("reads DB time after locking so a wait cannot resurrect an expired lease", async () => {
    const db = new FakePostgres();
    const leaseStore = store(db);
    await leaseStore.acquireRecoveryLease(request);
    db.now = 1_050;
    db.nowOnLeaseLock = 1_100;
    expect(await leaseStore.renewRecoveryLease({ ...request, expectedFence: orchestrationFenceToken(1) }))
      .toEqual({ status: "LEASE_LOST" });
    const acquired = await leaseStore.acquireRecoveryLease({ ...request, ownerId: ownerB });
    expect(acquired.status).toBe("ACQUIRED");
    if (acquired.status === "ACQUIRED") expect(acquired.lease.expiresAt).toBe(1_200);
  });

  it("releases durably, reports missing/already released, and bumps fence on reacquire", async () => {
    const db = new FakePostgres();
    const leaseStore = store(db);
    const release = { sessionId, ownerId: ownerA, expectedFence: orchestrationFenceToken(1) };
    expect(await leaseStore.releaseRecoveryLease(release)).toEqual({ status: "NOT_HELD" });
    await leaseStore.acquireRecoveryLease(request);
    expect(await leaseStore.releaseRecoveryLease({ ...release, ownerId: ownerB })).toEqual({ status: "LEASE_LOST" });
    expect(await leaseStore.releaseRecoveryLease({ ...release, expectedFence: orchestrationFenceToken(2) }))
      .toEqual({ status: "LEASE_LOST" });
    expect(await leaseStore.releaseRecoveryLease(release)).toEqual({ status: "RELEASED" });
    expect(db.lease).toEqual({ session_id: sessionId, owner_id: null, fence_token: 1, expires_at_ms: null });
    expect(await leaseStore.releaseRecoveryLease(release)).toEqual({ status: "NOT_HELD" });
    const acquired = await leaseStore.acquireRecoveryLease(request);
    expect(acquired.status).toBe("ACQUIRED");
    if (acquired.status === "ACQUIRED") expect(acquired.lease.fenceToken).toBe(2);
  });

  it("rejects release after expiry", async () => {
    const db = new FakePostgres();
    const leaseStore = store(db);
    await leaseStore.acquireRecoveryLease(request);
    db.now = 1_100;
    expect(await leaseStore.releaseRecoveryLease({ sessionId, ownerId: ownerA, expectedFence: orchestrationFenceToken(1) }))
      .toEqual({ status: "LEASE_LOST" });
  });

  it("fails closed on fence overflow in first migration and takeover", async () => {
    const db = new FakePostgres();
    db.state = { session_id: sessionId, fence_token: String(Number.MAX_SAFE_INTEGER), revision: 0 };
    await expect(store(db).acquireRecoveryLease(request)).rejects.toMatchObject({ code: "LEASE_FENCE_OVERFLOW" });
    expect(db.lease).toBeNull();
    db.state = null;
    db.lease = { session_id: sessionId, owner_id: null,
      fence_token: String(Number.MAX_SAFE_INTEGER), expires_at_ms: null };
    await expect(store(db).acquireRecoveryLease(request)).rejects.toThrow(PersistenceConflictError);
  });

  it("rejects malformed lease and clock values", async () => {
    const db = new FakePostgres();
    const leaseStore = store(db);
    db.lease = { session_id: sessionId, owner_id: ownerA, fence_token: "1", expires_at_ms: "1100" };
    for (const change of [
      { fence_token: "01" }, { fence_token: "-1" }, { fence_token: 1.5 },
      { fence_token: "9007199254740992" }, { owner_id: " owner-a" },
      { expires_at_ms: "01" }, { expires_at_ms: "9007199254740992" },
      { expires_at_ms: null }, { session_id: " session-1" },
    ]) {
      const original = db.lease;
      db.lease = { ...original, ...change };
      db.corruptLeaseReturn = "session_id" in change;
      await expect(leaseStore.acquireRecoveryLease(request)).rejects.toThrow(PersistenceCorruptionError);
      db.lease = original;
      db.corruptLeaseReturn = false;
    }
    db.now = Number.MAX_SAFE_INTEGER + 1;
    await expect(leaseStore.acquireRecoveryLease(request)).rejects.toThrow(PersistenceCorruptionError);
    db.now = Number.MAX_SAFE_INTEGER;
    await expect(leaseStore.acquireRecoveryLease(request)).rejects.toThrow(PersistenceCorruptionError);
  });

  it("rejects lease/recovery mismatch and impossible conditional mutations", async () => {
    const db = new FakePostgres();
    const leaseStore = store(db);
    await leaseStore.acquireRecoveryLease(request);
    db.state = { session_id: sessionId, fence_token: 7, revision: 4 };
    await expect(leaseStore.acquireRecoveryLease(request)).rejects.toThrow(PersistenceCorruptionError);
    await expect(leaseStore.renewRecoveryLease({ ...request, expectedFence: orchestrationFenceToken(1) }))
      .rejects.toThrow(PersistenceCorruptionError);
    await expect(leaseStore.releaseRecoveryLease({ sessionId, ownerId: ownerA, expectedFence: orchestrationFenceToken(1) }))
      .rejects.toThrow(PersistenceCorruptionError);
    db.state = null;
    db.failMutation = true;
    await expect(leaseStore.renewRecoveryLease({ ...request, expectedFence: orchestrationFenceToken(1) }))
      .rejects.toThrow(PersistenceCorruptionError);
    await expect(leaseStore.releaseRecoveryLease({ sessionId, ownerId: ownerA, expectedFence: orchestrationFenceToken(1) }))
      .rejects.toThrow(PersistenceCorruptionError);
    db.now = 1_100;
    await expect(leaseStore.acquireRecoveryLease(request)).rejects.toThrow(PersistenceCorruptionError);
    expect(db.lease?.["fence_token"]).toBe(1);
  });

  it("rolls back a takeover when recovery fence synchronization fails", async () => {
    const db = new FakePostgres();
    const leaseStore = store(db);
    await leaseStore.acquireRecoveryLease(request);
    db.state = { session_id: sessionId, fence_token: 1, revision: 3 };
    db.now = 1_100;
    db.failStateFence = true;
    await expect(leaseStore.acquireRecoveryLease({ ...request, ownerId: ownerB }))
      .rejects.toThrow(PersistenceCorruptionError);
    expect(db.lease).toEqual({ session_id: sessionId, owner_id: ownerA, fence_token: 1, expires_at_ms: 1_100 });
    expect(db.state).toEqual({ session_id: sessionId, fence_token: 1, revision: 3 });
    expect(db.calls).toContain("rollback");
  });

  it("wraps infrastructure errors explicitly", async () => {
    const db = new FakePostgres();
    db.failQuery = true;
    await expect(store(db).acquireRecoveryLease(request)).rejects.toThrow(PersistenceInfrastructureError);
  });
});

describe("recovery lease migration", () => {
  const sql = readFileSync(fileURLToPath(new URL("../migrations/0002_orchestration_recovery_lease.sql", import.meta.url)), "utf8");
  const original = readFileSync(fileURLToPath(new URL("../migrations/0001_orchestration_recovery_state.sql", import.meta.url)), "utf8");
  it("bounds canonical durable rows and guards direct fence regression", () => {
    expect(sql).toContain("CREATE TABLE orchestration_recovery_lease");
    expect(sql).toContain("PRIMARY KEY (session_id)");
    expect(sql).toContain("session_id !~ '^[[:space:]]|[[:space:]]$'");
    expect(sql).toContain("owner_id !~ '^[[:space:]]|[[:space:]]$'");
    expect(sql).toContain("fence_token BETWEEN 1 AND 9007199254740991");
    expect(sql).toContain("expires_at_ms BETWEEN 0 AND 9007199254740991");
    expect(sql).toContain("(owner_id IS NULL) = (expires_at_ms IS NULL)");
    expect(sql).toContain("NEW.fence_token < OLD.fence_token");
    expect(sql).toContain("NEW.fence_token <= OLD.fence_token");
    expect(sql).toContain("BEFORE UPDATE ON orchestration_recovery_lease");
    expect(sql).not.toMatch(/random_uuid|gen_random_uuid|created_at|updated_at|REFERENCES orchestration_recovery_state/i);
    expect(original).toContain("CREATE TABLE orchestration_recovery_state");
  });
});
