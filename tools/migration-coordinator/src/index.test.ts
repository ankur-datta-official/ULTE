import { describe, expect, it } from "vitest";
import {
  MIGRATION_MANIFEST, MIGRATION_STREAMS, digestSql, loadMigrations, runMigrations,
  terminalSchemaCapability, verifyTerminalSchemaCapability,
  type MigrationConnectionSource, type PinnedMigrationClient,
} from "./index.js";

const target = { database: "ulte_test", schema: "ulte_app" };
type RecordRow = { stream: string; name: string; position: number; digest: string };
type CatalogConstraint = { table_name: string; name: string; kind: string; validated: boolean;
  deferrable: boolean; initially_deferred: boolean; update_action: string; delete_action: string;
  match_type: string; definition: string; source_columns: string[];
  target_schema: string | null; target_table: string | null; target_columns: string[] };
type FakeCatalog = { tables: { name: string }[];
  columns: { table_name: string; name: string; type_name: string; not_null: boolean }[];
  constraints: CatalogConstraint[] };

function completeCatalog(): FakeCatalog {
  const receipt = "orchestration_terminal_non_submission_disposition";
  const broker = "broker_idempotency_records";
  const recovery = "orchestration_recovery_state";
  const pending = "orchestration_pending_effect";
  const triple = ["adapter_id", "environment", "idempotency_key"];
  const tables = [broker, receipt, recovery, pending, "orchestration_execution_authority_checkpoint"]
    .map((name) => ({ name }));
  const columns: FakeCatalog["columns"] = [];
  const add = (table_name: string, type_name: string, not_null: boolean, names: readonly string[]) => {
    for (const name of names) columns.push({ table_name, name, type_name, not_null });
  };
  add(receipt, "text", true, ["schema_version", "disposition_ref", "session_id", "adapter_id",
    "environment", "operation", "execution_attempt_id", "idempotency_key", "request_fingerprint",
    "committing_owner_id", "unchanged_checkpoint_ref", "source_event_ref"]);
  add(receipt, "bigint", true, ["expected_revision", "committed_revision", "committed_fence", "observed_at_ms"]);
  add(receipt, "jsonb", true, ["proof_payload", "commit_payload"]);
  add(broker, "text", true, triple);
  add(recovery, "text", true, ["schema_version"]);
  add(recovery, "text", false, ["terminal_non_submission_disposition_ref"]);
  add(pending, "text", true, ["schema_version", "state"]);
  add(pending, "text", false, ["resolution_kind", "resolved_authority_ref"]);
  add(pending, "bigint", false, ["resolved_revision", "resolved_fence"]);
  const constraint = (table_name: string, name: string, kind: string, source_columns: string[] = [],
    target_table: string | null = null, target_columns: string[] = [], definition = ""): CatalogConstraint => ({
    table_name, name, kind, validated: true, deferrable: false, initially_deferred: false,
    update_action: "a", delete_action: "a", match_type: "s", definition, source_columns,
    target_schema: target_table ? target.schema : null, target_table, target_columns,
  });
  const constraints = [
    constraint(broker, "broker_idempotency_records_pkey", "p", triple),
    constraint(receipt, "orchestration_terminal_non_submission_disposition_pkey", "p", ["disposition_ref"]),
    constraint(receipt, "receipt_session_unique", "u", ["session_id"]),
    constraint(receipt, "receipt_broker_unique", "u", triple),
    constraint(receipt, "orchestration_terminal_broker_idempotency_fk", "f", triple, broker, triple),
    constraint(recovery, "orchestration_recovery_terminal_version_check", "c", [], null, [],
      "ORCHESTRATION_RECOVERY_RECORD_V2 terminal_non_submission_disposition_ref execution_authority_checkpoint_ref"),
    constraint(recovery, "orchestration_recovery_terminal_ref_check", "c", [], null, [],
      "terminal_non_submission_disposition_ref"),
    constraint(recovery, "orchestration_recovery_terminal_receipt_fk", "f",
      ["terminal_non_submission_disposition_ref"], receipt, ["disposition_ref"]),
    constraint(pending, "orchestration_pending_resolution_check", "c", [], null, [],
      "resolution_kind resolved_authority_ref resolved_revision resolved_fence TERMINAL_NON_SUBMISSION"),
    constraint(pending, "orchestration_pending_resolution_ref_check", "c", [], null, [],
      "resolved_authority_ref"),
    constraint(pending, "orchestration_pending_resolution_version_check", "c", [], null, [],
      "schema_version TERMINAL_NON_SUBMISSION"),
    constraint(pending, "orchestration_pending_identity_unique", "u",
      ["adapter_id", "environment", "operation", "execution_attempt_id", "idempotency_key", "request_fingerprint"]),
    constraint(pending, "orchestration_pending_session_identity_unique", "u",
      ["session_id", "adapter_id", "environment", "operation", "execution_attempt_id", "idempotency_key", "request_fingerprint"]),
  ];
  return { tables, columns, constraints };
}

class FakeClient implements PinnedMigrationClient {
  public readonly calls: string[] = [];
  public readonly ledger = new Map<string, RecordRow>();
  public ledgerExists = false;
  public otherObjects = false;
  public identity = { database: target.database, schema: target.schema, schemas: [target.schema, "pg_catalog"] };
  public released = false;
  public failSql: string | undefined;
  public sqlFiles = new Set<string>();
  public catalog: FakeCatalog | undefined;

  public async query<Row>(sql: string, params: readonly unknown[] = []): Promise<{ rows: readonly Row[]; rowCount: number }> {
    this.calls.push(sql);
    if (this.failSql === sql) throw new Error("synthetic SQL failure");
    let rows: unknown[] = [];
    if (sql.includes("current_database() AS database")) rows = [this.identity];
    else if (sql.includes("pg_advisory_lock")) rows = [];
    else if (sql.includes("pg_advisory_unlock")) rows = [{ unlocked: true }];
    else if (sql.includes("c.relname = 'ulte_schema_migrations'")) rows = [{ present: this.ledgerExists }];
    else if (sql.includes("UNION ALL SELECT 1 FROM pg_proc")) rows = [{ present: this.otherObjects }];
    else if (sql.startsWith("CREATE TABLE ulte_schema_migrations")) this.ledgerExists = true;
    else if (sql.startsWith("SELECT stream, name, position, digest FROM ulte_schema_migrations") && params.length === 0)
      rows = [...this.ledger.values()];
    else if (sql.startsWith("SELECT stream, name, position, digest FROM ulte_schema_migrations"))
      rows = [this.ledger.get(`${params[0]}/${params[1]}`)].filter(Boolean);
    else if (sql.startsWith("INSERT INTO ulte_schema_migrations")) {
      const row = { stream: String(params[0]), name: String(params[1]), position: Number(params[2]), digest: String(params[3]) };
      this.ledger.set(`${row.stream}/${row.name}`, row);
    } else if (sql.startsWith("SELECT c.relname AS name FROM pg_catalog.pg_class")) rows = this.catalog?.tables ?? [];
    else if (sql.includes("pg_catalog.format_type(a.atttypid")) rows = this.catalog?.columns ?? [];
    else if (sql.includes("con.condeferrable AS deferrable")) rows = this.catalog?.constraints ?? [];
    else if (!sql.startsWith("SELECT ")) this.sqlFiles.add(sql);
    return { rows: rows as Row[], rowCount: rows.length };
  }
  public release(): void { this.released = true; }
}

function source(client: FakeClient): MigrationConnectionSource {
  return { connect: async () => client };
}
function codeOf(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error ? String(error.code) : undefined;
}

describe("root migration coordinator", () => {
  it("freezes exact stream precedence with the cross-store integration migration last", async () => {
    expect(MIGRATION_STREAMS).toEqual(["EXECUTION", "ORCHESTRATION", "INTEGRATION"]);
    expect(MIGRATION_MANIFEST.map(({ stream, name }) => `${stream}/${name}`)).toEqual([
      "EXECUTION/0001_execution_store.sql", "EXECUTION/0002_idempotency_state_machine.sql",
      "ORCHESTRATION/0001_orchestration_recovery_state.sql", "ORCHESTRATION/0002_orchestration_recovery_lease.sql",
      "ORCHESTRATION/0003_orchestration_pending_effects_and_outcomes.sql", "ORCHESTRATION/0004_execution_authority_checkpoint.sql",
      "ORCHESTRATION/0005_orchestration_commit_receipts.sql",
      "ORCHESTRATION/0006_terminal_non_submission_persistence.sql",
      "INTEGRATION/0001_terminal_non_submission_broker_idempotency_fk.sql",
    ]);
    expect(MIGRATION_MANIFEST.map((d) => d.position)).toEqual([1, 2, 1, 2, 3, 4, 5, 6, 1]);
    expect(MIGRATION_MANIFEST.at(-1)?.path).toBe(
      "migrations/integration/0001_terminal_non_submission_broker_idempotency_fk.sql");
    const loaded = await loadMigrations();
    expect(loaded.map((d) => d.digest)).toEqual(loaded.map((d) => digestSql(d.sql)));
    expect(loaded.every((d) => d.sql.trim().length > 0)).toBe(true);
    expect(digestSql("a")).toBe(digestSql("a"));
    expect(digestSql("a")).not.toBe(digestSql("b"));
  });

  it("keeps the integration SQL limited to a validated exact cross-store FK", async () => {
    const sql = (await loadMigrations()).at(-1)!.sql;
    expect(sql).toMatch(/^BEGIN;\s+ALTER TABLE orchestration_terminal_non_submission_disposition/);
    expect(sql).toContain("ADD CONSTRAINT orchestration_terminal_broker_idempotency_fk");
    expect(sql).toMatch(/FOREIGN KEY \(adapter_id, environment, idempotency_key\)/);
    expect(sql).toMatch(/REFERENCES broker_idempotency_records \(adapter_id, environment, idempotency_key\)/);
    expect(sql).toMatch(/COMMIT;\s*$/);
    expect(sql).not.toMatch(/NOT VALID|DEFERRABLE|INSERT|UPDATE|DELETE|SUBMITTED|TRADE/i);
  });

  it("bootstraps empty schema, applies in order, records after SQL, and uses one pinned client under lock", async () => {
    const client = new FakeClient();
    const loaded = await loadMigrations();
    const run = await runMigrations(source(client), target);
    expect(run.applied).toHaveLength(9);
    expect(run.skipped).toEqual([]);
    expect(client.sqlFiles.size).toBe(9);
    expect(client.calls.findIndex((s) => s.includes("pg_advisory_lock")))
      .toBeLessThan(client.calls.findIndex((s) => s.includes("c.relname = 'ulte_schema_migrations'")));
    for (const d of loaded) {
      const execute = client.calls.indexOf(d.sql);
      const ledger = client.calls.findIndex((s, i) => i > execute && s.startsWith("INSERT INTO ulte_schema_migrations"));
      expect(execute).toBeGreaterThan(-1);
      expect(ledger).toBeGreaterThan(execute);
    }
    expect(client.calls.at(-1)).toContain("pg_advisory_unlock");
    expect(client.released).toBe(true);
    expect(run.capability.status).toBe("DISABLED");
  });

  it("skips exact history and rejects a changed applied digest", async () => {
    const client = new FakeClient();
    await runMigrations(source(client), target);
    client.calls.length = 0;
    client.sqlFiles.clear();
    const replay = await runMigrations(source(client), target);
    expect(replay.skipped).toHaveLength(9);
    expect(client.sqlFiles.size).toBe(0);
    client.ledger.get("EXECUTION/0001_execution_store.sql")!.digest = digestSql("changed");
    await expect(runMigrations(source(client), target)).rejects.toSatisfy((e: unknown) =>
      codeOf(e) === "MIGRATION_HISTORY_CONFLICT");
    expect(client.calls.at(-1)).toContain("pg_advisory_unlock");
  });

  it("stops at failed SQL without ledgering it, then resumes from first missing migration", async () => {
    const client = new FakeClient();
    const migrations = await loadMigrations();
    client.failSql = migrations[2]!.sql;
    await expect(runMigrations(source(client), target)).rejects.toSatisfy((e: unknown) =>
      codeOf(e) === "MIGRATION_APPLY_FAILED");
    expect(client.ledger.size).toBe(2);
    expect(client.calls).not.toContain(migrations[3]!.sql);
    expect(client.calls.at(-1)).toContain("pg_advisory_unlock");
    client.failSql = undefined;
    client.calls.length = 0;
    const resumed = await runMigrations(source(client), target);
    expect(resumed.skipped).toHaveLength(2);
    expect(resumed.applied).toHaveLength(7);
    expect(client.calls).not.toContain(migrations[0]!.sql);
  });

  it("fails closed on existing unledgered schema and identity mismatch", async () => {
    const legacy = new FakeClient();
    legacy.otherObjects = true;
    await expect(runMigrations(source(legacy), target)).rejects.toSatisfy((e: unknown) =>
      codeOf(e) === "BASELINE_VERIFICATION_REQUIRED");
    expect(legacy.ledgerExists).toBe(false);
    expect(legacy.calls.at(-1)).toContain("pg_advisory_unlock");
    const mismatch = new FakeClient();
    mismatch.identity.schemas = [target.schema, "other", "pg_catalog"];
    await expect(runMigrations(source(mismatch), target)).rejects.toSatisfy((e: unknown) =>
      codeOf(e) === "SCHEMA_IDENTITY_MISMATCH");
    expect(mismatch.calls.some((s) => s.includes("pg_advisory_lock"))).toBe(false);
  });

  it("does not verify capability from ledger alone and exposes no enable override", async () => {
    expect(terminalSchemaCapability()).toEqual({
      capability: "TERMINAL_NON_SUBMISSION_PERSISTENCE", status: "DISABLED",
      reasons: ["SCHEMA_UNVERIFIED"],
    });
    const client = new FakeClient();
    await runMigrations(source(client), target);
    const capability = await verifyTerminalSchemaCapability(source(client), target);
    expect(capability.status).toBe("DISABLED");
    expect(capability.reasons).toContain("TABLE_MISSING:broker_idempotency_records");
    expect(Object.keys(terminalSchemaCapability())).not.toContain("enabled");
    expect(runMigrations.length).toBe(2);
  });

  it("verifies only exact normal broker FK catalog semantics", async () => {
    const client = new FakeClient();
    await runMigrations(source(client), target);
    const catalog = completeCatalog();
    client.catalog = catalog;
    const fkName = "orchestration_terminal_broker_idempotency_fk";
    const index = catalog.constraints.findIndex((c) => c.name === fkName);
    const normal = catalog.constraints[index]!;
    expect((await verifyTerminalSchemaCapability(source(client), target)).status).toBe("VERIFIED");
    const variants: readonly [string, Partial<CatalogConstraint>][] = [
      ["DEFERRABLE", { deferrable: true }],
      ["INITIALLY DEFERRED", { initially_deferred: true }],
      ["ON DELETE CASCADE", { delete_action: "c" }],
      ["ON UPDATE CASCADE", { update_action: "c" }],
      ["MATCH FULL", { match_type: "f" }],
      ["unvalidated", { validated: false }],
      ["wrong source order", { source_columns: ["environment", "adapter_id", "idempotency_key"] }],
      ["wrong target", { target_table: "other_table" }],
    ];
    for (const [label, change] of variants) {
      catalog.constraints[index] = { ...normal, ...change };
      expect((await verifyTerminalSchemaCapability(source(client), target)).reasons, label).toContain(
        "CONSTRAINT_MISMATCH:orchestration_terminal_non_submission_disposition.orchestration_terminal_broker_idempotency_fk");
    }
    catalog.constraints.splice(index, 1);
    expect((await verifyTerminalSchemaCapability(source(client), target)).status).toBe("DISABLED");
    catalog.constraints.splice(index, 0, normal);
    client.identity.schemas = [target.schema, "other", "pg_catalog"];
    expect((await verifyTerminalSchemaCapability(source(client), target)).reasons).toContain("SCHEMA_TOPOLOGY_MISMATCH");
    client.identity.schemas = [target.schema, "pg_catalog"];
    expect((await verifyTerminalSchemaCapability(source(client), target)).status).toBe("VERIFIED");
  });
});
