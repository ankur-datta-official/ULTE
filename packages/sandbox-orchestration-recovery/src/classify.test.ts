import { describe, expect, it } from "vitest";
import type { IdempotencyRecord, IdempotencyRecordStatus } from "@ulte/broker-adapters";
import type {
  ExecutionAuthorityCheckpoint, ExternalOutcomeAdoptionReceipt, OrchestrationExternalOutcome,
  OrchestrationPendingEffect, OrchestrationRecoveryRecord, PendingIntentCommitReceipt,
} from "@ulte/orchestration-state-store";
import { classifyRecoveryBoot } from "./classify.js";
import type { LoadedExternalOutcome, LoadedPendingEffect, RecoveryBootClassifierInput } from "./types.js";

const identity = Object.freeze({ executionAttemptId: "attempt-1", executionPlanId: "plan-1",
  tradeIntentId: "intent-1", candidateId: "candidate-1", instrumentId: "instrument-1" });

function typed<T>(value: unknown): T { return value as T; }

function recovery(): OrchestrationRecoveryRecord {
  return typed({ schemaVersion: "ORCHESTRATION_RECOVERY_RECORD_V1", sessionId: "session-1",
    revision: 3, fenceToken: 7, mode: "SANDBOX", instrumentId: "instrument-1",
    executionAuthorityCheckpointRef: "checkpoint-3", executionAuthorityIdentity: identity,
    riskBasisCheckpointRef: null, latestROutcomeRef: null });
}
function checkpoint(): ExecutionAuthorityCheckpoint {
  return typed({ schemaVersion: "EXECUTION_AUTHORITY_CHECKPOINT_V1", checkpointRef: "checkpoint-3",
    evidence: { identity } });
}
function effect(key = "key-1", fingerprint = "fingerprint-1"): OrchestrationPendingEffect {
  return typed({ schemaVersion: "ORCHESTRATION_PENDING_EFFECT_V1", sessionId: "session-1",
    adapterId: "adapter-1", environment: "SANDBOX", operation: "ENTRY_SUBMISSION",
    executionAttemptId: "attempt-1", idempotencyKey: key, requestFingerprint: fingerprint,
    createdRevision: 2, createdFence: 7, state: "PENDING", resolvedOutcomeKey: null,
    resolvedRevision: null, resolvedFence: null });
}
function record(pending: OrchestrationPendingEffect, status: IdempotencyRecordStatus): IdempotencyRecord {
  return typed({ adapterId: pending.adapterId, environment: pending.environment,
    operation: pending.operation, executionAttemptId: pending.executionAttemptId,
    idempotencyKey: pending.idempotencyKey, requestFingerprint: pending.requestFingerprint,
    status, createdAt: 1, updatedAt: 2 });
}
function pending(status: IdempotencyRecordStatus | "ABSENT" = "ABSENT", key = "key-1"): LoadedPendingEffect {
  const value = effect(key, `fingerprint-${key}`);
  const receipt = typed<PendingIntentCommitReceipt>({ sessionId: value.sessionId,
    committedRevision: value.createdRevision, committedFence: value.createdFence,
    committedCheckpointRef: "checkpoint-2", pendingEffect: value });
  return { effect: value, creationProof: { kind: "PENDING_INTENT_COMMIT", receipt },
    idempotency: status === "ABSENT" ? { status: "ABSENT" } : { status: "PRESENT", record: record(value, status) } };
}
function outcome(kind: "CANONICAL_EXECUTION_TRANSITION" | "BROKER_DISPOSITION",
  status: string, linked: OrchestrationPendingEffect | null = effect(), key = "outcome-1"): LoadedExternalOutcome {
  const observation = kind === "BROKER_DISPOSITION"
    ? { kind, disposition: { status } }
    : { kind, transition: { kind: status } };
  return { outcome: typed<OrchestrationExternalOutcome>({ schemaVersion: "ORCHESTRATION_EXTERNAL_OUTCOME_V1",
    outcomeKey: key, sessionId: "session-1", executionAttemptId: "attempt-1", observedAt: 3,
    observedFence: 7, pendingEffectIdentity: linked, observation }), adoptionReceipt: null };
}
function facts(overrides: Partial<RecoveryBootClassifierInput> = {}): RecoveryBootClassifierInput {
  return { recovery: recovery(), ownerId: typed("owner-1"), lease: "VALID",
    checkpoint: { status: "VALID", checkpoint: checkpoint() }, evidence: "COMPLETE",
    pendingEffects: [], outcomes: [], ...overrides };
}
function classify(overrides: Partial<RecoveryBootClassifierInput> = {}) {
  return classifyRecoveryBoot(facts(overrides));
}

describe("recovery boot classification", () => {
  it("R0 returns READY only for a complete clean snapshot", () => {
    expect(classify()).toMatchObject({ status: "READY", checkpointRef: "checkpoint-3",
      recoveryRevision: 3, ownerId: "owner-1", fenceToken: 7 });
  });

  it.each(["ABSENT", "CLAIMED", "RETRY_AUTHORIZED"] as const)(
    "R1/R2 leaves %s pending for intent disposition", (state) => {
      const result = classify({ pendingEffects: [pending(state)] });
      expect(result.status).toBe("INTENT_DISPOSITION_REQUIRED");
      if (result.status === "INTENT_DISPOSITION_REQUIRED") {
        expect(result.creationRef.committedCheckpointRef).toBe("checkpoint-2");
        expect(result.idempotency.status).toBe(state === "ABSENT" ? "ABSENT" : "PRESENT");
      }
    });

  it.each(["SUBMITTED", "OUTCOME_UNKNOWN"] as const)(
    "R3 routes %s to reconciliation", (state) => {
      const result = classify({ pendingEffects: [{ ...pending(state), reconciliationRequestId: "reconcile-1" }] });
      expect(result).toMatchObject({ status: "RECONCILIATION_REQUIRED",
        reconciliationRequestId: "reconcile-1" });
    });

  it.each(["ENTRY_SUBMISSION_ACKNOWLEDGED", "ENTRY_SUBMISSION_REJECTED"] as const)(
    "R4 exposes unadopted canonical %s", (transition) => {
      const p = pending(transition === "ENTRY_SUBMISSION_REJECTED" ? "REJECTED" : "CONFIRMED");
      const result = classify({ pendingEffects: [p], outcomes: [outcome("CANONICAL_EXECUTION_TRANSITION",
        transition, p.effect)] });
      expect(result).toMatchObject({ status: "OUTCOME_AVAILABLE", outcomeKey: "outcome-1",
        transitionKind: transition, priorCheckpointRef: "checkpoint-3" });
    });

  it("R5 reclassifies an adopted outcome to READY", () => {
    const o = outcome("CANONICAL_EXECUTION_TRANSITION", "ENTRY_FILL_APPLIED", null);
    const receipt = typed<ExternalOutcomeAdoptionReceipt>({ outcomeKey: o.outcome.outcomeKey,
      sessionId: o.outcome.sessionId, executionAttemptId: o.outcome.executionAttemptId,
      adoptedRevision: 3, linkedPendingResolution: null });
    expect(classify({ outcomes: [{ ...o, adoptionReceipt: receipt }] }).status).toBe("READY");
  });

  it("R5 adoption does not hide another ambiguous effect", () => {
    const o = outcome("CANONICAL_EXECUTION_TRANSITION", "ENTRY_FILL_APPLIED", null);
    const receipt = typed<ExternalOutcomeAdoptionReceipt>({ outcomeKey: o.outcome.outcomeKey,
      sessionId: o.outcome.sessionId, executionAttemptId: o.outcome.executionAttemptId,
      adoptedRevision: 3, linkedPendingResolution: null });
    expect(classify({ outcomes: [{ ...o, adoptionReceipt: receipt }],
      pendingEffects: [pending("OUTCOME_UNKNOWN", "key-2")] }).status).toBe("RECONCILIATION_REQUIRED");
  });

  it("R6 STILL_UNKNOWN requires reconciliation", () => {
    const p = pending("OUTCOME_UNKNOWN");
    expect(classify({ pendingEffects: [p], outcomes: [outcome("BROKER_DISPOSITION",
      "STILL_UNKNOWN", p.effect)] }).status).toBe("RECONCILIATION_REQUIRED");
  });
  it("R6 definite non-submission plus retry authorization remains a disposition", () => {
    const p = pending("RETRY_AUTHORIZED");
    expect(classify({ pendingEffects: [p], outcomes: [outcome("BROKER_DISPOSITION",
      "CONFIRMED_NOT_SUBMITTED", p.effect)] }).status).toBe("INTENT_DISPOSITION_REQUIRED");
  });
  it.each([["CONFIRMED_ACCEPTED", "CONFIRMED"], ["CONFIRMED_REJECTED", "REJECTED"]] as const)(
    "R6 %s requires a canonical outcome", (disposition, state) => {
      const p = pending(state);
      const result = classify({ pendingEffects: [p], outcomes: [outcome("BROKER_DISPOSITION",
        disposition, p.effect)] });
      expect(result).toMatchObject({ status: "CANONICAL_OUTCOME_REQUIRED",
        dispositionOutcomeKey: "outcome-1" });
    });
  it("never exposes BROKER_DISPOSITION as an adoptable outcome", () => {
    const p = pending("CONFIRMED");
    expect(classify({ pendingEffects: [p], outcomes: [outcome("BROKER_DISPOSITION",
      "CONFIRMED_ACCEPTED", p.effect)] }).status).not.toBe("OUTCOME_AVAILABLE");
  });
  it("R7 rejects terminal FAILED_NOT_SUBMITTED", () => {
    expect(classify({ pendingEffects: [pending("FAILED_NOT_SUBMITTED")] })).toMatchObject({
      status: "RECOVERY_REJECTED", reason: "UNSUPPORTED_TERMINAL_NON_SUBMISSION" });
  });

  it("R9 rejects stale fence", () => {
    expect(classify({ lease: "INVALID" })).toMatchObject({ status: "RECOVERY_REJECTED",
      reason: "LEASE_OR_FENCE_INVALID" });
  });
  it("R10 rejects missing checkpoint", () => {
    expect(classify({ checkpoint: { status: "MISSING" } })).toMatchObject({
      status: "RECOVERY_REJECTED", reason: "CHECKPOINT_MISSING" });
  });
  it("R10 rejects missing creation proof", () => {
    expect(classify({ pendingEffects: [{ ...pending(), creationProof: null }] })).toMatchObject({
      status: "RECOVERY_REJECTED", reason: "PENDING_CREATION_PROOF_MISSING" });
  });
  it("R11 rejects a different fingerprint", () => {
    const p = pending("CLAIMED");
    if (p.idempotency.status !== "PRESENT") throw new Error("fixture");
    const mismatched = { ...p, idempotency: { status: "PRESENT" as const,
      record: { ...p.idempotency.record, requestFingerprint: typed("different") } } };
    expect(classify({ pendingEffects: [mismatched] })).toMatchObject({
      status: "RECOVERY_REJECTED", reason: "FINGERPRINT_CONFLICT" });
  });
  it("R8 rejects an outcome for another attempt", () => {
    const o = outcome("CANONICAL_EXECUTION_TRANSITION", "ENTRY_FILL_APPLIED", null);
    expect(classify({ outcomes: [{ ...o, outcome: { ...o.outcome, executionAttemptId: "other" } }] }))
      .toMatchObject({ status: "RECOVERY_REJECTED", reason: "AUTHORITY_IDENTITY_MISMATCH" });
  });
  it("R8 rejects competing canonical outcomes for one pending identity", () => {
    const p = pending("CONFIRMED");
    expect(classify({ pendingEffects: [p], outcomes: [
      outcome("CANONICAL_EXECUTION_TRANSITION", "ENTRY_SUBMISSION_ACKNOWLEDGED", p.effect, "o-1"),
      outcome("CANONICAL_EXECUTION_TRANSITION", "ENTRY_SUBMISSION_REJECTED", p.effect, "o-2"),
    ] })).toMatchObject({ status: "RECOVERY_REJECTED", reason: "CONFLICTING_CANONICAL_OUTCOMES" });
  });
  it("R11 rejects a canonical acknowledgement with no durable idempotency claim", () => {
    const p = pending();
    expect(classify({ pendingEffects: [p], outcomes: [outcome("CANONICAL_EXECUTION_TRANSITION",
      "ENTRY_SUBMISSION_ACKNOWLEDGED", p.effect)] })).toMatchObject({
      status: "RECOVERY_REJECTED", reason: "PENDING_OUTCOME_CONTRADICTION" });
  });
  it("R11 rejects a canonical rejection against a confirmed acceptance", () => {
    const p = pending("CONFIRMED");
    expect(classify({ pendingEffects: [p], outcomes: [outcome("CANONICAL_EXECUTION_TRANSITION",
      "ENTRY_SUBMISSION_REJECTED", p.effect)] })).toMatchObject({
      status: "RECOVERY_REJECTED", reason: "PENDING_OUTCOME_CONTRADICTION" });
  });
  it("rejects a linked canonical outcome with no pending proof", () => {
    expect(classify({ outcomes: [outcome("CANONICAL_EXECUTION_TRANSITION",
      "ENTRY_SUBMISSION_ACKNOWLEDGED")] })).toMatchObject({
      status: "RECOVERY_REJECTED", reason: "PENDING_OUTCOME_CONTRADICTION" });
  });
  it("rejects a submission transition with no pending link", () => {
    expect(classify({ outcomes: [outcome("CANONICAL_EXECUTION_TRANSITION",
      "ENTRY_SUBMISSION_ACKNOWLEDGED", null)] })).toMatchObject({
      status: "RECOVERY_REJECTED", reason: "PENDING_OUTCOME_CONTRADICTION" });
  });
  it("rejects an adoption receipt paired with a still-unresolved effect", () => {
    const p = pending("CONFIRMED");
    const o = outcome("CANONICAL_EXECUTION_TRANSITION", "ENTRY_SUBMISSION_ACKNOWLEDGED", p.effect);
    const receipt = typed<ExternalOutcomeAdoptionReceipt>({ outcomeKey: o.outcome.outcomeKey,
      sessionId: o.outcome.sessionId, executionAttemptId: o.outcome.executionAttemptId,
      adoptedRevision: 3, linkedPendingResolution: { outcomeKey: o.outcome.outcomeKey,
        pendingEffectIdentity: p.effect } });
    expect(classify({ pendingEffects: [p], outcomes: [{ ...o, adoptionReceipt: receipt }] }))
      .toMatchObject({ status: "RECOVERY_REJECTED", reason: "RECEIPT_CONTRADICTION" });
  });

  it("rejection beats reconciliation", () => {
    expect(classify({ pendingEffects: [pending("SUBMITTED"), pending("FAILED_NOT_SUBMITTED", "key-2")] })
      .status).toBe("RECOVERY_REJECTED");
  });
  it("reconciliation beats another available outcome", () => {
    expect(classify({ pendingEffects: [pending("SUBMITTED")], outcomes: [outcome(
      "CANONICAL_EXECUTION_TRANSITION", "ENTRY_FILL_APPLIED", null, "fill-1")] })
      .status).toBe("RECONCILIATION_REQUIRED");
  });
  it("available outcome beats another pending disposition", () => {
    expect(classify({ pendingEffects: [pending()], outcomes: [outcome(
      "CANONICAL_EXECUTION_TRANSITION", "ENTRY_FILL_APPLIED", null, "fill-1")] })
      .status).toBe("OUTCOME_AVAILABLE");
  });
  it.each(["UNAVAILABLE", "CORRUPT"] as const)("incomplete %s evidence cannot be READY", (state) => {
    expect(classify({ evidence: state }).status).toBe("RECOVERY_REJECTED");
  });
  it("is deterministic and does not mutate input, including arrays", () => {
    const input = facts({ pendingEffects: [pending("CLAIMED", "key-z"), pending("SUBMITTED", "key-a")],
      outcomes: [outcome("CANONICAL_EXECUTION_TRANSITION", "ENTRY_FILL_APPLIED", null, "z"),
        outcome("CANONICAL_EXECUTION_TRANSITION", "ENTRY_FILL_APPLIED", null, "a")] });
    const before = JSON.stringify(input);
    const first = classifyRecoveryBoot(input);
    expect(classifyRecoveryBoot(input)).toEqual(first);
    expect(JSON.stringify(input)).toBe(before);
    expect(first.status).toBe("RECONCILIATION_REQUIRED");
  });
});
