import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const sql = readFileSync(fileURLToPath(new URL("../migrations/0006_terminal_non_submission_persistence.sql",
  import.meta.url)), "utf8");

describe("orchestration terminal migration 0006 structural contract", () => {
  it("versions recovery and pending rows without changing historical receipts", () => {
    expect(sql).toContain("ADD COLUMN terminal_non_submission_disposition_ref TEXT");
    expect(sql).toContain("ORCHESTRATION_RECOVERY_RECORD_V2");
    expect(sql).toContain("RENAME COLUMN resolved_outcome_key TO resolved_authority_ref");
    expect(sql).toContain("ADD COLUMN resolution_kind TEXT");
    expect(sql).toContain("SET resolution_kind = 'EXTERNAL_OUTCOME' WHERE state = 'RESOLVED'");
    expect(sql).toMatch(/state = 'PENDING' AND resolution_kind IS NULL AND resolved_authority_ref IS NULL/);
    expect(sql).toMatch(/state = 'RESOLVED' AND resolution_kind IN \('EXTERNAL_OUTCOME', 'TERMINAL_NON_SUBMISSION'\)/);
    expect(sql).not.toContain("UPDATE orchestration_pending_intent_commit");
    expect(sql).not.toContain("broker_idempotency_records");
  });
  it("supports receipt then pending resolution then recovery reference with exact local FKs", () => {
    const table = sql.indexOf("CREATE TABLE orchestration_terminal_non_submission_disposition");
    const recoveryFk = sql.indexOf("ADD CONSTRAINT orchestration_recovery_terminal_receipt_fk");
    expect(table).toBeGreaterThan(-1);
    expect(recoveryFk).toBeGreaterThan(table);
    expect(sql).toContain("session_id TEXT NOT NULL UNIQUE REFERENCES orchestration_recovery_state (session_id)");
    expect(sql).toContain("unchanged_checkpoint_ref TEXT NOT NULL REFERENCES orchestration_execution_authority_checkpoint (checkpoint_ref)");
    expect(sql).toContain("UNIQUE (adapter_id, environment, idempotency_key)");
    expect(sql).toContain("FOREIGN KEY (session_id, adapter_id, environment, operation, execution_attempt_id, idempotency_key, request_fingerprint)");
    expect(sql).toContain("disposition_ref TEXT NOT NULL PRIMARY KEY");
    expect(sql).toContain("CHECK (committed_revision = expected_revision + 1)");
    expect(sql).not.toMatch(/terminal_non_submission_disposition_ref TEXT NOT NULL/);
  });
  it("freezes receipts and terminal recovery while permitting lease fence synchronization", () => {
    expect(sql).toContain("CREATE TRIGGER orchestration_terminal_receipt_immutable_before_update");
    expect(sql).toContain("CREATE TRIGGER orchestration_terminal_receipt_immutable_before_delete");
    expect(sql).toContain("OLD.terminal_non_submission_disposition_ref IS NOT NULL");
    expect(sql).toContain("NEW.revision IS DISTINCT FROM OLD.revision");
    expect(sql).toContain("NEW.execution_authority_checkpoint_ref IS DISTINCT FROM OLD.execution_authority_checkpoint_ref");
    expect(sql).toContain("NEW.fence_token <> OLD.fence_token + 1");
    expect(sql).toContain("lease.fence_token = NEW.fence_token");
    expect(sql).not.toContain("NEW.fence_token IS DISTINCT FROM OLD.fence_token");
  });
});
