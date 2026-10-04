import { describe, expect, it } from "vitest";
import { brokerAdapterId, fingerprintEntryCancellation, fingerprintEntrySubmission,
  fingerprintProtectionRequest } from "@ulte/broker-adapters";
import { requestEntryCancellation, requestEntrySubmission, requestProtection,
  restoreExecutionAttemptFromEvidence, type ExecutionAttemptRecoveryTransition } from "@ulte/execution-engine";
import { checkpointEvidence } from "../../../tests/integration/phase33b-checkpoint-fixture.js";
import {
  createExecutionAuthorityCheckpoint, createExternalOutcomeAdoptionReceipt,
  createOrchestrationRecoveryRecord, createOutcomeAdoptionRecoveryState,
  createOrchestrationExternalOutcome, createOrchestrationPendingEffect, createPendingIntentCommitReceipt,
  executionAuthorityCheckpointId,
  equivalentOutcomeAdoptionRetry, equivalentPendingIntentRetry,
  proveExecutionCheckpointAdvance, proveOutcomeAdoptionCheckpointAdvance,
  provePendingIntentCheckpointAdvance,
  ORCHESTRATION_EXTERNAL_OUTCOME_ADOPTION_RECEIPT_V1,
  ORCHESTRATION_EXTERNAL_OUTCOME_SCHEMA_VERSION, ORCHESTRATION_PENDING_EFFECT_SCHEMA_VERSION,
  ORCHESTRATION_PENDING_INTENT_COMMIT_RECEIPT_V1,
  type OutcomeAdoptionTransactionResult, type PendingIntentTransactionResult,
} from "./index.js";

const capabilities = {
  supportsClientIdempotency: false, supportsCloseOnlyExit: true,
  supportsNativeBracketProtection: false, supportsProtectionModification: true,
  supportsOrderCancellation: true, supportsPartialFillReporting: true,
};
const entryTransition = { kind: "ENTRY_SUBMISSION_REQUESTED", adapterCapabilities: capabilities } as const;
const base = checkpointEvidence();
function cp(ref: string, transitions: readonly ExecutionAttemptRecoveryTransition[], evidence = base) {
  return createExecutionAuthorityCheckpoint({ schemaVersion: "EXECUTION_AUTHORITY_CHECKPOINT_V1",
    checkpointRef: ref, evidence: { ...evidence, transitions } });
}
function attempt(transitions: readonly ExecutionAttemptRecoveryTransition[]) {
  const result = restoreExecutionAttemptFromEvidence({ ...base, transitions });
  if (result.status !== "EXECUTION_ATTEMPT_RESTORED") throw new Error("Test lifecycle rejected");
  return result.executionAttempt;
}
const p0 = cp("p0", []);
const p1 = cp("p1", [entryTransition]);
const entry = requestEntrySubmission(attempt([]), capabilities);
if (entry.status !== "ENTRY_SUBMISSION_READY") throw new Error("Entry fixture rejected");
const ackTransition = { kind: "ENTRY_SUBMISSION_ACKNOWLEDGED", acknowledgement: {
  executionAttemptId: base.identity.executionAttemptId, idempotencyKey: entry.request.idempotencyKey,
  adapterOrderId: "order-1", acknowledgedAt: 2_100_101,
} } as const;
const p2 = cp("p2", [entryTransition, ackTransition]);
const fillTransition = { kind: "ENTRY_FILL_APPLIED", fill: {
  executionAttemptId: base.identity.executionAttemptId, adapterOrderId: "order-1", fillId: "fill-1",
  filledQuantity: "1", fillPrice: entry.request.limitPrice, filledAt: 2_100_102,
} } as const;
const p3 = cp("p3", [entryTransition, ackTransition, fillTransition]);
const protectionTransition = { kind: "PROTECTION_REQUESTED" } as const;
const p4 = cp("p4", [entryTransition, ackTransition, fillTransition, protectionTransition]);
const cancellationTransition = { kind: "ENTRY_CANCELLATION_REQUESTED" } as const;
const pc = cp("pc", [entryTransition, ackTransition, cancellationTransition]);
function pending(operation: "ENTRY_SUBMISSION" | "PROTECTION_SUBMISSION" | "ENTRY_CANCELLATION",
  idempotencyKey: string, requestFingerprint: string, createdRevision = 2, createdFence = 3) {
  return createOrchestrationPendingEffect({ schemaVersion: ORCHESTRATION_PENDING_EFFECT_SCHEMA_VERSION,
    sessionId: "session-1", adapterId: brokerAdapterId("adapter-1"), environment: "SANDBOX",
    operation, executionAttemptId: base.identity.executionAttemptId, idempotencyKey, requestFingerprint,
    createdRevision, createdFence, state: "PENDING", resolvedOutcomeKey: null,
    resolvedRevision: null, resolvedFence: null });
}
const entryPending = pending("ENTRY_SUBMISSION", entry.request.idempotencyKey,
  fingerprintEntrySubmission(entry.request));
const protection = requestProtection(attempt([entryTransition, ackTransition, fillTransition]));
if (protection.status !== "PROTECTION_REQUEST_READY") throw new Error("Protection fixture rejected");
const protectionPending = pending("PROTECTION_SUBMISSION", protection.request.idempotencyKey,
  fingerprintProtectionRequest(protection.request));
const cancellation = requestEntryCancellation(attempt([entryTransition, ackTransition]));
if (cancellation.status !== "CANCELLATION_REQUEST_READY") throw new Error("Cancellation fixture rejected");
const cancellationPending = pending("ENTRY_CANCELLATION", cancellation.request.idempotencyKey,
  fingerprintEntryCancellation(cancellation.request));
function outcome(key: string, transition: object, linked = true) {
  return createOrchestrationExternalOutcome({ schemaVersion: ORCHESTRATION_EXTERNAL_OUTCOME_SCHEMA_VERSION,
    outcomeKey: key, sessionId: "session-1", executionAttemptId: base.identity.executionAttemptId,
    observedAt: 2_100_103, observedFence: 3,
    pendingEffectIdentity: linked ? { adapterId: entryPending.adapterId, environment: entryPending.environment,
      operation: entryPending.operation, executionAttemptId: entryPending.executionAttemptId,
      idempotencyKey: entryPending.idempotencyKey, requestFingerprint: entryPending.requestFingerprint } : null,
    observation: { kind: "CANONICAL_EXECUTION_TRANSITION", transition } });
}
const ack = outcome("ack-1", ackTransition);
const fill = outcome("fill-1", fillTransition, false);
function recovery(ref: string) {
  return { mode: "SANDBOX", instrumentId: base.identity.instrumentId,
    executionAuthorityCheckpointRef: ref, executionAuthorityIdentity: base.identity,
    riskBasisCheckpointRef: null, latestROutcomeRef: null };
}
function pendingReceiptInput() {
  return { schemaVersion: ORCHESTRATION_PENDING_INTENT_COMMIT_RECEIPT_V1,
    sessionId: "session-1", expectedRevision: 1, committedRevision: 2, committedFence: 3,
    committingOwnerId: "owner-1", previousCheckpointRef: "p0", committedCheckpointRef: "p1",
    resultingRecoveryState: recovery("p1"), pendingEffect: entryPending,
    advanceProof: provePendingIntentCheckpointAdvance({ previousCheckpoint: p0,
      committedCheckpoint: p1, pendingEffect: entryPending }) };
}
function adoptionReceiptInput() {
  return { schemaVersion: ORCHESTRATION_EXTERNAL_OUTCOME_ADOPTION_RECEIPT_V1,
    outcomeKey: "ack-1", sessionId: "session-1", executionAttemptId: base.identity.executionAttemptId,
    expectedRevision: 1, adoptedRevision: 2, adoptedFence: 3, adoptingOwnerId: "owner-1",
    previousCheckpointRef: "p1", committedCheckpointRef: "p2", resultingRecoveryState: recovery("p2"),
    linkedPendingResolution: { pendingEffectIdentity: ack.pendingEffectIdentity, outcomeKey: "ack-1",
      resolvedRevision: 2, resolvedFence: 3 }, nextPendingEffect: null, nextPendingCommit: null,
    advanceProof: proven(ack, p1, p2) };
}
function proven(value: typeof ack, previous = p1, committed = p2) {
  const result = proveOutcomeAdoptionCheckpointAdvance({ previousCheckpoint: previous,
    committedCheckpoint: committed, outcome: value, nextPendingEffect: null });
  if (result.status !== "PROVEN") throw new Error("Adoption fixture rejected");
  return result.proof;
}

describe("B1E immutable checkpoint advance and commit contracts", () => {
  it("advances only execution authority while preserving null latest-R and risk references", () => {
    const current = createOrchestrationRecoveryRecord({
      schemaVersion: "ORCHESTRATION_RECOVERY_RECORD_V1", sessionId: "session-1",
      revision: 1, fenceToken: 3, ...recovery("p1"),
    });
    const target = createOutcomeAdoptionRecoveryState({ currentRecovery: current, committedCheckpoint: p2 });
    expect(target).toEqual({
      mode: current.mode, instrumentId: current.instrumentId,
      executionAuthorityCheckpointRef: p2.checkpointRef,
      executionAuthorityIdentity: p2.evidence.identity,
      riskBasisCheckpointRef: current.riskBasisCheckpointRef,
      latestROutcomeRef: null,
    });
    expect(target.executionAuthorityCheckpointRef).not.toBe(current.executionAuthorityCheckpointRef);
    expect(Object.isFrozen(target)).toBe(true);
    expect(Object.isFrozen(target.executionAuthorityIdentity)).toBe(true);
  });
  it("preserves non-null latest-R and risk basis across acknowledgement, rejection, fill, and next pending", () => {
    const currentData = {
      schemaVersion: "ORCHESTRATION_RECOVERY_RECORD_V1", sessionId: "session-1",
      revision: 1, fenceToken: 3, ...recovery("p1"),
      riskBasisCheckpointRef: "risk-1", latestROutcomeRef: "r-1",
    };
    const current = createOrchestrationRecoveryRecord(currentData);
    const rejectedTransition = { kind: "ENTRY_SUBMISSION_REJECTED", rejection: {
      executionAttemptId: base.identity.executionAttemptId, idempotencyKey: entry.request.idempotencyKey,
      adapterReasonCode: "declined", rejectedAt: 2_100_101 } } as const;
    const checkpoints = [p2, cp("rejected", [entryTransition, rejectedTransition]), p3,
      cp("with-next-pending", [entryTransition, ackTransition, fillTransition, protectionTransition])];
    const originalData = { ...currentData };
    for (const committedCheckpoint of checkpoints) {
      const target = createOutcomeAdoptionRecoveryState({ currentRecovery: current, committedCheckpoint });
      expect(target).toEqual({ mode: current.mode, instrumentId: current.instrumentId,
        executionAuthorityCheckpointRef: committedCheckpoint.checkpointRef,
        executionAuthorityIdentity: committedCheckpoint.evidence.identity,
        riskBasisCheckpointRef: current.riskBasisCheckpointRef,
        latestROutcomeRef: current.latestROutcomeRef });
      expect(Object.isFrozen(target)).toBe(true);
      expect(Object.isFrozen(target.executionAuthorityIdentity)).toBe(true);
    }
    expect(currentData).toEqual(originalData);
    expect(current.executionAuthorityCheckpointRef).toBe(executionAuthorityCheckpointId("p1"));
    expect(current.latestROutcomeRef).toBe("r-1");
    expect(p2.checkpointRef).toBe(executionAuthorityCheckpointId("p2"));
  });
  it("rejects mismatched instruments, invalid current recovery, and reference update options", () => {
    const otherInstrument = createOrchestrationRecoveryRecord({
      schemaVersion: "ORCHESTRATION_RECOVERY_RECORD_V1", sessionId: "session-1",
      revision: 1, fenceToken: 3, mode: "SANDBOX",
      instrumentId: `${base.identity.instrumentId.slice(0, -1)}${base.identity.instrumentId.endsWith("X") ? "Y" : "X"}`,
      executionAuthorityCheckpointRef: null, executionAuthorityIdentity: null,
      riskBasisCheckpointRef: null, latestROutcomeRef: null,
    });
    expect(() => createOutcomeAdoptionRecoveryState({ currentRecovery: otherInstrument,
      committedCheckpoint: p2 })).toThrow(TypeError);
    const current = createOrchestrationRecoveryRecord({
      schemaVersion: "ORCHESTRATION_RECOVERY_RECORD_V1", sessionId: "session-1",
      revision: 1, fenceToken: 3, ...recovery("p1"),
    });
    expect(() => createOutcomeAdoptionRecoveryState({ currentRecovery: {
      ...current, latestROutcomeRef: "r-1" } as never, committedCheckpoint: p2 })).toThrow(TypeError);
    expect(() => createOutcomeAdoptionRecoveryState({ currentRecovery: current,
      committedCheckpoint: p2, nextLatestROutcomeRef: "r-2" } as never)).toThrow(TypeError);
    expect(() => createOutcomeAdoptionRecoveryState({ currentRecovery: current,
      committedCheckpoint: p2, riskBasisUpdate: "risk-2" } as never)).toThrow(TypeError);
  });
  it("represents distinct checkpoint binding and caller prior-authority conflicts for both workflows", () => {
    const checkpointRef = executionAuthorityCheckpointId("committed");
    const previousRef = executionAuthorityCheckpointId("previous");
    const currentRef = executionAuthorityCheckpointId("current");
    const pendingCollision: PendingIntentTransactionResult = { status: "CHECKPOINT_CONFLICT", checkpointRef };
    const adoptionCollision: OutcomeAdoptionTransactionResult = { status: "CHECKPOINT_CONFLICT", checkpointRef };
    const pendingPrior: PendingIntentTransactionResult = { status: "PRIOR_CHECKPOINT_CONFLICT",
      requestedPreviousCheckpointRef: previousRef, currentCheckpointRef: currentRef };
    const adoptionPrior: OutcomeAdoptionTransactionResult = { status: "PRIOR_CHECKPOINT_CONFLICT",
      requestedPreviousCheckpointRef: previousRef, currentCheckpointRef: null };
    expect(pendingCollision).toEqual({ status: "CHECKPOINT_CONFLICT", checkpointRef });
    expect(adoptionCollision).toEqual(pendingCollision);
    expect(pendingPrior).toEqual({ status: "PRIOR_CHECKPOINT_CONFLICT",
      requestedPreviousCheckpointRef: previousRef, currentCheckpointRef: currentRef });
    expect(adoptionPrior.currentCheckpointRef).toBeNull();
  });
  it("proves exact prefix and rejects rewrite, removal, insertion, initialization and identity changes", () => {
    expect(proveExecutionCheckpointAdvance({ previousCheckpoint: p0, committedCheckpoint: p1,
      allowedSuffix: [entryTransition] }).transitionKinds).toEqual(["ENTRY_SUBMISSION_REQUESTED"]);
    const later = cp("later", [entryTransition, ackTransition]);
    const alteredEntry = { ...entryTransition,
      adapterCapabilities: { ...capabilities, supportsNativeBracketProtection: true } } as const;
    expect(() => proveExecutionCheckpointAdvance({ previousCheckpoint: p0,
      committedCheckpoint: cp("altered-capabilities", [alteredEntry]),
      allowedSuffix: [entryTransition] })).toThrow(TypeError);
    for (const changed of [
      cp("rewrite", [alteredEntry, ackTransition]),
      cp("removed", [entryTransition]),
    ]) expect(() => proveExecutionCheckpointAdvance({ previousCheckpoint: p1, committedCheckpoint: changed,
      allowedSuffix: [ackTransition] })).toThrow(TypeError);
    const inserted = cp("inserted", [entryTransition, ackTransition, fillTransition, fillTransition, protectionTransition]);
    expect(() => proveExecutionCheckpointAdvance({ previousCheckpoint: p4,
      committedCheckpoint: inserted, allowedSuffix: [protectionTransition] })).toThrow(TypeError);
    expect(() => proveExecutionCheckpointAdvance({ previousCheckpoint: p1, committedCheckpoint: later,
      allowedSuffix: [fillTransition] })).toThrow(TypeError);
    const changedIdentity = cp("identity", [entryTransition], checkpointEvidence([], "13"));
    expect(() => proveExecutionCheckpointAdvance({ previousCheckpoint: p0,
      committedCheckpoint: changedIdentity, allowedSuffix: [entryTransition] })).toThrow(TypeError);
    const changedInitialization = { ...base, initialization: { ...base.initialization,
      executionPlanRecoveryData: { ...base.initialization.executionPlanRecoveryData,
        config: { ...base.initialization.executionPlanRecoveryData.config, maxQuoteAgeMs: 51 } } } };
    const differentInit = cp("initialization", [entryTransition], changedInitialization);
    expect(() => proveExecutionCheckpointAdvance({ previousCheckpoint: p0,
      committedCheckpoint: differentInit, allowedSuffix: [entryTransition] })).toThrow(TypeError);
  });
  it("binds all three pending operations to the regenerated request and existing fingerprint", () => {
    for (const [previousCheckpoint, committedCheckpoint, pendingEffect] of [
      [p0, p1, entryPending], [p3, p4, protectionPending], [p2, pc, cancellationPending],
    ] as const) expect(provePendingIntentCheckpointAdvance({ previousCheckpoint, committedCheckpoint,
      pendingEffect }).transitionKinds).toHaveLength(1);
    for (const bad of [
      { ...entryPending, operation: "PROTECTION_SUBMISSION" },
      { ...entryPending, idempotencyKey: "wrong" },
      { ...entryPending, requestFingerprint: "wrong" },
    ]) expect(() => provePendingIntentCheckpointAdvance({ previousCheckpoint: p0,
      committedCheckpoint: p1, pendingEffect: bad as typeof entryPending })).toThrow(TypeError);
    const badCapabilities = { ...p1, evidence: { ...p1.evidence, transitions: [{ ...entryTransition,
      adapterCapabilities: { ...capabilities, supportsCloseOnlyExit: false } }] } };
    expect(() => provePendingIntentCheckpointAdvance({ previousCheckpoint: p0,
      committedCheckpoint: badCapabilities, pendingEffect: entryPending })).toThrow(TypeError);
    expect(() => provePendingIntentCheckpointAdvance({ previousCheckpoint: p0,
      committedCheckpoint: p2, pendingEffect: entryPending })).toThrow(TypeError);
  });
  it("replays canonical linked and unlinked outcomes and blocks broker dispositions", () => {
    expect(proven(ack).transitionKinds).toEqual(["ENTRY_SUBMISSION_ACKNOWLEDGED"]);
    expect(proven(fill, p2, p3).transitionKinds).toEqual(["ENTRY_FILL_APPLIED"]);
    const rejectedTransition = { kind: "ENTRY_SUBMISSION_REJECTED", rejection: {
      executionAttemptId: base.identity.executionAttemptId, idempotencyKey: entry.request.idempotencyKey,
      adapterReasonCode: "declined", rejectedAt: 2_100_101 } } as const;
    const rejected = cp("rejected", [entryTransition, rejectedTransition]);
    expect(proven(outcome("reject-1", rejectedTransition), p1, rejected).transitionKinds)
      .toEqual(["ENTRY_SUBMISSION_REJECTED"]);
    const disposition = createOrchestrationExternalOutcome({ ...ack,
      observation: { kind: "BROKER_DISPOSITION", disposition: { status: "STILL_UNKNOWN" } } });
    expect(proveOutcomeAdoptionCheckpointAdvance({ previousCheckpoint: p1,
      committedCheckpoint: p2, outcome: disposition, nextPendingEffect: null }).status).toBe("OUTCOME_NOT_ADOPTABLE");
    expect(() => proveOutcomeAdoptionCheckpointAdvance({ previousCheckpoint: p1,
      committedCheckpoint: p3, outcome: ack, nextPendingEffect: null })).toThrow(TypeError);
    expect(() => proveOutcomeAdoptionCheckpointAdvance({ previousCheckpoint: p2,
      committedCheckpoint: p3, outcome: ack, nextPendingEffect: null })).toThrow(TypeError);
  });
  it("proves outcome then next pending, rejecting wrong operation, key, fingerprint and suffix", () => {
    const final = cp("final", [entryTransition, ackTransition, fillTransition, protectionTransition]);
    expect(proveOutcomeAdoptionCheckpointAdvance({ previousCheckpoint: p2,
      committedCheckpoint: final, outcome: fill, nextPendingEffect: protectionPending }).status).toBe("PROVEN");
    for (const bad of [
      { ...protectionPending, operation: "ENTRY_SUBMISSION" },
      { ...protectionPending, idempotencyKey: "wrong" },
      { ...protectionPending, requestFingerprint: "wrong" },
    ]) expect(() => proveOutcomeAdoptionCheckpointAdvance({ previousCheckpoint: p2,
      committedCheckpoint: final, outcome: fill, nextPendingEffect: bad as typeof protectionPending })).toThrow(TypeError);
    expect(() => proveOutcomeAdoptionCheckpointAdvance({ previousCheckpoint: p2,
      committedCheckpoint: p3, outcome: fill, nextPendingEffect: protectionPending })).toThrow(TypeError);
  });
  it("validates pending receipt provenance, recovery identity and exact logical retry", () => {
    const input = pendingReceiptInput();
    const receipt = createPendingIntentCommitReceipt(input, p0, p1);
    expect(Object.isFrozen(receipt)).toBe(true);
    expect(Object.isFrozen(receipt.resultingRecoveryState.executionAuthorityIdentity)).toBe(true);
    expect(equivalentPendingIntentRetry(receipt, { ...receipt, committingOwnerId: "new-owner" as typeof receipt.committingOwnerId,
      committedFence: 9 as typeof receipt.committedFence })).toBe(true);
    expect(equivalentPendingIntentRetry(receipt, { ...receipt,
      resultingRecoveryState: { ...receipt.resultingRecoveryState, riskBasisCheckpointRef: "other" as never } })).toBe(false);
    expect(equivalentPendingIntentRetry(receipt, { ...receipt,
      pendingEffect: { ...receipt.pendingEffect, createdFence: 9 as never } })).toBe(false);
    for (const bad of [
      { committedRevision: 3 }, { pendingEffect: { ...entryPending, createdRevision: 3 } },
      { pendingEffect: { ...entryPending, createdFence: 4 } },
      { pendingEffect: { ...entryPending, sessionId: "other" } },
      { resultingRecoveryState: recovery("other") },
      { resultingRecoveryState: { ...recovery("p1"), instrumentId: "other" } },
    ]) expect(() => createPendingIntentCommitReceipt({ ...input, ...bad }, p0, p1)).toThrow(TypeError);
    const mutable = { ...input, resultingRecoveryState: { ...input.resultingRecoveryState } };
    const snapshot = createPendingIntentCommitReceipt(mutable, p0, p1);
    mutable.resultingRecoveryState.executionAuthorityIdentity = null as never;
    expect(snapshot.resultingRecoveryState.executionAuthorityIdentity).toEqual(base.identity);
  });
  it("validates linked and unlinked adoption receipts and exact logical retry", () => {
    const input = adoptionReceiptInput();
    const receipt = createExternalOutcomeAdoptionReceipt(input, p1, p2, ack);
    expect(Object.isFrozen(receipt)).toBe(true);
    expect(Object.isFrozen(receipt.linkedPendingResolution)).toBe(true);
    expect(equivalentOutcomeAdoptionRetry(receipt, { ...receipt,
      adoptingOwnerId: "new-owner" as typeof receipt.adoptingOwnerId,
      adoptedFence: 9 as typeof receipt.adoptedFence })).toBe(true);
    expect(equivalentOutcomeAdoptionRetry(receipt, { ...receipt, outcomeKey: "different" as never })).toBe(false);
    for (const bad of [
      { linkedPendingResolution: null },
      { linkedPendingResolution: { ...input.linkedPendingResolution, resolvedRevision: 3 } },
      { linkedPendingResolution: { ...input.linkedPendingResolution, resolvedFence: 4 } },
      { adoptedRevision: 3 },
    ]) expect(() => createExternalOutcomeAdoptionReceipt({ ...input, ...bad }, p1, p2, ack)).toThrow(TypeError);
    const unlinked = { ...input, outcomeKey: "fill-1", previousCheckpointRef: "p2",
      committedCheckpointRef: "p3", linkedPendingResolution: null, resultingRecoveryState: recovery("p3"),
      advanceProof: proven(fill, p2, p3) };
    expect(createExternalOutcomeAdoptionReceipt(unlinked, p2, p3, fill).linkedPendingResolution).toBeNull();
    expect(() => createExternalOutcomeAdoptionReceipt({ ...unlinked,
      linkedPendingResolution: input.linkedPendingResolution }, p2, p3, fill)).toThrow(TypeError);
  });
  it("binds a nested next pending logical payload to the same atomic adoption", () => {
    const final = cp("final", [entryTransition, ackTransition, fillTransition, protectionTransition]);
    const proof = proveOutcomeAdoptionCheckpointAdvance({ previousCheckpoint: p2,
      committedCheckpoint: final, outcome: fill, nextPendingEffect: protectionPending });
    if (proof.status !== "PROVEN") throw new Error("Fixture adoption rejected");
    const nested = { sessionId: "session-1", expectedRevision: 1, previousCheckpointRef: "p2",
      committedCheckpointRef: "final", resultingRecoveryState: recovery("final"),
      pendingEffect: protectionPending, advanceProof: proof.proof };
    const input = { ...adoptionReceiptInput(), outcomeKey: "fill-1", previousCheckpointRef: "p2",
      committedCheckpointRef: "final", resultingRecoveryState: recovery("final"),
      linkedPendingResolution: null, nextPendingEffect: protectionPending,
      nextPendingCommit: nested, advanceProof: proof.proof };
    const receipt = createExternalOutcomeAdoptionReceipt(input, p2, final, fill);
    expect(receipt.nextPendingCommit?.pendingEffect).toEqual(protectionPending);
    expect(Object.isFrozen(receipt.nextPendingCommit?.resultingRecoveryState)).toBe(true);
    expect(equivalentOutcomeAdoptionRetry(receipt, { ...receipt,
      nextPendingEffect: { ...protectionPending, createdFence: 4 as never } })).toBe(false);
    for (const bad of [
      { nextPendingCommit: null },
      { nextPendingEffect: { ...protectionPending, createdRevision: 3 } },
      { nextPendingEffect: { ...protectionPending, createdFence: 4 } },
      { nextPendingCommit: { ...nested, expectedRevision: 2 } },
      { nextPendingCommit: { ...nested, previousCheckpointRef: "other" } },
    ]) expect(() => createExternalOutcomeAdoptionReceipt({ ...input, ...bad }, p2, final, fill)).toThrow(TypeError);
  });
  it("rejects malformed receipt graphs and revision overflow", () => {
    const input = pendingReceiptInput();
    expect(() => createPendingIntentCommitReceipt({ ...input, extra: 1 }, p0, p1)).toThrow(TypeError);
    expect(() => createPendingIntentCommitReceipt({ ...input,
      expectedRevision: Number.MAX_SAFE_INTEGER, committedRevision: Number.MAX_SAFE_INTEGER }, p0, p1)).toThrow(TypeError);
    const accessor = { ...input, resultingRecoveryState: { ...input.resultingRecoveryState } };
    Object.defineProperty(accessor.resultingRecoveryState, "mode", { enumerable: true, get: () => "SANDBOX" });
    expect(() => createPendingIntentCommitReceipt(accessor, p0, p1)).toThrow(TypeError);
    const cycle: Record<string, unknown> = { ...input };
    cycle["resultingRecoveryState"] = cycle;
    expect(() => createPendingIntentCommitReceipt(cycle, p0, p1)).toThrow(TypeError);
    expect(() => createPendingIntentCommitReceipt({ ...input, [Symbol("extra")]: true }, p0, p1)).toThrow(TypeError);
    expect(() => createPendingIntentCommitReceipt({ ...input, pendingEffect: { ...entryPending,
      requestFingerprint: undefined } }, p0, p1)).toThrow(TypeError);
  });
});
