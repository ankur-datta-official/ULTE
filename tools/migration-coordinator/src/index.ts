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
    "0006_terminal_non_submission_persistence.sql",
  ],
  INTEGRATION: ["0001_terminal_non_submission_broker_idempotency_fk.sql"],
} as const satisfies Record<MigrationStream, readonly string[]>;

const directories = {
  EXECUTION: "packages/execution-store-postgres/migrations",
  ORCHESTRATION: "packages/orchestration-state-store-postgres/migrations",
  INTEGRATION: "migrations/integration",
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
  readonly status: "DISABLED" | "VERIFIED";
  readonly reasons: readonly string[];
}

export function terminalSchemaCapability(reasons: readonly string[] = ["SCHEMA_UNVERIFIED"]): TerminalSchemaCapability {
  return Object.freeze({
    capability: "TERMINAL_NON_SUBMISSION_PERSISTENCE",
    status: "DISABLED",
    reasons: Object.freeze([...reasons]),
  });
}

const verifiedCapability = (): TerminalSchemaCapability => Object.freeze({
  capability: "TERMINAL_NON_SUBMISSION_PERSISTENCE", status: "VERIFIED", reasons: Object.freeze([]),
});

interface IdentityRow { database: string; schema: string | null; schemas: string[]; }
interface LedgerRow { stream: string; name: string; position: number; digest: string; }
interface ExistsRow { present: boolean; }
interface CatalogTableRow { name: string; }
interface CatalogColumnRow { table_name: string; name: string; type_name: string; not_null: boolean; }
interface CatalogConstraintRow {
  table_name: string; name: string; kind: string; validated: boolean;
  deferrable: boolean; initially_deferred: boolean;
  update_action: string; delete_action: string; match_type: string;
  definition: string;
  source_columns: string[]; target_schema: string | null; target_table: string | null;
  target_columns: string[];
}

const ledgerName = "ulte_schema_migrations";
const identitySql = `SELECT current_database() AS database, current_schema() AS schema,
  current_schemas(false)::text[] AS schemas`;
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
const readLedgerSql = `SELECT stream, name, position, digest FROM ulte_schema_migrations
  ORDER BY CASE stream WHEN 'EXECUTION' THEN 1 WHEN 'ORCHESTRATION' THEN 2 WHEN 'INTEGRATION' THEN 3 ELSE 4 END,
    position, name`;
const insertLedgerSql = `INSERT INTO ulte_schema_migrations (stream, name, position, digest)
  VALUES ($1, $2, $3, $4)`;
const verifyLedgerSql = `SELECT stream, name, position, digest FROM ulte_schema_migrations
  WHERE stream = $1 AND name = $2`;
const catalogTables = ["broker_idempotency_records", "orchestration_terminal_non_submission_disposition",
  "orchestration_recovery_state", "orchestration_pending_effect",
  "orchestration_execution_authority_checkpoint"] as const;
const tableCatalogSql = `SELECT c.relname AS name FROM pg_catalog.pg_class c
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = $1 AND c.relkind = 'r' AND c.relname = ANY($2::text[])`;
const columnCatalogSql = `SELECT c.relname AS table_name, a.attname AS name,
  pg_catalog.format_type(a.atttypid, a.atttypmod) AS type_name, a.attnotnull AS not_null
  FROM pg_catalog.pg_attribute a JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = $1 AND c.relkind = 'r' AND c.relname = ANY($2::text[])
    AND a.attnum > 0 AND NOT a.attisdropped`;
const constraintCatalogSql = `SELECT c.relname AS table_name, con.conname AS name,
  con.contype AS kind, con.convalidated AS validated,
  con.condeferrable AS deferrable, con.condeferred AS initially_deferred,
  con.confupdtype::text AS update_action, con.confdeltype::text AS delete_action,
  con.confmatchtype::text AS match_type,
  pg_catalog.pg_get_constraintdef(con.oid) AS definition,
  ARRAY(SELECT a.attname::text FROM generate_subscripts(con.conkey, 1) AS s(i)
    JOIN pg_catalog.pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = con.conkey[s.i]
    ORDER BY s.i) AS source_columns,
  tn.nspname AS target_schema, tc.relname AS target_table,
  ARRAY(SELECT a.attname::text FROM generate_subscripts(con.confkey, 1) AS s(i)
    JOIN pg_catalog.pg_attribute a ON a.attrelid = con.confrelid AND a.attnum = con.confkey[s.i]
    ORDER BY s.i) AS target_columns
  FROM pg_catalog.pg_constraint con JOIN pg_catalog.pg_class c ON c.oid = con.conrelid
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
  LEFT JOIN pg_catalog.pg_class tc ON tc.oid = con.confrelid
  LEFT JOIN pg_catalog.pg_namespace tn ON tn.oid = tc.relnamespace
  WHERE n.nspname = $1 AND c.relkind = 'r' AND c.relname = ANY($2::text[])`;

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

const receipt = "orchestration_terminal_non_submission_disposition";
const broker = "broker_idempotency_records";
const triple = ["adapter_id", "environment", "idempotency_key"];
const expectedColumns: Readonly<Record<string, Readonly<Record<string, readonly [string, boolean]>>>> = {
  [receipt]: {
    schema_version: ["text", true], disposition_ref: ["text", true], session_id: ["text", true],
    adapter_id: ["text", true], environment: ["text", true], operation: ["text", true],
    execution_attempt_id: ["text", true], idempotency_key: ["text", true],
    request_fingerprint: ["text", true], expected_revision: ["bigint", true],
    committed_revision: ["bigint", true], committed_fence: ["bigint", true],
    committing_owner_id: ["text", true], unchanged_checkpoint_ref: ["text", true],
    source_event_ref: ["text", true], observed_at_ms: ["bigint", true],
    proof_payload: ["jsonb", true], commit_payload: ["jsonb", true],
  },
  [broker]: { adapter_id: ["text", true], environment: ["text", true], idempotency_key: ["text", true] },
  orchestration_recovery_state: { schema_version: ["text", true],
    terminal_non_submission_disposition_ref: ["text", false] },
  orchestration_pending_effect: { schema_version: ["text", true], state: ["text", true],
    resolution_kind: ["text", false], resolved_authority_ref: ["text", false],
    resolved_revision: ["bigint", false], resolved_fence: ["bigint", false] },
};

/** Read-only D3 prerequisite proof. It grants no runtime or trading authority. */
async function inspectTerminalSchemaCapability(client: PinnedMigrationClient, target: MigrationTarget,
  descriptors: readonly MigrationDescriptor[]): Promise<TerminalSchemaCapability> {
  const reasons: string[] = [];
  const identity = (await client.query<IdentityRow>(identitySql)).rows[0];
  if (identity?.database !== target.database) reasons.push("DATABASE_IDENTITY_MISMATCH");
  if (identity?.schema !== target.schema || !Array.isArray(identity.schemas) ||
      identity.schemas.length !== 2 || identity.schemas[0] !== target.schema ||
      identity.schemas[1] !== "pg_catalog") reasons.push("SCHEMA_TOPOLOGY_MISMATCH");
  if (reasons.length) return terminalSchemaCapability(reasons);

  if ((await client.query<ExistsRow>(ledgerExistsSql)).rows[0]?.present !== true)
    reasons.push("MIGRATION_LEDGER_MISSING");
  else {
    const rows = (await client.query<LedgerRow>(readLedgerSql)).rows;
    if (rows.length !== descriptors.length || rows.some((row, index) => {
      const expected = descriptors[index];
      return !expected || row.stream !== expected.stream || row.name !== expected.name ||
        row.position !== expected.position || row.digest !== expected.digest;
    })) reasons.push("MIGRATION_HISTORY_CONFLICT");
  }

  const tables = new Set((await client.query<CatalogTableRow>(tableCatalogSql,
    [target.schema, [...catalogTables]])).rows.map((r) => r.name));
  for (const name of catalogTables) if (!tables.has(name)) reasons.push(`TABLE_MISSING:${name}`);
  const columns = new Map((await client.query<CatalogColumnRow>(columnCatalogSql,
    [target.schema, [...catalogTables]])).rows.map((r) => [`${r.table_name}.${r.name}`, r]));
  for (const [table, definitions] of Object.entries(expectedColumns)) {
    for (const [name, [type, notNull]] of Object.entries(definitions)) {
      const actual = columns.get(`${table}.${name}`);
      if (!actual || actual.type_name !== type || actual.not_null !== notNull)
        reasons.push(`COLUMN_MISMATCH:${table}.${name}`);
    }
  }
  const constraints = (await client.query<CatalogConstraintRow>(constraintCatalogSql,
    [target.schema, [...catalogTables]])).rows;
  const requireConstraint = (table: string, name: string, kind: string,
    sourceColumns?: readonly string[], targetTable?: string, targetColumns?: readonly string[],
    definitionTerms: readonly string[] = [], exactNormalFk = false) => {
    const matches = constraints.filter((c) => c.table_name === table && c.name === name);
    const c = matches[0];
    if (matches.length !== 1 || !c || c.kind !== kind || c.validated !== true ||
        (sourceColumns && JSON.stringify(c.source_columns) !== JSON.stringify(sourceColumns)) ||
        (targetTable && (c.target_schema !== target.schema || c.target_table !== targetTable ||
          JSON.stringify(c.target_columns) !== JSON.stringify(targetColumns))) ||
        (exactNormalFk && (c.deferrable !== false || c.initially_deferred !== false ||
          c.update_action !== "a" || c.delete_action !== "a" || c.match_type !== "s")) ||
        definitionTerms.some((term) => !c.definition.includes(term)))
      reasons.push(`CONSTRAINT_MISMATCH:${table}.${name}`);
  };
  requireConstraint(broker, "broker_idempotency_records_pkey", "p", triple);
  requireConstraint(receipt, "orchestration_terminal_non_submission_disposition_pkey", "p", ["disposition_ref"]);
  const requireUnique = (table: string, sourceColumns: readonly string[]) => {
    if (!constraints.some((c) => c.table_name === table && c.kind === "u" && c.validated === true &&
      JSON.stringify(c.source_columns) === JSON.stringify(sourceColumns)))
      reasons.push(`UNIQUE_MISSING:${table}.${sourceColumns.join(",")}`);
  };
  requireUnique(receipt, ["session_id"]);
  requireUnique(receipt, triple);
  requireConstraint(receipt, "orchestration_terminal_broker_idempotency_fk", "f", triple, broker, triple, [], true);
  requireConstraint("orchestration_recovery_state", "orchestration_recovery_terminal_version_check", "c",
    undefined, undefined, undefined,
    ["ORCHESTRATION_RECOVERY_RECORD_V2", "terminal_non_submission_disposition_ref",
      "execution_authority_checkpoint_ref"]);
  requireConstraint("orchestration_recovery_state", "orchestration_recovery_terminal_ref_check", "c",
    undefined, undefined, undefined, ["terminal_non_submission_disposition_ref"]);
  requireConstraint("orchestration_recovery_state", "orchestration_recovery_terminal_receipt_fk", "f",
    ["terminal_non_submission_disposition_ref"], receipt, ["disposition_ref"]);
  for (const name of ["orchestration_pending_resolution_check", "orchestration_pending_resolution_ref_check",
    "orchestration_pending_resolution_version_check"]) {
    requireConstraint("orchestration_pending_effect", name, "c", undefined, undefined, undefined,
      name === "orchestration_pending_resolution_check"
        ? ["resolution_kind", "resolved_authority_ref", "resolved_revision", "resolved_fence", "TERMINAL_NON_SUBMISSION"]
        : name === "orchestration_pending_resolution_version_check"
          ? ["schema_version", "TERMINAL_NON_SUBMISSION"] : ["resolved_authority_ref"]);
  }
  requireConstraint("orchestration_pending_effect", "orchestration_pending_identity_unique", "u",
    ["adapter_id", "environment", "operation", "execution_attempt_id", "idempotency_key", "request_fingerprint"]);
  requireConstraint("orchestration_pending_effect", "orchestration_pending_session_identity_unique", "u",
    ["session_id", "adapter_id", "environment", "operation", "execution_attempt_id", "idempotency_key", "request_fingerprint"]);
  return reasons.length ? terminalSchemaCapability(reasons) : verifiedCapability();
}

export async function verifyTerminalSchemaCapability(source: MigrationConnectionSource,
  target: MigrationTarget): Promise<TerminalSchemaCapability> {
  const descriptors = await loadMigrations();
  const client = await source.connect();
  try { return await inspectTerminalSchemaCapability(client, target, descriptors); }
  finally { client.release(); }
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
      catch (cause) {
        // Migration files own BEGIN/COMMIT. A failed multi-statement file can leave
        // this pinned session in an aborted transaction until explicitly rolled back.
        try { await client.query("ROLLBACK"); }
        catch (rollbackError) {
          throw new MigrationCoordinatorError("MIGRATION_APPLY_FAILED", descriptor.path,
            new AggregateError([cause, rollbackError], "Migration and rollback failed"));
        }
        throw new MigrationCoordinatorError("MIGRATION_APPLY_FAILED", descriptor.path, cause);
      }
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
      capability: await inspectTerminalSchemaCapability(client, target, descriptors) });
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
