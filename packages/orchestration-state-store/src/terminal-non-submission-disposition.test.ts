import { describe, expect, it } from "vitest";
import { createTerminalNonSubmissionDispositionReceiptV1,
  createTerminalNonSubmissionDispositionV1, createTerminalNonSubmissionProofV1,
  equivalentTerminalNonSubmissionDispositionRetry } from "./terminal-non-submission-disposition.js";

const pendingEffectIdentity = { adapterId: "adapter-1", environment: "SANDBOX",
  operation: "ENTRY_SUBMISSION", executionAttemptId: "attempt-1", idempotencyKey: "key-1",
  requestFingerprint: "fingerprint-1" };
function proof(overrides: Record<string, unknown> = {}) {
  return { schemaVersion: "TERMINAL_NON_SUBMISSION_PROOF_V1",
    sourceKind: "TRUSTED_ADAPTER_FAILURE", sourceEventRef: "event-1", observedAt: 1234,
    category: "INVALID_REQUEST", certainty: "DEFINITE_FAILURE",
    submissionExposure: "NOT_SUBMITTED", retryDisposition: "DO_NOT_RETRY",
    pendingEffectIdentity, ...overrides };
}
function disposition(overrides: Record<string, unknown> = {}) {
  return { schemaVersion: "TERMINAL_NON_SUBMISSION_DISPOSITION_V1", dispositionRef: "terminal-1",
    sessionId: "session-1", executionAttemptId: "attempt-1", pendingEffectIdentity,
    pendingCreatedRevision: 2, pendingCreatedFence: 5,
    pendingCreationRef: { kind: "PENDING_INTENT_COMMIT", committedCheckpointRef: "checkpoint-2",
      committedRevision: 2 },
    expectedRecoveryRevision: 3, committedRevision: 4, committedFence: 7, committingOwnerId: "owner-1",
    executionAuthorityCheckpointRefBefore: "checkpoint-3",
    executionAuthorityCheckpointRefAfter: "checkpoint-3",
    executionAuthorityIdentity: { executionAttemptId: "attempt-1", executionPlanId: "plan-1",
      tradeIntentId: "intent-1", candidateId: "candidate-1", instrumentId: "ulte:v1:venue:EQUITY:ABC" },
    mode: "SANDBOX", instrumentId: "ulte:v1:venue:EQUITY:ABC", riskBasisCheckpointRef: "risk-1",
    latestROutcomeRef: "r-1", proof: proof(), sessionDisposition: "TERMINAL_NON_SUBMISSION",
    resolution: { kind: "TERMINAL_NON_SUBMISSION", resolvedRevision: 4, resolvedFence: 7 },
    ...overrides };
}

describe("terminal non-submission contracts", () => {
  it.each(["TRUSTED_ADAPTER_FAILURE", "REVIEWED_LEGACY_ATTESTATION"])(
    "accepts %s with caller-supplied provenance", (sourceKind) => {
      const result = createTerminalNonSubmissionProofV1(proof({ sourceKind }));
      expect(result).toMatchObject({ sourceKind, sourceEventRef: "event-1", observedAt: 1234,
        retryDisposition: "DO_NOT_RETRY" });
      expect(result).not.toHaveProperty("adapterReasonCode");
      expect(Object.isFrozen(result)).toBe(true);
      expect(Object.isFrozen(result.pendingEffectIdentity)).toBe(true);
    });
  it.each([
    [{ certainty: "OUTCOME_UNKNOWN" }, "unknown outcome"],
    [{ submissionExposure: "MAY_HAVE_BEEN_SUBMITTED" }, "possible submission"],
    [{ retryDisposition: "RETRY_SAFE" }, "retry-safe disposition"],
    [{ retryDisposition: "RETRY_AUTHORIZED" }, "retry authority"],
    [{ category: "NETWORK" }, "retry-safe category"],
    [{ sourceEventRef: " " }, "blank source ref"],
    [{ sourceEventRef: undefined }, "missing source ref"],
    [{ sourceEventRef: " event-1" }, "noncanonical source ref"],
    [{ observedAt: -1 }, "invalid time"],
    [{ observedAt: 1.5 }, "fractional time"],
    [{ observedAt: Number.NaN }, "non-finite time"],
    [{ sourceKind: "UNKNOWN" }, "unsupported source"],
    [{ pendingEffectIdentity: { ...pendingEffectIdentity, idempotencyKey: " " } }, "invalid pending identity"],
    [{ sanitizedMessage: "text" }, "unapproved authority field"],
    [{ adapterOrderId: "order-1" }, "invented broker evidence"],
  ])("rejects %s (%s)", (overrides) => {
    expect(() => createTerminalNonSubmissionProofV1(proof(overrides as Record<string, unknown>))).toThrow();
  });
  it("accepts only supplied canonical reason code", () => {
    expect(createTerminalNonSubmissionProofV1(proof({ adapterReasonCode: "VENUE_CODE" })).adapterReasonCode)
      .toBe("VENUE_CODE");
    expect(() => createTerminalNonSubmissionProofV1(proof({ adapterReasonCode: " " }))).toThrow();
    expect(() => createTerminalNonSubmissionProofV1(proof({ adapterReasonCode: undefined }))).toThrow();
  });
  it("requires exact pending identity, r to r+1, and unchanged checkpoint", () => {
    const value = createTerminalNonSubmissionDispositionV1(disposition());
    expect(value.committedRevision).toBe(value.expectedRecoveryRevision + 1);
    expect(value.executionAuthorityCheckpointRefAfter).toBe(value.executionAuthorityCheckpointRefBefore);
    expect(value.sessionDisposition).toBe("TERMINAL_NON_SUBMISSION");
    expect(() => createTerminalNonSubmissionDispositionV1(disposition({ committedRevision: 5 }))).toThrow();
    expect(() => createTerminalNonSubmissionDispositionV1(disposition({
      executionAuthorityCheckpointRefAfter: "checkpoint-4" }))).toThrow();
    expect(() => createTerminalNonSubmissionDispositionV1(disposition({
      proof: proof({ pendingEffectIdentity: { ...pendingEffectIdentity, requestFingerprint: "different" } }) }))).toThrow();
    expect(() => createTerminalNonSubmissionDispositionV1(disposition({ sessionDisposition: "READY" }))).toThrow();
    expect(() => createTerminalNonSubmissionDispositionV1(disposition({
      resolution: { kind: "RETRY", resolvedRevision: 4, resolvedFence: 7 } }))).toThrow();
    expect(() => createTerminalNonSubmissionDispositionV1(disposition({
      expectedRecoveryRevision: Number.MAX_SAFE_INTEGER, committedRevision: Number.MAX_SAFE_INTEGER }))).toThrow();
  });
  it("freezes the complete receipt and compares every logical field", () => {
    const canonical = createTerminalNonSubmissionDispositionV1(disposition());
    const receipt = createTerminalNonSubmissionDispositionReceiptV1({
      schemaVersion: "TERMINAL_NON_SUBMISSION_DISPOSITION_RECEIPT_V1", disposition: canonical });
    expect(equivalentTerminalNonSubmissionDispositionRetry(receipt,
      createTerminalNonSubmissionDispositionV1(disposition()))).toBe(true);
    for (const change of [
      { proof: proof({ sourceEventRef: "event-2" }) },
      { pendingEffectIdentity: { ...pendingEffectIdentity, requestFingerprint: "other" },
        proof: proof({ pendingEffectIdentity: { ...pendingEffectIdentity, requestFingerprint: "other" } }) },
      { expectedRecoveryRevision: 4, committedRevision: 5,
        resolution: { kind: "TERMINAL_NON_SUBMISSION", resolvedRevision: 5, resolvedFence: 7 } },
      { dispositionRef: "terminal-2" },
    ]) {
      expect(equivalentTerminalNonSubmissionDispositionRetry(receipt,
        createTerminalNonSubmissionDispositionV1(disposition(change)))).toBe(false);
    }
    expect(Object.isFrozen(receipt)).toBe(true);
    expect(Object.isFrozen(receipt.disposition)).toBe(true);
    expect(Object.isFrozen(receipt.disposition.proof)).toBe(true);
    expect(Object.isFrozen(receipt.disposition.resolution)).toBe(true);
    expect(Object.isFrozen(receipt.disposition.pendingCreationRef)).toBe(true);
    expect(Object.isFrozen(receipt.disposition.executionAuthorityIdentity)).toBe(true);
    expect(Object.isFrozen(receipt.disposition.pendingEffectIdentity)).toBe(true);
  });
  it("preserves historical owner/fence without requiring them as current retry authorization", () => {
    const canonical = createTerminalNonSubmissionDispositionV1(disposition());
    const changedHistorical = createTerminalNonSubmissionDispositionV1(disposition({
      committingOwnerId: "old-owner", committedFence: 8,
      resolution: { kind: "TERMINAL_NON_SUBMISSION", resolvedRevision: 4, resolvedFence: 8 } }));
    const receipt = createTerminalNonSubmissionDispositionReceiptV1({
      schemaVersion: "TERMINAL_NON_SUBMISSION_DISPOSITION_RECEIPT_V1", disposition: changedHistorical });
    expect(equivalentTerminalNonSubmissionDispositionRetry(receipt, canonical)).toBe(true);
    expect(receipt.disposition.committingOwnerId).toBe("old-owner");
    expect(receipt.disposition.committedFence).toBe(8);
    expect(receipt.disposition.resolution.resolvedFence).toBe(8);
  });
  it("rejects accessor evidence without invoking it, and copies caller-owned input", () => {
    let accessed = false;
    const identity = { ...pendingEffectIdentity };
    Object.defineProperty(identity, "requestFingerprint", { enumerable: true,
      get: () => { accessed = true; return "fingerprint-1"; } });
    expect(() => createTerminalNonSubmissionProofV1(proof({ pendingEffectIdentity: identity }))).toThrow();
    expect(accessed).toBe(false);
    const supplied = disposition();
    const result = createTerminalNonSubmissionDispositionV1(supplied);
    supplied.executionAuthorityIdentity.candidateId = "changed";
    expect(result.executionAuthorityIdentity.candidateId).toBe("candidate-1");
    expect(result.proof.observedAt).toBe(1234);
    expect(result.dispositionRef).toBe("terminal-1");
    expect(createTerminalNonSubmissionDispositionV1(disposition())).toEqual(result);
  });
});
