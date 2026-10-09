import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Client, Pool, type PoolClient } from "pg";
import { describe, expect, it } from "vitest";
import { MIGRATION_MANIFEST, loadMigrations, runMigrations, verifyTerminalSchemaCapability,
  type MigrationConnectionSource, type MigrationTarget } from "../../tools/migration-coordinator/src/index.js";

const schemaPattern = /^d2c_[0-9a-f]{24}$/;
const quoteSchema = (name: string) => {
  if (!schemaPattern.test(name)) throw new Error("Unsafe D2C schema identifier");
  return `"${name}"`;
};
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
type FixtureClient = Pick<PoolClient, "query" | "release">;
async function rethrowAfterCleanup(error: unknown, cleanup: () => Promise<void>): Promise<never> {
  try { await cleanup(); }
  catch (cleanupError) { throw new AggregateError([error, cleanupError], "D2C work and cleanup both failed"); }
  throw error;
}
async function bounded<T>(work: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([work, new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`D2C timeout: ${label}`)), 19000);
  })]); }
  finally { if (timer) clearTimeout(timer); }
}

class Database {
  private readonly pool: Pool;
  private readonly checkedOut = new Set<PoolClient>();
  readonly schema = `d2c_${randomBytes(12).toString("hex")}`;
  readonly target: MigrationTarget = { database: "ulte_b1f_test", schema: this.schema };
  readonly source: MigrationConnectionSource = { connect: () => this.client() };
  private created = false;

  private constructor(private readonly url: string) {
    this.pool = new Pool({ connectionString: url, max: 5, connectionTimeoutMillis: 10000 });
  }
  private async checkout(bind: boolean): Promise<FixtureClient> {
    const raw = await this.pool.connect();
    this.checkedOut.add(raw);
    const client: FixtureClient = {
      query: raw.query.bind(raw) as PoolClient["query"],
      release: () => {
        if (!this.checkedOut.has(raw)) throw new Error("D2C client released twice");
        // Retire this physical session so an open or aborted transaction cannot
        // be checked out again, even before fixture disposal.
        raw.release(true);
        this.checkedOut.delete(raw);
      },
    };
    try { if (bind) await client.query(`SET search_path TO ${quoteSchema(this.schema)}, pg_catalog`); }
    catch (error) { return rethrowAfterCleanup(error, async () => client.release()); }
    return client;
  }
  static async create(): Promise<Database> {
    const url = process.env["ULTE_TEST_POSTGRES_URL"];
    if (!url) throw new Error("ULTE_TEST_POSTGRES_URL is required for D2C real PostgreSQL tests");
    let parsed: URL;
    try { parsed = new URL(url); }
    catch { throw new Error("D2C requires an explicit PostgreSQL URL"); }
    if (!(["postgres:", "postgresql:"].includes(parsed.protocol)) || !parsed.hostname ||
        decodeURIComponent(parsed.pathname) !== "/ulte_b1f_test")
      throw new Error("D2C requires explicit host and ulte_b1f_test database");
    const db = new Database(url);
    try {
      const client = await db.checkout(false);
      try {
        const row = (await client.query<{ database: string; role: string; superuser: boolean }>(
          "SELECT current_database() AS database, current_user AS role, (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS superuser"
        )).rows[0];
        if (row?.database !== db.target.database || row.role !== "ulte_test" || row.superuser !== false)
          throw new Error("D2C requires ulte_b1f_test and the non-superuser ulte_test role");
        await client.query(`CREATE SCHEMA ${quoteSchema(db.schema)}`);
        db.created = true;
      } catch (error) { return rethrowAfterCleanup(error, async () => client.release()); }
      client.release();
      return db;
    } catch (error) { return rethrowAfterCleanup(error, () => db.dispose()); }
  }
  async client(): Promise<FixtureClient> {
    return this.checkout(true);
  }
  async dispose(): Promise<void> {
    if (this.checkedOut.size !== 0)
      throw new Error(`D2C fixture has ${this.checkedOut.size} unreleased client(s)`);
    // Closing every pooled session terminates any open or aborted transaction.
    await this.pool.end();
    if (!this.created) return;
    const cleanup = new Client({ connectionString: this.url, connectionTimeoutMillis: 10000 });
    await cleanup.connect();
    try {
      const row = (await cleanup.query<{ database: string; role: string; superuser: boolean }>(
        "SELECT current_database() AS database, current_user AS role, (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS superuser"
      )).rows[0];
      if (row?.database !== this.target.database || row.role !== "ulte_test" || row.superuser !== false)
        throw new Error("D2C cleanup database or role mismatch");
      await cleanup.query(`DROP SCHEMA ${quoteSchema(this.schema)} CASCADE`);
    } catch (error) { return rethrowAfterCleanup(error, () => cleanup.end()); }
    await cleanup.end();
  }
}
async function realTest(work: (db: Database) => Promise<void>): Promise<void> {
  const db = await Database.create();
  try { await work(db); }
  catch (error) { await rethrowAfterCleanup(error, () => db.dispose()); }
  await db.dispose();
}
async function apply(client: FixtureClient, path: string): Promise<void> {
  const full = fileURLToPath(new URL(`../../${path}`, import.meta.url));
  await client.query(await readFile(full, "utf8"));
}
async function capability(db: Database) {
  return verifyTerminalSchemaCapability(db.source, db.target);
}
async function catalog(client: FixtureClient, schema: string) {
  return (await client.query<{ name: string; kind: string; validated: boolean;
    deferrable: boolean; initially_deferred: boolean; update_action: string; delete_action: string;
    match_type: string;
    source_schema: string; target_schema: string; target_table: string;
    source_columns: string[]; target_columns: string[] }>(`
    SELECT con.conname AS name, con.contype AS kind, con.convalidated AS validated,
      con.condeferrable AS deferrable, con.condeferred AS initially_deferred,
      con.confupdtype::text AS update_action, con.confdeltype::text AS delete_action,
      con.confmatchtype::text AS match_type,
      src_ns.nspname AS source_schema, dst_ns.nspname AS target_schema,
      dst.relname AS target_table,
      ARRAY(SELECT att.attname::text FROM generate_subscripts(con.conkey, 1) s(i)
        JOIN pg_catalog.pg_attribute att ON att.attrelid = con.conrelid AND att.attnum = con.conkey[s.i]
        ORDER BY s.i) AS source_columns,
      ARRAY(SELECT att.attname::text FROM generate_subscripts(con.confkey, 1) s(i)
        JOIN pg_catalog.pg_attribute att ON att.attrelid = con.confrelid AND att.attnum = con.confkey[s.i]
        ORDER BY s.i) AS target_columns
    FROM pg_catalog.pg_constraint con
    JOIN pg_catalog.pg_class src ON src.oid = con.conrelid
    JOIN pg_catalog.pg_namespace src_ns ON src_ns.oid = src.relnamespace
    JOIN pg_catalog.pg_class dst ON dst.oid = con.confrelid
    JOIN pg_catalog.pg_namespace dst_ns ON dst_ns.oid = dst.relnamespace
    WHERE src_ns.nspname = $1 AND src.relname = 'orchestration_terminal_non_submission_disposition'
      AND con.conname = 'orchestration_terminal_broker_idempotency_fk'`, [schema])).rows;
}
async function replaceFk(client: FixtureClient, suffix: "" | "DEFERRABLE" |
  "DEFERRABLE INITIALLY DEFERRED" | "ON DELETE CASCADE" | "ON UPDATE CASCADE" | "MATCH FULL") {
  await client.query("ALTER TABLE orchestration_terminal_non_submission_disposition DROP CONSTRAINT orchestration_terminal_broker_idempotency_fk");
  await client.query(`ALTER TABLE orchestration_terminal_non_submission_disposition
    ADD CONSTRAINT orchestration_terminal_broker_idempotency_fk
    FOREIGN KEY (adapter_id, environment, idempotency_key)
    REFERENCES broker_idempotency_records (adapter_id, environment, idempotency_key) ${suffix}`);
}

describe("D2C real combined PostgreSQL migrations", () => {
  it("preserves paired failures and drains aborted sessions before dropping its schema", async () => {
    for (const phase of ["setup", "work"]) {
      const primary = new Error(`${phase} failed`), cleanup = new Error("cleanup failed");
      await expect(rethrowAfterCleanup(primary, async () => { throw cleanup; })).rejects.toSatisfy(
        (error: unknown) => error instanceof AggregateError &&
          error.errors[0] === primary && error.errors[1] === cleanup);
    }
    const db = await Database.create();
    const schema = db.schema;
    try {
      // Keep a second clean checkout so cleanup cannot rely on pool checkout order.
      const clean = await db.client();
      try {
        const poisoned = await db.client();
        try {
          await poisoned.query("BEGIN");
          await expect(poisoned.query("SELECT 1 / 0")).rejects.toMatchObject({ code: "22012" });
          await expect(poisoned.query("SELECT 1")).rejects.toMatchObject({ code: "25P02" });
        } finally { poisoned.release(); }
      } finally { clean.release(); }
      const later = await db.client();
      try { expect((await later.query("SELECT 1 AS ok")).rows[0]?.ok).toBe(1); }
      finally { later.release(); }
    } catch (error) { await rethrowAfterCleanup(error, () => db.dispose()); }
    await db.dispose();
    const probe = new Client({ connectionString: process.env["ULTE_TEST_POSTGRES_URL"],
      connectionTimeoutMillis: 10000 });
    await probe.connect();
    try {
      expect((await probe.query<{ present: boolean }>(
        "SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_namespace WHERE nspname = $1) AS present",
        [schema])).rows[0]?.present).toBe(false);
    } finally { await probe.end(); }
    await realTest(async (next) => {
      const client = await next.client();
      try { expect((await client.query("SELECT 1 AS ok")).rows[0]?.ok).toBe(1); }
      finally { client.release(); }
    });
  });

  it("installs exact stream order, proves one schema and validated catalog FK, then replays", () => realTest(async (db) => {
    const first = await runMigrations(db.source, db.target);
    expect(first.applied).toEqual(MIGRATION_MANIFEST.map((d) => `${d.stream}/${d.name}`));
    expect(first.capability).toEqual({ capability: "TERMINAL_NON_SUBMISSION_PERSISTENCE",
      status: "VERIFIED", reasons: [] });
    const client = await db.client();
    try {
      const descriptors = await loadMigrations();
      const ledger = (await client.query<{ stream: string; name: string; position: number; digest: string }>(
        `SELECT stream,name,position,digest FROM ulte_schema_migrations
         ORDER BY CASE stream WHEN 'EXECUTION' THEN 1 WHEN 'ORCHESTRATION' THEN 2 ELSE 3 END,position`)).rows;
      expect(ledger).toEqual(descriptors.map(({ stream, name, position, digest }) =>
        ({ stream, name, position, digest })));
      const topology = (await client.query<{ database: string; schema: string; schemas: string[] }>(
        "SELECT current_database() AS database,current_schema() AS schema,current_schemas(false)::text[] AS schemas")).rows[0]!;
      expect(topology).toEqual({ database: db.target.database, schema: db.schema,
        schemas: [db.schema, "pg_catalog"] });
      const objects = (await client.query<{ name: string; schema: string }>(`
        SELECT c.relname AS name,n.nspname AS schema FROM pg_catalog.pg_class c
        JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
        WHERE c.relname = ANY($1::text[]) AND n.nspname=$2`, [[
          "broker_idempotency_records", "orchestration_terminal_non_submission_disposition",
          "orchestration_recovery_state", "orchestration_pending_effect", "ulte_schema_migrations"], db.schema])).rows;
      expect(objects).toHaveLength(5);
      expect(objects.every((row) => row.schema === db.schema)).toBe(true);
      expect(await catalog(client, db.schema)).toEqual([{
        name: "orchestration_terminal_broker_idempotency_fk", kind: "f", validated: true,
        deferrable: false, initially_deferred: false, update_action: "a", delete_action: "a", match_type: "s",
        source_schema: db.schema, target_schema: db.schema, target_table: "broker_idempotency_records",
        source_columns: ["adapter_id", "environment", "idempotency_key"],
        target_columns: ["adapter_id", "environment", "idempotency_key"],
      }]);
    } finally { client.release(); }
    const replay = await runMigrations(db.source, db.target);
    expect(replay.applied).toEqual([]);
    expect(replay.skipped).toEqual(first.applied);
    expect(replay.capability.status).toBe("VERIFIED");
  }));

  it("rejects orphan receipt, accepts matching broker row, and rolls back both stores together", () => realTest(async (db) => {
    await runMigrations(db.source, db.target);
    const client = await db.client();
    try {
      await client.query(`INSERT INTO orchestration_execution_authority_checkpoint
        (schema_version,checkpoint_ref,evidence_schema_version,execution_attempt_id,
         execution_plan_id,trade_intent_id,candidate_id,instrument_id,evidence_payload)
        VALUES ('EXECUTION_AUTHORITY_CHECKPOINT_V1','cp','EXECUTION_ATTEMPT_RECOVERY_EVIDENCE_V1',
          'attempt','plan','intent','candidate','ulte:v1:test:SPOT:ABC','{}')`);
      await client.query(`INSERT INTO orchestration_recovery_state
        (schema_version,session_id,revision,fence_token,mode,instrument_id,
         execution_authority_checkpoint_ref,execution_attempt_id,execution_plan_id,
         trade_intent_id,candidate_id,execution_instrument_id)
        VALUES ('ORCHESTRATION_RECOVERY_RECORD_V1','session',1,1,'SANDBOX',
          'ulte:v1:test:SPOT:ABC','cp','attempt','plan','intent','candidate','ulte:v1:test:SPOT:ABC')`);
      await client.query(`INSERT INTO orchestration_pending_effect
        (schema_version,session_id,adapter_id,environment,operation,execution_attempt_id,
         idempotency_key,request_fingerprint,created_revision,created_fence,state)
        VALUES ('ORCHESTRATION_PENDING_EFFECT_V1','session','adapter','SANDBOX',
          'ENTRY_SUBMISSION','attempt','key','fingerprint',1,1,'PENDING')`);
      const receiptSql = `INSERT INTO orchestration_terminal_non_submission_disposition
        (schema_version,disposition_ref,session_id,adapter_id,environment,operation,
         execution_attempt_id,idempotency_key,request_fingerprint,expected_revision,
         committed_revision,committed_fence,committing_owner_id,unchanged_checkpoint_ref,
         source_event_ref,observed_at_ms,proof_payload,commit_payload)
         VALUES ('TERMINAL_NON_SUBMISSION_DISPOSITION_RECEIPT_V1','receipt','session','adapter',
         'SANDBOX','ENTRY_SUBMISSION','attempt','key','fingerprint',1,2,1,'owner','cp','event',1,'{}','{}')`;
      await expect(client.query(receiptSql)).rejects.toMatchObject({ code: "23503" });
      await client.query(`INSERT INTO broker_idempotency_records
        (adapter_id,environment,idempotency_key,execution_attempt_id,operation,
         request_fingerprint,status,created_at_ms,updated_at_ms)
        VALUES ('adapter','SANDBOX','key','attempt','ENTRY_SUBMISSION','fingerprint','SUBMITTED',1,1)`);
      await client.query(receiptSql);
      expect((await client.query("SELECT count(*)::int AS n FROM orchestration_terminal_non_submission_disposition")).rows[0].n).toBe(1);
      await client.query("BEGIN");
      try {
        await client.query(`INSERT INTO broker_idempotency_records
          (adapter_id,environment,idempotency_key,execution_attempt_id,operation,
           request_fingerprint,status,created_at_ms,updated_at_ms)
          VALUES ('adapter','SANDBOX','rollback-key','attempt','ENTRY_SUBMISSION','fingerprint','CLAIMED',1,1)`);
        await client.query(`INSERT INTO orchestration_recovery_state
          (schema_version,session_id,revision,fence_token,mode,instrument_id)
          VALUES ('ORCHESTRATION_RECOVERY_RECORD_V1','rollback-session',0,1,'SANDBOX','ulte:v1:test:SPOT:ABC')`);
      } finally { await client.query("ROLLBACK"); }
      expect((await client.query("SELECT count(*)::int AS n FROM broker_idempotency_records WHERE idempotency_key='rollback-key'")).rows[0].n).toBe(0);
      expect((await client.query("SELECT count(*)::int AS n FROM orchestration_recovery_state WHERE session_id='rollback-session'")).rows[0].n).toBe(0);
    } finally { client.release(); }
  }));

  it("preserves both package-isolated migration streams and rejects wrong integration order", () => realTest(async (db) => {
    const client = await db.client();
    try {
      for (const descriptor of MIGRATION_MANIFEST.filter((d) => d.stream === "ORCHESTRATION"))
        await apply(client, descriptor.path);
      expect((await client.query("SELECT to_regclass('broker_idempotency_records') AS target")).rows[0].target).toBeNull();
      expect((await capability(db)).status).toBe("DISABLED");
      await expect(apply(client, MIGRATION_MANIFEST.at(-1)!.path)).rejects.toMatchObject({ code: "42P01" });
      await client.query("ROLLBACK");
    } finally { client.release(); }
  }));

  it("applies execution alone without orchestration and keeps capability disabled", () => realTest(async (db) => {
    const client = await db.client();
    try {
      for (const descriptor of MIGRATION_MANIFEST.filter((d) => d.stream === "EXECUTION"))
        await apply(client, descriptor.path);
      expect((await client.query("SELECT to_regclass('orchestration_recovery_state') AS target")).rows[0].target).toBeNull();
      expect((await capability(db)).status).toBe("DISABLED");
    } finally { client.release(); }
  }));

  it("requires ledger and catalog independently, rejects invalid FK and wrong topology", () => realTest(async (db) => {
    await runMigrations(db.source, db.target);
    const client = await db.client();
    try {
      await client.query("ALTER TABLE orchestration_terminal_non_submission_disposition DROP CONSTRAINT orchestration_terminal_broker_idempotency_fk");
      expect((await capability(db)).reasons).toContain(
        "CONSTRAINT_MISMATCH:orchestration_terminal_non_submission_disposition.orchestration_terminal_broker_idempotency_fk");
      await apply(client, MIGRATION_MANIFEST.at(-1)!.path);
      await client.query(`ALTER TABLE orchestration_terminal_non_submission_disposition
        DROP CONSTRAINT orchestration_terminal_broker_idempotency_fk`);
      await client.query(`ALTER TABLE orchestration_terminal_non_submission_disposition
        ADD CONSTRAINT orchestration_terminal_broker_idempotency_fk
        FOREIGN KEY (adapter_id, environment, idempotency_key)
        REFERENCES broker_idempotency_records (adapter_id, environment, idempotency_key) NOT VALID`);
      expect((await capability(db)).status).toBe("DISABLED");
      await client.query(`ALTER TABLE orchestration_terminal_non_submission_disposition
        VALIDATE CONSTRAINT orchestration_terminal_broker_idempotency_fk`);
      expect((await capability(db)).status).toBe("VERIFIED");
      const variants = [
        { suffix: "DEFERRABLE", field: "deferrable", value: true },
        { suffix: "DEFERRABLE INITIALLY DEFERRED", field: "initially_deferred", value: true },
        { suffix: "ON DELETE CASCADE", field: "delete_action", value: "c" },
        { suffix: "ON UPDATE CASCADE", field: "update_action", value: "c" },
        { suffix: "MATCH FULL", field: "match_type", value: "f" },
      ] as const;
      for (const variant of variants) {
        await replaceFk(client, variant.suffix);
        const actual = (await catalog(client, db.schema))[0]!;
        expect(actual.name).toBe("orchestration_terminal_broker_idempotency_fk");
        expect(actual.source_columns).toEqual(["adapter_id", "environment", "idempotency_key"]);
        expect(actual.target_columns).toEqual(["adapter_id", "environment", "idempotency_key"]);
        expect(actual[variant.field]).toBe(variant.value);
        expect((await capability(db)).reasons).toContain(
          "CONSTRAINT_MISMATCH:orchestration_terminal_non_submission_disposition.orchestration_terminal_broker_idempotency_fk");
        await replaceFk(client, "");
        expect((await capability(db)).status).toBe("VERIFIED");
      }
      await client.query("DELETE FROM ulte_schema_migrations WHERE stream='INTEGRATION'");
      expect((await capability(db)).reasons).toContain("MIGRATION_HISTORY_CONFLICT");
      await client.query("SET search_path TO pg_catalog");
      const wrongSource: MigrationConnectionSource = { connect: async () => {
        const wrong = await db.client();
        await wrong.query("SET search_path TO pg_catalog");
        return wrong;
      } };
      expect((await verifyTerminalSchemaCapability(wrongSource, db.target)).reasons).toContain("SCHEMA_TOPOLOGY_MISMATCH");
    } finally { client.release(); }
  }));

  it("fails closed on a conflicting migration digest before later SQL", () => realTest(async (db) => {
    await runMigrations(db.source, db.target);
    const client = await db.client();
    try {
      await client.query("UPDATE ulte_schema_migrations SET digest=repeat('0',64) WHERE stream='EXECUTION' AND position=1");
    } finally { client.release(); }
    await expect(runMigrations(db.source, db.target)).rejects.toMatchObject({ code: "MIGRATION_HISTORY_CONFLICT" });
    expect((await capability(db)).status).toBe("DISABLED");
  }));

  it("serializes two physical coordinator connections under the advisory lock", () => realTest(async (db) => {
    let releaseA!: () => void;
    let enteredA!: () => void;
    const entered = new Promise<void>((resolve) => { enteredA = resolve; });
    const hold = new Promise<void>((resolve) => { releaseA = resolve; });
    let aPid: number | undefined;
    const sourceA: MigrationConnectionSource = { connect: async () => {
      const client = await db.client();
      aPid = (await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!.pid;
      return { release: () => client.release(), query: async <Row>(sql: string, params?: readonly unknown[]) => {
        if (sql.includes("c.relname = 'ulte_schema_migrations'")) {
          enteredA(); await bounded(hold, "release A");
        }
        const result = await client.query(sql, params ? [...params] : []);
        return { rows: result.rows as Row[], rowCount: result.rowCount };
      } };
    } };
    const a = runMigrations(sourceA, db.target);
    let b: Promise<unknown> | undefined;
    try {
      await bounded(entered, "A acquired lock");
      // Pin B explicitly so the observed backend PID is the one attempting the lock.
      const bClient = await db.client();
      const bPid = (await bClient.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!.pid;
      b = runMigrations({ connect: async () => bClient }, db.target);
      const observer = await db.client();
      try {
        let blockers: number[] = [];
        await bounded((async () => {
          while (true) {
            blockers = (await observer.query<{ pids: number[] }>(
              "SELECT pg_blocking_pids($1) AS pids", [bPid])).rows[0]!.pids;
            if (blockers.length) break;
            await pause(20);
          }
        })(), "B blocked by A");
        expect(aPid).not.toBe(bPid);
        expect(blockers).toContain(aPid);
        expect((await observer.query("SELECT to_regclass('ulte_schema_migrations') AS ledger")).rows[0].ledger).toBeNull();
      } finally { observer.release(); }
      releaseA();
      const first = await bounded(a, "A completion");
      const second = await bounded(b as Promise<Awaited<typeof a>>, "B completion");
      expect(first.applied).toHaveLength(MIGRATION_MANIFEST.length);
      expect(second.applied).toEqual([]);
      expect(second.skipped).toHaveLength(MIGRATION_MANIFEST.length);
    } finally {
      releaseA();
      await bounded(Promise.allSettled([a, ...(b ? [b] : [])]), "lock workers cleanup");
    }
  }));
});
