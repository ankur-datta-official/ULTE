import { describe, expect, it } from "vitest";
import { createInstrumentId, unixMs } from "@ulte/instrument-model";
import {
  createOrchestrationRecoveryRecord,
  executionAuthorityCheckpointId,
  latestROutcomeId,
  orchestrationFenceToken,
  orchestrationLeaseDurationMs,
  orchestrationLeaseOwnerId,
  orchestrationRevision,
  orchestrationSessionId,
  riskBasisCheckpointId,
  ORCHESTRATION_RECOVERY_RECORD_SCHEMA_VERSION,
  type OrchestrationLeaseAcquireResult,
  type OrchestrationLeaseReleaseResult,
  type OrchestrationLeaseRenewResult,
  type OrchestrationRecoverySaveResult,
} from "./index.js";

const instrument = createInstrumentId({ venue: "TEST", venueSymbol: "ONE", instrumentKind: "SPOT" });
const identity = {
  executionAttemptId: "attempt-1",
  executionPlanId: "plan-1",
  tradeIntentId: "intent-1",
  candidateId: "candidate-1",
  instrumentId: instrument,
};
const base = {
  schemaVersion: ORCHESTRATION_RECOVERY_RECORD_SCHEMA_VERSION,
  sessionId: "session-1",
  revision: 0,
  fenceToken: 1,
  mode: "SANDBOX",
  instrumentId: instrument,
  executionAuthorityCheckpointRef: null,
  executionAuthorityIdentity: null,
  riskBasisCheckpointRef: null,
  latestROutcomeRef: null,
};
const execution = {
  ...base,
  executionAuthorityCheckpointRef: "checkpoint-1",
  executionAuthorityIdentity: identity,
};

describe("durable orchestration recovery contracts", () => {
  it("maps V1 without terminal authority and requires a canonical terminal V2 ref", () => {
    const v1 = createOrchestrationRecoveryRecord(execution);
    expect(v1.schemaVersion).toBe("ORCHESTRATION_RECOVERY_RECORD_V1");
    expect(v1.terminalNonSubmissionDispositionRef).toBeUndefined();
    const terminal = createOrchestrationRecoveryRecord({ ...execution,
      schemaVersion: "ORCHESTRATION_RECOVERY_RECORD_V2",
      terminalNonSubmissionDispositionRef: "terminal-1" });
    expect(terminal.terminalNonSubmissionDispositionRef).toBe("terminal-1");
    expect(terminal.executionAuthorityCheckpointRef).toBe(v1.executionAuthorityCheckpointRef);
    for (const ref of [undefined, null, "", " terminal-1 "]) {
      expect(() => createOrchestrationRecoveryRecord({ ...execution,
        schemaVersion: "ORCHESTRATION_RECOVERY_RECORD_V2",
        terminalNonSubmissionDispositionRef: ref })).toThrow();
    }
    expect(() => createOrchestrationRecoveryRecord({ ...execution,
      terminalNonSubmissionDispositionRef: "terminal-1" })).toThrow();
    expect(() => createOrchestrationRecoveryRecord({ ...base,
      schemaVersion: "ORCHESTRATION_RECOVERY_RECORD_V2",
      terminalNonSubmissionDispositionRef: "terminal-1" })).toThrow();
  });
  it("accepts canonical caller-supplied IDs and rejects blank or untrimmed IDs", () => {
    expect(orchestrationSessionId("session-1")).toBe("session-1");
    expect(orchestrationLeaseOwnerId("worker-1")).toBe("worker-1");
    expect(executionAuthorityCheckpointId("checkpoint-1")).toBe("checkpoint-1");
    expect(riskBasisCheckpointId("risk-1")).toBe("risk-1");
    expect(latestROutcomeId("r-1")).toBe("r-1");
    for (const make of [orchestrationSessionId, orchestrationLeaseOwnerId,
      executionAuthorityCheckpointId, riskBasisCheckpointId, latestROutcomeId]) {
      for (const value of ["", " ", " id ", null, 1]) expect(() => make(value)).toThrow(TypeError);
    }
  });

  it("requires safe revisions, positive safe fences and positive safe lease duration", () => {
    expect(orchestrationRevision(0)).toBe(0);
    expect(orchestrationRevision(8)).toBe(8);
    expect(orchestrationFenceToken(1)).toBe(1);
    expect(orchestrationLeaseDurationMs(1_000)).toBe(1_000);
    for (const value of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, NaN, "1"]) {
      expect(() => orchestrationRevision(value)).toThrow(TypeError);
    }
    for (const make of [orchestrationFenceToken, orchestrationLeaseDurationMs]) {
      for (const value of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, Infinity, "1"]) {
        expect(() => make(value)).toThrow(TypeError);
      }
    }
  });

  it("freezes a valid empty session and a copied execution trade identity", () => {
    const empty = createOrchestrationRecoveryRecord(base);
    expect(empty.sessionId).toBe("session-1");
    expect(empty.executionAuthorityIdentity).toBeNull();
    expect(Object.isFrozen(empty)).toBe(true);
    const record = createOrchestrationRecoveryRecord(execution);
    expect(record.executionAuthorityCheckpointRef).toBe("checkpoint-1");
    expect(record.executionAuthorityIdentity).toEqual(identity);
    expect(record.executionAuthorityIdentity).not.toBe(identity);
    expect(Object.isFrozen(record.executionAuthorityIdentity)).toBe(true);
    expect(Object.keys(record)).toEqual(Object.keys(base));
  });

  it("accepts risk and latest-R references only on a coherent execution chain", () => {
    expect(createOrchestrationRecoveryRecord({ ...execution, riskBasisCheckpointRef: "risk-1" }).latestROutcomeRef).toBeNull();
    const full = createOrchestrationRecoveryRecord({
      ...execution, riskBasisCheckpointRef: "risk-1", latestROutcomeRef: "r-1",
    });
    expect(full.riskBasisCheckpointRef).toBe("risk-1");
    expect(full.latestROutcomeRef).toBe("r-1");
  });

  it("rejects malformed rows, incoherent identity, and missing upstream references", () => {
    const otherInstrument = createInstrumentId({ venue: "TEST", venueSymbol: "OTHER", instrumentKind: "SPOT" });
    const invalid = [
      null,
      { ...base, schemaVersion: "OLD" },
      { ...base, sessionId: " " },
      { ...base, revision: -1 },
      { ...base, revision: 1.5 },
      { ...base, fenceToken: 0 },
      { ...base, mode: "LIVE" },
      { ...base, instrumentId: "bad" },
      { ...base, extra: true },
      { ...base, executionAuthorityCheckpointRef: "checkpoint-1" },
      { ...base, executionAuthorityIdentity: identity },
      { ...execution, executionAuthorityIdentity: { ...identity, instrumentId: otherInstrument } },
      { ...execution, executionAuthorityIdentity: { ...identity, tradeIntentId: " " } },
      { ...execution, executionAuthorityIdentity: { ...identity, extra: true } },
      { ...base, riskBasisCheckpointRef: "risk-1" },
      { ...base, latestROutcomeRef: "r-1" },
      { ...execution, latestROutcomeRef: "r-1" },
      { ...execution, executionAuthorityCheckpointRef: " " },
      { ...execution, riskBasisCheckpointRef: " " },
      { ...execution, riskBasisCheckpointRef: "risk-1", latestROutcomeRef: " " },
      { ...base, revision: Infinity },
    ];
    for (const candidate of invalid) expect(() => createOrchestrationRecoveryRecord(candidate)).toThrow(TypeError);
    const cyclic: Record<string, unknown> = { ...base };
    cyclic["executionAuthorityIdentity"] = cyclic;
    expect(() => createOrchestrationRecoveryRecord(cyclic)).toThrow(TypeError);
    expect(() => createOrchestrationRecoveryRecord({ ...base, [Symbol("metadata")]: true })).toThrow(TypeError);
    const accessor = { ...base };
    Object.defineProperty(accessor, "sessionId", { get: () => "session-1", enumerable: true });
    expect(() => createOrchestrationRecoveryRecord(accessor)).toThrow(TypeError);
  });

  it("exposes distinct CAS and lease contention outcomes", () => {
    const record = createOrchestrationRecoveryRecord(base);
    const saved: OrchestrationRecoverySaveResult = { status: "SAVED", record, newRevision: record.revision };
    const revisionConflict: OrchestrationRecoverySaveResult = { status: "REVISION_CONFLICT", currentRevision: record.revision };
    const fenceConflict: OrchestrationRecoverySaveResult = { status: "FENCE_CONFLICT", currentFence: record.fenceToken };
    const missing: OrchestrationRecoverySaveResult = { status: "NOT_FOUND" };
    expect([saved.status, revisionConflict.status, fenceConflict.status, missing.status]).toEqual([
      "SAVED", "REVISION_CONFLICT", "FENCE_CONFLICT", "NOT_FOUND",
    ]);
    const acquired: OrchestrationLeaseAcquireResult = {
      status: "ACQUIRED",
      lease: { sessionId: record.sessionId, ownerId: orchestrationLeaseOwnerId("worker-1"), fenceToken: record.fenceToken, expiresAt: unixMs(1_000) },
    };
    const held: OrchestrationLeaseAcquireResult = { status: "HELD_BY_OTHER", expiresAt: unixMs(1_000) };
    const renewed: OrchestrationLeaseRenewResult = { status: "RENEWED", lease: acquired.lease };
    const lost: OrchestrationLeaseRenewResult = { status: "LEASE_LOST" };
    const released: OrchestrationLeaseReleaseResult = { status: "RELEASED" };
    const notHeld: OrchestrationLeaseReleaseResult = { status: "NOT_HELD" };
    expect([acquired.status, held.status, renewed.status, lost.status, released.status, notHeld.status]).toEqual([
      "ACQUIRED", "HELD_BY_OTHER", "RENEWED", "LEASE_LOST", "RELEASED", "NOT_HELD",
    ]);
  });
});
