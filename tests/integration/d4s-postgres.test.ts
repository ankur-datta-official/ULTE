import { describe, expect, it } from "vitest";
import { B1fDatabase, LostCommitResponseError, bounded, deferred } from "./b1f-postgres-helper.js";

async function realTest(work: (db: B1fDatabase) => Promise<void>): Promise<void> {
  const db = await B1fDatabase.create();
  try { await db.proveConnections(); await work(db); }
  catch (error) {
    try { await db.dispose(); }
    catch (cleanupError) { throw new AggregateError([error, cleanupError], "D4S work and cleanup failed"); }
    throw error;
  }
  await db.dispose();
}

async function probe(db: B1fDatabase): Promise<void> {
  await db.a.query("CREATE TABLE d4s_snapshot_probe (id integer PRIMARY KEY, version integer NOT NULL)", []);
  await db.a.transaction(async (tx) => {
    await tx.query("INSERT INTO d4s_snapshot_probe (id, version) VALUES (1, 1)", []);
  });
}

describe("D4S pinned PostgreSQL snapshot", () => {
  it("fixes REPEATABLE READ READ ONLY before callback queries and preserves writer READ COMMITTED", () =>
    realTest(async (db) => {
      await probe(db);
      const writer = await db.a.transaction(async (tx) =>
        (await tx.query<{ isolation: string; read_only: string }>(
          "SELECT current_setting('transaction_isolation') AS isolation, current_setting('transaction_read_only') AS read_only", []
        )).rows[0]!);
      expect(writer).toEqual({ isolation: "read committed", read_only: "off" });
      await db.a.transaction(async (tx) => {
        await tx.query("UPDATE d4s_snapshot_probe SET version = 2 WHERE id = 1", []);
      });
      const snapshot = await db.b.snapshot(async (tx) => {
        const first = (await tx.query<{ pid: number; isolation: string; read_only: string;
          schema: string; paths_ok: boolean }>(`SELECT pg_backend_pid() AS pid,
            current_setting('transaction_isolation') AS isolation,
            current_setting('transaction_read_only') AS read_only,
            current_schema() AS schema,
            current_schemas(false) = ARRAY[current_schema(), 'pg_catalog'::name] AS paths_ok`, [])).rows[0]!;
        const second = (await tx.query<{ pid: number; version: number }>(
          "SELECT pg_backend_pid() AS pid, version FROM d4s_snapshot_probe WHERE id = 1", [])).rows[0]!;
        return { first, second };
      });
      expect(snapshot.first.isolation).toBe("repeatable read");
      expect(snapshot.first.read_only).toBe("on");
      expect(snapshot.first.paths_ok).toBe(true);
      expect(snapshot.first.schema).toMatch(/^b1f_[0-9a-f]{24}$/);
      expect(snapshot.second.pid).toBe(snapshot.first.pid);
      expect(snapshot.second.pid).toBe(db.b.lastTransactionPid);
      expect(snapshot.second.version).toBe(2);
    }));

  it("rejects writes and SELECT FOR UPDATE at the PostgreSQL server", () =>
    realTest(async (db) => {
      await probe(db);
      await expect(db.b.snapshot(async (tx) => {
        await tx.query("INSERT INTO d4s_snapshot_probe (id, version) VALUES (2, 1)", []);
      })).rejects.toMatchObject({ code: "25006" });
      await expect(db.b.snapshot(async (tx) => {
        await tx.query("SELECT version FROM d4s_snapshot_probe WHERE id = 1 FOR UPDATE", []);
      })).rejects.toMatchObject({ code: "25006" });
      const rows = await db.a.query<{ n: string }>("SELECT count(*)::text AS n FROM d4s_snapshot_probe", []);
      expect(rows.rows[0]?.n).toBe("1");
    }));

  it("holds one version across a distinct writer commit; a new snapshot sees the update", () =>
    realTest(async (db) => {
      await probe(db);
      const firstRead = deferred<{ pid: number; version: number }>();
      const continueRead = deferred();
      const b = db.b.snapshot(async (tx) => {
        const first = (await tx.query<{ pid: number; version: number }>(
          "SELECT pg_backend_pid() AS pid, version FROM d4s_snapshot_probe WHERE id = 1", [])).rows[0]!;
        firstRead.resolve(first);
        await bounded(continueRead.promise, "resume D4S snapshot");
        const second = (await tx.query<{ pid: number; version: number }>(
          "SELECT pg_backend_pid() AS pid, version FROM d4s_snapshot_probe WHERE id = 1", [])).rows[0]!;
        return { first, second };
      });
      try {
        const first = await bounded(firstRead.promise, "first D4S snapshot read");
        const aPid = await db.a.transaction(async (tx) => {
          const pid = (await tx.query<{ pid: number }>("SELECT pg_backend_pid() AS pid", [])).rows[0]!.pid;
          await tx.query("UPDATE d4s_snapshot_probe SET version = version + 1 WHERE id = 1", []);
          return pid;
        });
        expect(aPid).not.toBe(first.pid);
      } finally { continueRead.resolve(); }
      const result = await bounded(b, "complete D4S snapshot");
      expect(result.first.version).toBe(1);
      expect(result.second.version).toBe(1);
      expect(result.second.pid).toBe(result.first.pid);
      const fresh = await db.b.snapshot(async (tx) =>
        (await tx.query<{ version: number }>(
          "SELECT version FROM d4s_snapshot_probe WHERE id = 1", [])).rows[0]!.version);
      expect(fresh).toBe(2);
    }));

  it("rolls back callback errors, releases the client, and permits a clean checkout", () =>
    realTest(async (db) => {
      await probe(db);
      const failure = new Error("D4S callback failure");
      let failedPid: number | undefined;
      await expect(db.b.snapshot(async (tx) => {
        failedPid = (await tx.query<{ pid: number }>("SELECT pg_backend_pid() AS pid FROM d4s_snapshot_probe WHERE id = 1", [])).rows[0]!.pid;
        throw failure;
      })).rejects.toBe(failure);
      expect(db.pool.idleCount).toBe(db.pool.totalCount);
      const clean = await db.b.query<{ pid: number; isolation: string; read_only: string; version: number }>(
        `SELECT pg_backend_pid() AS pid, current_setting('transaction_isolation') AS isolation,
          current_setting('transaction_read_only') AS read_only, version
          FROM d4s_snapshot_probe WHERE id = 1`, []);
      expect(clean.rows[0]).toEqual({ pid: failedPid, isolation: "read committed", read_only: "off", version: 1 });
    }));

  it("preserves bounded query hooks on the pinned snapshot client", () =>
    realTest(async (db) => {
      await probe(db);
      const reached = deferred<number>();
      const resume = deferred();
      db.b.beforeQuery = async (marker) => {
        if (marker !== "checkpoint:load") return;
        reached.resolve(db.b.lastTransactionPid!);
        await resume.promise;
      };
      try {
        const read = db.b.snapshot(async (tx) =>
          (await tx.query<{ pid: number; version: number }>(
            "/* checkpoint:load */ SELECT pg_backend_pid() AS pid, version FROM d4s_snapshot_probe WHERE id = 1", [])
          ).rows[0]!);
        const pid = await bounded(reached.promise, "D4S snapshot query hook");
        resume.resolve();
        const result = await bounded(read, "D4S hooked snapshot read");
        expect(result).toEqual({ pid, version: 1 });
      } finally {
        resume.resolve();
        db.b.beforeQuery = undefined;
        db.b.afterQuery = undefined;
      }
    }));

  it("leaves lost-response and fail-COMMIT injection armed for ordinary writers", () =>
    realTest(async (db) => {
      await probe(db);
      db.a.loseNextCommitResponse = true;
      await db.a.snapshot(async (tx) => {
        await tx.query("SELECT version FROM d4s_snapshot_probe WHERE id = 1", []);
      });
      expect(db.a.loseNextCommitResponse).toBe(true);
      await expect(db.a.transaction(async (tx) => {
        await tx.query("UPDATE d4s_snapshot_probe SET version = 2 WHERE id = 1", []);
      })).rejects.toBeInstanceOf(LostCommitResponseError);
      expect((await db.a.query<{ version: number }>(
        "SELECT version FROM d4s_snapshot_probe WHERE id = 1", [])).rows[0]?.version).toBe(2);
      db.a.failNextCommit = true;
      await db.a.snapshot(async (tx) => {
        await tx.query("SELECT version FROM d4s_snapshot_probe WHERE id = 1", []);
      });
      expect(db.a.failNextCommit).toBe(true);
      await expect(db.a.transaction(async (tx) => {
        await tx.query("UPDATE d4s_snapshot_probe SET version = 3 WHERE id = 1", []);
      })).rejects.toThrow("Synthetic failure before PostgreSQL COMMIT");
      expect((await db.a.query<{ version: number }>(
        "SELECT version FROM d4s_snapshot_probe WHERE id = 1", [])).rows[0]?.version).toBe(2);
    }));
});
