import { describe, expect, it } from "vitest";
import {
  MIGRATION_MANIFEST, MIGRATION_STREAMS, digestSql, loadMigrations, runMigrations,
  terminalSchemaCapability, type MigrationConnectionSource, type PinnedMigrationClient,
} from "./index.js";

const target = { database: "ulte_test", schema: "ulte_app" };
type RecordRow = { stream: string; name: string; position: number; digest: string };

class FakeClient implements PinnedMigrationClient {
  public readonly calls: string[] = [];
  public readonly ledger = new Map<string, RecordRow>();
  public ledgerExists = false;
  public otherObjects = false;
  public identity = { database: target.database, schema: target.schema, schemas: [target.schema, "pg_catalog"] };
  public released = false;
  public failSql: string | undefined;
  public sqlFiles = new Set<string>();

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
    } else this.sqlFiles.add(sql);
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
  it("freezes exact stream precedence and existing manifest with empty integration", async () => {
    expect(MIGRATION_STREAMS).toEqual(["EXECUTION", "ORCHESTRATION", "INTEGRATION"]);
    expect(MIGRATION_MANIFEST.map(({ stream, name }) => `${stream}/${name}`)).toEqual([
      "EXECUTION/0001_execution_store.sql", "EXECUTION/0002_idempotency_state_machine.sql",
      "ORCHESTRATION/0001_orchestration_recovery_state.sql", "ORCHESTRATION/0002_orchestration_recovery_lease.sql",
      "ORCHESTRATION/0003_orchestration_pending_effects_and_outcomes.sql", "ORCHESTRATION/0004_execution_authority_checkpoint.sql",
      "ORCHESTRATION/0005_orchestration_commit_receipts.sql",
      "ORCHESTRATION/0006_terminal_non_submission_persistence.sql",
    ]);
    expect(MIGRATION_MANIFEST.map((d) => d.position)).toEqual([1, 2, 1, 2, 3, 4, 5, 6]);
    const loaded = await loadMigrations();
    expect(loaded.map((d) => d.digest)).toEqual(loaded.map((d) => digestSql(d.sql)));
    expect(loaded.every((d) => d.sql.trim().length > 0)).toBe(true);
    expect(digestSql("a")).toBe(digestSql("a"));
    expect(digestSql("a")).not.toBe(digestSql("b"));
  });

  it("bootstraps empty schema, applies in order, records after SQL, and uses one pinned client under lock", async () => {
    const client = new FakeClient();
    const loaded = await loadMigrations();
    const run = await runMigrations(source(client), target);
    expect(run.applied).toHaveLength(8);
    expect(run.skipped).toEqual([]);
    expect(client.sqlFiles.size).toBe(8);
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
    expect(replay.skipped).toHaveLength(8);
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
    expect(resumed.applied).toHaveLength(6);
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

  it("keeps terminal persistence disabled with no enable override", () => {
    expect(terminalSchemaCapability()).toEqual({
      capability: "TERMINAL_NON_SUBMISSION_PERSISTENCE", status: "DISABLED",
      reasons: ["INTEGRATION_0001_ABSENT", "TERMINAL_CATALOG_UNVERIFIED"],
    });
    expect(Object.keys(terminalSchemaCapability())).not.toContain("enabled");
    expect(runMigrations.length).toBe(2);
  });
});
