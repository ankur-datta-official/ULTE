import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

export const MIGRATION_STREAMS = ["EXECUTION", "ORCHESTRATION", "INTEGRATION"] as const;
export type MigrationStream = typeof MIGRATION_STREAMS[number];

const files = {
  EXECUTION: ["0001_execution_store.sql", "0002_idempotency_state_machine.sql"],
  ORCHESTRATION: [
    "0001_orchestration_recovery_state.sql",
    "0002_orchestration_recovery_lease.sql",
    "0003_orchestration_pending_effects_and_outcomes.sql",
    "0004_execution_authority_checkpoint.sql",
    "0005_orchestration_commit_receipts.sql",
  ],
  INTEGRATION: [],
} as const satisfies Record<MigrationStream, readonly string[]>;

const directories = {
  EXECUTION: "packages/execution-store-postgres/migrations",
  ORCHESTRATION: "packages/orchestration-state-store-postgres/migrations",
  INTEGRATION: "tools/migration-coordinator/migrations",
} as const;

export const MIGRATION_MANIFEST = Object.freeze(MIGRATION_STREAMS.flatMap((stream) =>
  files[stream].map((name, index) => Object.freeze({
    stream, name, path: `${directories[stream]}/${name}`, position: index + 1,
  }))));

export interface MigrationDescriptor {
  readonly stream: MigrationStream;
  readonly name: string;
  readonly path: string;
  readonly position: number;
  readonly digest: string;
  readonly sql: string;
}

export function digestSql(sql: string): string {
  return createHash("sha256").update(sql, "utf8").digest("hex");
}

export async function loadMigrations(): Promise<readonly MigrationDescriptor[]> {
  const loaded: MigrationDescriptor[] = [];
  for (const entry of MIGRATION_MANIFEST) {
    const url = new URL(`../../../${entry.path}`, import.meta.url);
    let sql: string;
    try { sql = await readFile(fileURLToPath(url), "utf8"); }
    catch (cause) { throw new MigrationCoordinatorError("MIGRATION_FILE_INVALID", entry.path, cause); }
    if (!sql.trim()) throw new MigrationCoordinatorError("MIGRATION_FILE_INVALID", entry.path);
    loaded.push(Object.freeze({ ...entry, sql, digest: digestSql(sql) }));
  }
  return Object.freeze(loaded);
}

export type MigrationFailureCode = "DATABASE_IDENTITY_MISMATCH" | "SCHEMA_IDENTITY_MISMATCH"
  | "BASELINE_VERIFICATION_REQUIRED" | "MIGRATION_FILE_INVALID" | "MIGRATION_HISTORY_CONFLICT"
  | "MIGRATION_APPLY_FAILED" | "LEDGER_FAILURE" | "LOCK_FAILURE" | "DATABASE_INSPECTION_FAILED"
  | "CONNECTION_FAILURE";

export class MigrationCoordinatorError extends Error {
  public constructor(public readonly code: MigrationFailureCode, message: string, cause?: unknown) {
    super(message, { cause });
    this.name = "MigrationCoordinatorError";
  }
}

export interface QueryResult<Row> { readonly rows: readonly Row[]; readonly rowCount: number | null; }
/** A single checked-out physical PostgreSQL connection, never a Pool.query facade. */
export interface PinnedMigrationClient {
  query<Row>(sql: string, params?: readonly unknown[]): Promise<QueryResult<Row>>;
  release(): void;
}
export interface MigrationConnectionSource { connect(): Promise<PinnedMigrationClient>; }
export interface MigrationTarget {
  readonly database: string;
  readonly schema: string;
}
export interface MigrationRun {
  readonly applied: readonly string[];
  readonly skipped: readonly string[];
  readonly capability: TerminalSchemaCapability;
}

export interface TerminalSchemaCapability {
  readonly capability: "TERMINAL_NON_SUBMISSION_PERSISTENCE";
  readonly status: "DISABLED";
  readonly reasons: readonly string[];
}

/** D2A has no 0006, integration 0001, receipt catalog, or validated FK. */
export function terminalSchemaCapability(): TerminalSchemaCapability {
  return Object.freeze({
    capability: "TERMINAL_NON_SUBMISSION_PERSISTENCE",
    status: "DISABLED",
    reasons: Object.freeze([
      "ORCHESTRATION_0006_ABSENT", "INTEGRATION_0001_ABSENT", "TERMINAL_CATALOG_UNVERIFIED",
    ]),
  });
}

/* Future enablement requires verified execution 0001/0002, orchestration through 0006,
   integration 0001, matching DB/schema and digests, the exact terminal receipt columns,
   and the exact validated three-column FK (pg_constraint.convalidated = true).
   No D2A API can produce an enabled capability. */

interface IdentityRow { database: string; schema: string | null; schemas: string[]; }
interface LedgerRow { stream: string; name: string; position: number; digest: string; }
interface ExistsRow { present: boolean; }

const ledgerName = "ulte_schema_migrations";
const identitySql = `SELECT current_database() AS database, current_schema() AS schema,
  current_schemas(false) AS schemas`;
const ledgerExistsSql = `SELECT EXISTS (
  SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = current_schema() AND c.relname = 'ulte_schema_migrations' AND c.relkind = 'r'
) AS present`;
const schemaObjectsSql = `SELECT EXISTS (
  SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = current_schema()
  UNION ALL SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = current_schema()
  UNION ALL SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname = current_schema() AND t.typrelid = 0 AND t.typisdefined
) AS present`;
const createLedgerSql = `CREATE TABLE ulte_schema_migrations (
  stream text NOT NULL, name text NOT NULL, position integer NOT NULL CHECK (position > 0),
  digest text NOT NULL CHECK (digest ~ '^[0-9a-f]{64}$'),
  applied_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (stream, name), UNIQUE (stream, position)
)`;
const readLedgerSql = `SELECT stream, name, position, digest FROM ulte_schema_migrations`;
const insertLedgerSql = `INSERT INTO ulte_schema_migrations (stream, name, position, digest)
  VALUES ($1, $2, $3, $4)`;
const verifyLedgerSql = `SELECT stream, name, position, digest FROM ulte_schema_migrations
  WHERE stream = $1 AND name = $2`;

function lockKey(target: MigrationTarget): string {
  const hex = createHash("sha256").update(`ulte:migrations:v1\0${target.database}\0${target.schema}`)
    .digest("hex").slice(0, 16);
  return BigInt.asIntN(64, BigInt(`0x${hex}`)).toString();
}

function assertLedger(row: LedgerRow, descriptor: MigrationDescriptor): void {
  if (row.stream !== descriptor.stream || row.name !== descriptor.name ||
      row.position !== descriptor.position || row.digest !== descriptor.digest) {
    throw new MigrationCoordinatorError("MIGRATION_HISTORY_CONFLICT", descriptor.path);
  }
}

async function verifyIdentity(client: PinnedMigrationClient, target: MigrationTarget): Promise<void> {
  const identity = (await client.query<IdentityRow>(identitySql)).rows[0];
  if (!identity || identity.database !== target.database)
    throw new MigrationCoordinatorError("DATABASE_IDENTITY_MISMATCH", "Unexpected current database");
  if (identity.schema !== target.schema || !Array.isArray(identity.schemas) ||
      identity.schemas.length !== 2 || identity.schemas[0] !== target.schema ||
      identity.schemas[1] !== "pg_catalog")
    throw new MigrationCoordinatorError("SCHEMA_IDENTITY_MISMATCH", "Expected application schema, pg_catalog search_path");
}

/** Caller supplies explicit target and owns the connection source; this function releases the client. */
export async function runMigrations(
  source: MigrationConnectionSource, target: MigrationTarget,
): Promise<MigrationRun> {
  const descriptors = await loadMigrations();
  if (!target.database || !target.schema || target.schema === "pg_catalog" ||
      target.schema.startsWith("pg_temp") || !/^[a-z_][a-z0-9_]*$/.test(target.schema)) {
    throw new MigrationCoordinatorError("SCHEMA_IDENTITY_MISMATCH", "Explicit safe application schema required");
  }
  // The only accepted descriptors are those loaded from the frozen repository manifest.
  if (descriptors.length !== MIGRATION_MANIFEST.length || descriptors.some((d, i) => {
    const expected = MIGRATION_MANIFEST[i];
    return !expected || d.stream !== expected.stream || d.name !== expected.name ||
      d.path !== expected.path || d.position !== expected.position || d.digest !== digestSql(d.sql);
  })) throw new MigrationCoordinatorError("MIGRATION_FILE_INVALID", "Manifest or content mismatch");

  let client: PinnedMigrationClient;
  try { client = await source.connect(); }
  catch (cause) { throw new MigrationCoordinatorError("CONNECTION_FAILURE", "Could not pin migration connection", cause); }
  let locked = false;
  let failure: unknown;
  let result: MigrationRun | undefined;
  try {
    await verifyIdentity(client, target);

    const key = lockKey(target);
    try { await client.query("SELECT pg_advisory_lock($1::bigint)", [key]); locked = true; }
    catch (cause) { throw new MigrationCoordinatorError("LOCK_FAILURE", "Could not acquire migration lock", cause); }

    const ledgerExists = (await client.query<ExistsRow>(ledgerExistsSql)).rows[0]?.present;
    if (ledgerExists !== true) {
      const objectsExist = (await client.query<ExistsRow>(schemaObjectsSql)).rows[0]?.present;
      if (objectsExist !== false)
        throw new MigrationCoordinatorError("BASELINE_VERIFICATION_REQUIRED", "Existing schema has no verified migration ledger");
      try { await client.query(createLedgerSql); }
      catch (cause) { throw new MigrationCoordinatorError("LEDGER_FAILURE", "Could not create migration ledger", cause); }
    }

    const records = (await client.query<LedgerRow>(readLedgerSql)).rows;
    const known = new Map(descriptors.map((d) => [`${d.stream}/${d.name}`, d]));
    const appliedRecords = new Map<string, LedgerRow>();
    for (const row of records) {
      const identity = `${row.stream}/${row.name}`;
      const descriptor = known.get(identity);
      if (!descriptor || appliedRecords.has(identity))
        throw new MigrationCoordinatorError("MIGRATION_HISTORY_CONFLICT", identity);
      assertLedger(row, descriptor);
      appliedRecords.set(identity, row);
    }
    const applied: string[] = [];
    const skipped: string[] = [];
    let foundGap = false;
    for (const descriptor of descriptors) {
      const identity = `${descriptor.stream}/${descriptor.name}`;
      if (appliedRecords.has(identity)) {
        if (foundGap) throw new MigrationCoordinatorError("MIGRATION_HISTORY_CONFLICT", `Non-prefix migration history: ${identity}`);
        skipped.push(identity);
        continue;
      }
      foundGap = true;
      try { await client.query(descriptor.sql); }
      catch (cause) { throw new MigrationCoordinatorError("MIGRATION_APPLY_FAILED", descriptor.path, cause); }
      await verifyIdentity(client, target);
      try {
        await client.query(insertLedgerSql, [descriptor.stream, descriptor.name, descriptor.position, descriptor.digest]);
        const verified = (await client.query<LedgerRow>(verifyLedgerSql, [descriptor.stream, descriptor.name])).rows[0];
        if (!verified) throw new Error("Ledger row missing after insert");
        assertLedger(verified, descriptor);
      } catch (cause) { throw new MigrationCoordinatorError("LEDGER_FAILURE", descriptor.path, cause); }
      applied.push(identity);
    }
    result = Object.freeze({ applied: Object.freeze(applied), skipped: Object.freeze(skipped),
      capability: terminalSchemaCapability() });
  } catch (cause) {
    failure = cause instanceof MigrationCoordinatorError ? cause
      : new MigrationCoordinatorError("DATABASE_INSPECTION_FAILED", "Migration database operation failed", cause);
  }
  finally {
    try {
      if (locked) {
        const unlocked = (await client.query<{ unlocked: boolean }>(
          "SELECT pg_advisory_unlock($1::bigint) AS unlocked", [lockKey(target)])).rows[0]?.unlocked;
        if (unlocked !== true) throw new Error("Advisory lock was not held by this session");
      }
    }
    catch (releaseError) {
      const lockFailure = new MigrationCoordinatorError("LOCK_FAILURE", "Could not release migration lock", releaseError);
      failure = failure ? new AggregateError([failure, lockFailure], "Migration and lock release failed") : lockFailure;
    }
    client.release();
  }
  if (failure) throw failure;
  return result!;
}
