import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Pool, type PoolClient } from "pg";
import { runMigrations, type MigrationTarget } from "../../tools/migration-coordinator/src/index.js";
import type { PostgresExecutor, PostgresQueryResult, PostgresTransaction } from "../../packages/orchestration-state-store-postgres/src/postgres.js";

const migrations = [
  "0001_orchestration_recovery_state.sql",
  "0002_orchestration_recovery_lease.sql",
  "0003_orchestration_pending_effects_and_outcomes.sql",
  "0004_execution_authority_checkpoint.sql",
  "0005_orchestration_commit_receipts.sql",
  "0006_terminal_non_submission_persistence.sql",
] as const;
const tables = ["orchestration_recovery_state", "orchestration_recovery_lease",
  "orchestration_pending_effect", "orchestration_external_outcome",
  "orchestration_execution_authority_checkpoint", "orchestration_pending_intent_commit",
  "orchestration_external_outcome_adoption",
  "orchestration_terminal_non_submission_disposition"] as const;
const schemaPattern = /^b1f_[0-9a-f]{24}$/;
const markers = ["receipt:pending-load", "receipt:adoption-load",
  "execution-store-postgres:outcome-select", "execution-store-postgres:outcome-update",
  "terminal:broker-lock",
  "receipt:terminal-ref-load", "receipt:terminal-insert", "effect:terminal-resolve",
  "orchestration-state-store-postgres:terminal-update",
  "orchestration-state-store-postgres:lease-lock", "orchestration-state-store-postgres:lease-clock",
  "checkpoint:insert", "effect:pending-load", "effect:pending-resolve",
  "effect:pending-insert", "save-update", "receipt:pending-insert",
  "receipt:adoption-insert"] as const;
export type Marker = typeof markers[number];
export type QueryHook = (marker: Marker) => Promise<void> | void;

export class LostCommitResponseError extends Error {
  public constructor() { super("Synthetic lost response after successful PostgreSQL COMMIT"); }
}

function schemaSql(schema: string): string {
  if (!schemaPattern.test(schema)) throw new Error("Unsafe B1F schema identifier");
  return `"${schema}"`;
}

function markerOf(sql: string): Marker | undefined { return markers.find((marker) => sql.includes(marker)); }

export function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

export async function bounded<T>(promise: Promise<T>, label: string, ms = 19000): Promise<T> {
  let timeout!: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timeout = setTimeout(() => reject(new Error(`B1F barrier timed out: ${label}`)), ms);
    })]);
  } finally { clearTimeout(timeout); }
}

export class RealPostgresExecutor implements PostgresExecutor {
  public beforeQuery: QueryHook | undefined;
  public afterQuery: QueryHook | undefined;
  public loseNextCommitResponse = false;
  public failNextCommit = false;
  public lastTransactionPid: number | undefined;

  readonly #schema: string;

  public constructor(private readonly pool: Pool, schema: string) {
    schemaSql(schema);
    this.#schema = schema;
  }

  public async bind(client: PoolClient): Promise<void> {
    await client.query(`SET search_path TO ${schemaSql(this.#schema)}, pg_catalog`);
    const result = await client.query<{ active_ok: boolean; paths_ok: boolean }>(`
      SELECT
        current_schema() = $1::name AS active_ok,
        current_schemas(false) = ARRAY[$1::name, 'pg_catalog'::name] AS paths_ok
    `, [this.#schema]);
    const row = result.rows[0];
    if (row?.active_ok !== true || row.paths_ok !== true) {
      throw new Error("B1F client search_path verification failed");
    }
  }

  private async checkedOut<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try { await this.bind(client); return await work(client); }
    finally { client.release(); }
  }

  public async query<Row>(sql: string, params: readonly unknown[]): Promise<PostgresQueryResult<Row>> {
    return this.checkedOut(async (client) => {
      const result = await client.query(sql, [...params]);
      return { rows: result.rows as Row[], rowCount: result.rowCount ?? 0 };
    });
  }

  public async transaction<T>(work: (transaction: PostgresTransaction) => Promise<T>): Promise<T> {
    this.lastTransactionPid = undefined;
    const client = await this.pool.connect();
    let committed = false;
    let began = false;
    const loseResponse = this.loseNextCommitResponse;
    this.loseNextCommitResponse = false;
    const failCommit = this.failNextCommit;
    this.failNextCommit = false;
    try {
      await this.bind(client);
      await client.query("BEGIN");
      began = true;
      await client.query("SET TRANSACTION ISOLATION LEVEL READ COMMITTED");
      await client.query("SET LOCAL statement_timeout = 15000");
      await client.query("SET LOCAL lock_timeout = 10000");
      this.lastTransactionPid = (await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!.pid;
      const tx: PostgresTransaction = { query: async <Row>(sql: string, params: readonly unknown[]) => {
        const marker = markerOf(sql);
        if (marker && this.beforeQuery) await bounded(Promise.resolve(this.beforeQuery(marker)), `before ${marker}`);
        const result = await client.query(sql, [...params]);
        if (marker && this.afterQuery) await bounded(Promise.resolve(this.afterQuery(marker)), `after ${marker}`);
        return { rows: result.rows as Row[], rowCount: result.rowCount ?? 0 };
      } };
      const result = await work(tx);
      if (failCommit) throw new Error("Synthetic failure before PostgreSQL COMMIT");
      await client.query("COMMIT");
      committed = true;
      if (loseResponse) throw new LostCommitResponseError();
      return result;
    } catch (error) {
      if (began && !committed) {
        try { await client.query("ROLLBACK"); }
        catch (rollbackError) { throw new AggregateError([error, rollbackError], "B1F rollback failed"); }
      }
      throw error;
    } finally { client.release(); }
  }
}

export class B1fDatabase {
  public readonly pool: Pool;
  readonly #schema: string;
  public readonly a: RealPostgresExecutor;
  public readonly b: RealPostgresExecutor;
  public readonly observer: RealPostgresExecutor;
  public introspection = false;
  private schemaCreated = false;

  private constructor(url: string) {
    this.#schema = `b1f_${randomBytes(12).toString("hex")}`;
    schemaSql(this.#schema);
    this.pool = new Pool({ connectionString: url, max: 8, connectionTimeoutMillis: 10000 });
    this.a = new RealPostgresExecutor(this.pool, this.#schema);
    this.b = new RealPostgresExecutor(this.pool, this.#schema);
    this.observer = new RealPostgresExecutor(this.pool, this.#schema);
  }

  public get target(): MigrationTarget { return { database: "ulte_b1f_test", schema: this.#schema }; }

  public static async create(coordinated = false): Promise<B1fDatabase> {
    const url = process.env["ULTE_TEST_POSTGRES_URL"];
    if (!url) throw new Error("ULTE_TEST_POSTGRES_URL is required for real PostgreSQL B1F tests");
    let parsed: URL;
    try { parsed = new URL(url); }
    catch { throw new Error("ULTE_TEST_POSTGRES_URL must be an explicit PostgreSQL URL"); }
    if ((parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:")
      || !parsed.hostname || decodeURIComponent(parsed.pathname) !== "/ulte_b1f_test") {
      throw new Error("B1F test URL must explicitly name a host and ulte_b1f_test database");
    }
    const db = new B1fDatabase(url);
    try {
      const client = await db.pool.connect();
      try {
        const result = await client.query<{ database: string; username: string; version: string; superuser: boolean }>(
          "SELECT current_database() AS database, current_user AS username, current_setting('server_version') AS version, (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS superuser");
        const row = result.rows[0];
        if (row?.database !== "ulte_b1f_test" || row.superuser !== false) {
          throw new Error("B1F database safety gate requires ulte_b1f_test and a non-superuser role");
        }
        try { await client.query("SELECT pg_blocking_pids(pg_backend_pid())"); db.introspection = true; }
        catch { db.introspection = false; }
        await client.query(`CREATE SCHEMA ${schemaSql(db.#schema)}`);
        db.schemaCreated = true;
        await db.a.bind(client);
        if (coordinated) {
          const source = { connect: async () => {
            const pinned = await db.pool.connect();
            try { await db.a.bind(pinned); return pinned; }
            catch (error) { pinned.release(); throw error; }
          } };
          const run = await runMigrations(source, db.target);
          if (run.capability.status !== "VERIFIED") throw new Error("D3 coordinated schema capability unavailable");
        } else {
          for (const name of migrations) {
            const path = fileURLToPath(new URL(`../../packages/orchestration-state-store-postgres/migrations/${name}`, import.meta.url));
            await client.query(await readFile(path, "utf8"));
          }
        }
        for (const table of tables) {
          const found = await client.query<{ oid: string | null; namespace: string | null }>(
            "SELECT to_regclass($1)::text AS oid, n.nspname AS namespace FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE c.oid = to_regclass($1)", [table]);
          if (found.rows[0]?.namespace !== db.#schema || found.rows[0]?.oid !== table) {
            throw new Error(`B1F migration table missing or outside disposable schema: ${table}`);
          }
        }
      } finally { client.release(); }
      return db;
    } catch (error) {
      try { if (db.schemaCreated) await db.dispose(); else await db.pool.end(); }
      catch (cleanupError) {
        throw new AggregateError([error, cleanupError], "B1F setup and cleanup failed");
      }
      throw error;
    }
  }

  public async nowMs(): Promise<number> {
    const result = await this.observer.query<{ now_ms: string }>(
      "SELECT floor(extract(epoch from clock_timestamp()) * 1000)::bigint AS now_ms", []);
    return Number(result.rows[0]!.now_ms);
  }

  public async untilDbTime(expiresAt: number): Promise<void> {
    const deadline = Date.now() + 19000;
    while (await this.nowMs() < expiresAt) {
      if (Date.now() >= deadline) throw new Error("B1F PostgreSQL clock expiry timed out");
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  public async proveConnections(): Promise<void> {
    const clients = await Promise.all([this.pool.connect(), this.pool.connect(), this.pool.connect()]);
    try {
      const pids = await Promise.all(clients.map(async (client) => {
        await this.a.bind(client);
        return (await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!.pid;
      }));
      if (new Set(pids).size !== 3) throw new Error("B1F A/B/O sessions are not distinct physical connections");
    } finally { clients.forEach((client) => client.release()); }
  }

  public async blocking(workerPid: number, blockerPid: number): Promise<void> {
    if (this.introspection) {
      const until = Date.now() + 2000;
      while (Date.now() < until) {
        const result = await this.observer.query<{ blockers: number[]; observer_pid: number }>(
          "SELECT pg_blocking_pids($1) AS blockers, pg_backend_pid() AS observer_pid", [workerPid]);
        if (result.rows[0]?.observer_pid === workerPid || result.rows[0]?.observer_pid === blockerPid)
          throw new Error("B1F observer reused a worker physical connection");
        if (result.rows[0]?.blockers.includes(blockerPid)) return;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      throw new Error("B1F observer did not see expected PostgreSQL blocker");
    }
    throw new Error("B1F blocker introspection restricted; bounded fallback must be asserted by test");
  }

  public async dispose(): Promise<void> {
    try {
      if (!this.schemaCreated) throw new Error("B1F schema was never created; refusing cleanup SQL");
      const client = await this.pool.connect();
      try { await client.query(`DROP SCHEMA IF EXISTS ${schemaSql(this.#schema)} CASCADE`); }
      finally { client.release(); }
    } finally { await this.pool.end(); }
  }
}
