import { describe, expect, it } from "vitest";
import { createTerminalNonSubmissionDispositionV1 } from "@ulte/orchestration-state-store";
import { PostgresTerminalNonSubmissionCommitService, TerminalCommitError } from "./terminal-commit-service.js";
import type { PostgresExecutor, PostgresTransaction } from "./postgres.js";

function request() {
  const identity = { adapterId: "adapter-1", environment: "SANDBOX", operation: "ENTRY_SUBMISSION",
    executionAttemptId: "attempt-1", idempotencyKey: "key-1", requestFingerprint: "fingerprint-1" };
  const d = createTerminalNonSubmissionDispositionV1({
    schemaVersion: "TERMINAL_NON_SUBMISSION_DISPOSITION_V1", dispositionRef: "terminal-1",
    sessionId: "session-1", executionAttemptId: "attempt-1", pendingEffectIdentity: identity,
    pendingCreatedRevision: 2, pendingCreatedFence: 3,
    pendingCreationRef: { kind: "PENDING_INTENT_COMMIT", committedCheckpointRef: "checkpoint-2",
      committedRevision: 2 }, expectedRecoveryRevision: 2, committedRevision: 3,
    committedFence: 3, committingOwnerId: "owner-1",
    executionAuthorityCheckpointRefBefore: "checkpoint-2",
    executionAuthorityCheckpointRefAfter: "checkpoint-2",
    executionAuthorityIdentity: { executionAttemptId: "attempt-1", executionPlanId: "plan-1",
      tradeIntentId: "intent-1", candidateId: "candidate-1",
      instrumentId: "ulte:v1:venue:EQUITY:ABC" }, mode: "SANDBOX",
    instrumentId: "ulte:v1:venue:EQUITY:ABC", riskBasisCheckpointRef: null,
    latestROutcomeRef: null,
    proof: { schemaVersion: "TERMINAL_NON_SUBMISSION_PROOF_V1",
      sourceKind: "TRUSTED_ADAPTER_FAILURE", sourceEventRef: "event-1", observedAt: 1234,
      category: "INVALID_REQUEST", certainty: "DEFINITE_FAILURE",
      submissionExposure: "NOT_SUBMITTED", retryDisposition: "DO_NOT_RETRY",
      pendingEffectIdentity: identity },
    sessionDisposition: "TERMINAL_NON_SUBMISSION",
    resolution: { kind: "TERMINAL_NON_SUBMISSION", resolvedRevision: 3, resolvedFence: 3 },
  });
  const { schemaVersion: _version, committedFence: _fence, committingOwnerId: _owner,
    resolution, ...rest } = d;
  return { ownerId: d.committingOwnerId, expectedFence: d.committedFence,
    disposition: { ...rest, resolution: { kind: resolution.kind,
      resolvedRevision: resolution.resolvedRevision } } };
}

describe("D3 capability gate on the transaction connection", () => {
  it("fails closed before any write when the current database differs from the target", async () => {
    const calls: string[] = [];
    const executor: PostgresExecutor = {
      query: async () => { throw new Error("outside-transaction query"); },
      transaction: async <T>(work: (tx: PostgresTransaction) => Promise<T>) => {
        calls.push("BEGIN");
        try {
          const result = await work({ query: async <Row>(sql: string) => {
            calls.push(sql);
            return { rows: [{ database: "other", schema: "test", schemas: ["test", "pg_catalog"] }] as Row[],
              rowCount: 1 };
          } });
          calls.push("COMMIT"); return result;
        } catch (error) { calls.push("ROLLBACK"); throw error; }
      },
    };
    const service = new PostgresTerminalNonSubmissionCommitService(executor,
      { database: "expected", schema: "test" });
    await expect(service.commitTerminalNonSubmissionDisposition(request()))
      .rejects.toSatisfy((error: unknown) => error instanceof TerminalCommitError
        && error.code === "CAPABILITY_UNAVAILABLE");
    expect(calls).toHaveLength(3);
    expect(calls[0]).toBe("BEGIN"); expect(calls[1]).toContain("current_database()");
    expect(calls[2]).toBe("ROLLBACK");
  });
});
