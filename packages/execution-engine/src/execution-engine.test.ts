import { describe, expect, it } from "vitest";
import {
  createInstrumentId,
  positiveDecimalString,
  unixMs,
} from "@ulte/instrument-model";
import type {
  ExecutionPreparationResult,
  ReadyExecutionPlan,
} from "@ulte/execution-preparation-engine";
import {
  acknowledgeCancellation,
  acknowledgeEntrySubmission,
  acknowledgeProtection,
  applyEntryFill,
  createAdapterCapabilities,
  createExecutionAttempt,
  createFillEvent,
  rejectEntrySubmission,
  rejectProtection,
  requestEntryCancellation,
  requestEntrySubmission,
  requestProtection,
  selectProtectionMode,
  type AdapterCapabilities,
  type ExecutionAttempt,
} from "./index.js";

const instrument = createInstrumentId({ venue: "TEST", venueSymbol: "ABC", instrumentKind: "CFD" });

function plan(overrides: Partial<ReadyExecutionPlan> = {}): ReadyExecutionPlan {
  const quantity = overrides.quantity ?? positiveDecimalString("1.0");
  const entrySide = overrides.entrySide ?? "BUY";
  const exitSide = overrides.exitSide ?? "SELL";
  return Object.freeze({
    status: "EXECUTION_PLAN_READY",
    schemaVersion: "EXECUTION_PLAN_V1",
    executionPlanId: "plan-1",
    tradeIntentId: "intent-1",
    candidateId: "candidate-1",
    instrumentId: instrument,
    intentAsOf: unixMs(800),
    marketSnapshotAsOf: unixMs(850),
    preparedAsOf: unixMs(900),
    direction: "UP",
    entrySide,
    exitSide,
    quantity,
    quantityUnit: "contracts",
    entryInstruction: Object.freeze({
      kind: "ENTRY_LIMIT",
      side: entrySide,
      price: positiveDecimalString("100"),
      quantity,
      positionEffect: "OPEN",
    }),
    protectiveStopInstruction: Object.freeze({
      kind: "PROTECTIVE_STOP_TRIGGER",
      side: exitSide,
      triggerPrice: positiveDecimalString("90"),
      quantity,
      positionEffect: "CLOSE",
    }),
    profitTargetInstruction: Object.freeze({
      kind: "PROFIT_TARGET_LIMIT",
      side: exitSide,
      price: positiveDecimalString("130"),
      quantity,
      positionEffect: "CLOSE",
    }),
    priceTick: positiveDecimalString("0.01"),
    quantityStep: positiveDecimalString("0.01"),
    bidAtPreparation: positiveDecimalString("99.99"),
    askAtPreparation: positiveDecimalString("100"),
    intentAgeMs: 100,
    quoteAgeMs: 50,
    entryDeviationBps: "0",
    approvedRiskAmount: positiveDecimalString("25"),
    actualRiskAmount: positiveDecimalString("20"),
    netRewardRiskBps: "30000",
    ...overrides,
  });
}

const managed = createAdapterCapabilities({
  supportsClientIdempotency: false,
  supportsCloseOnlyExit: true,
  supportsNativeBracketProtection: false,
  supportsProtectionModification: true,
  supportsOrderCancellation: true,
  supportsPartialFillReporting: true,
});

const native = createAdapterCapabilities({
  ...managed,
  supportsCloseOnlyExit: false,
  supportsNativeBracketProtection: true,
  supportsPartialFillReporting: false,
});

function fresh(overrides: Partial<ReadyExecutionPlan> = {}): ExecutionAttempt {
  const result = createExecutionAttempt(plan(overrides));
  expect(result.status).toBe("EXECUTION_ATTEMPT_READY");
  return result as ExecutionAttempt;
}

function pending(capabilities: AdapterCapabilities = managed): {
  readonly attempt: ExecutionAttempt;
  readonly key: string;
} {
  const result = requestEntrySubmission(fresh(), capabilities);
  expect(result.status).toBe("ENTRY_SUBMISSION_READY");
  if (result.status !== "ENTRY_SUBMISSION_READY") throw new Error("entry request failed");
  return { attempt: result.attempt, key: result.request.idempotencyKey };
}

function working(capabilities: AdapterCapabilities = managed): ExecutionAttempt {
  const submitted = pending(capabilities);
  const result = acknowledgeEntrySubmission(submitted.attempt, {
    executionAttemptId: submitted.attempt.executionAttemptId,
    idempotencyKey: submitted.key,
    adapterOrderId: "ORDER-1",
    acknowledgedAt: 1_000,
  });
  expect(result.status).toBe("EXECUTION_ATTEMPT_UPDATED");
  return result.attempt;
}

function fill(attempt: ExecutionAttempt, fillId: string, quantity: string, at: number): ExecutionAttempt {
  const result = applyEntryFill(attempt, {
    executionAttemptId: attempt.executionAttemptId,
    adapterOrderId: "ORDER-1",
    fillId,
    filledQuantity: quantity,
    fillPrice: "100.25",
    filledAt: at,
  });
  expect(result.status).toBe("EXECUTION_ATTEMPT_UPDATED");
  return result.attempt;
}

describe("execution attempt creation and identity", () => {
  it("creates only from a ready plan with the required zeroed initial state", () => {
    const result = fresh();
    expect(result).toMatchObject({
      status: "EXECUTION_ATTEMPT_READY",
      state: "READY_FOR_ENTRY_SUBMISSION",
      filledEntryQuantity: "0",
      protectedQuantity: "0",
      unprotectedFilledQuantity: "0",
      entryPrice: "100",
      stopTriggerPrice: "90",
      targetPrice: "130",
    });
  });

  it("blocks every non-ready preparation result", () => {
    const upstream: ExecutionPreparationResult = {
      status: "PLAN_NOT_PREPARABLE",
      reason: "MARKET_SNAPSHOT_STALE",
      tradeIntentId: "intent-1",
      candidateId: "candidate-1",
    };
    expect(createExecutionAttempt(upstream)).toEqual({
      status: "UPSTREAM_NOT_READY",
      executionPlanStatus: "PLAN_NOT_PREPARABLE",
      candidateId: "candidate-1",
    });
  });

  it("is deterministic and includes material plan fields beyond candidate identity", () => {
    const first = fresh();
    expect(fresh().executionAttemptId).toBe(first.executionAttemptId);
    const changedPrice = positiveDecimalString("101");
    const changed = fresh({
      entryInstruction: Object.freeze({
        kind: "ENTRY_LIMIT",
        side: "BUY",
        price: changedPrice,
        quantity: positiveDecimalString("1.0"),
        positionEffect: "OPEN",
      }),
    });
    expect(changed.executionAttemptId).not.toBe(first.executionAttemptId);
  });

  it("rejects a malformed ready plan rather than reconstructing it", () => {
    const malformed = { ...plan(), entryInstruction: { ...plan().entryInstruction, quantity: "2" } } as ReadyExecutionPlan;
    expect(createExecutionAttempt(malformed)).toMatchObject({ status: "DATA_REJECTED", reason: "INVALID_EXECUTION_PLAN" });
  });
});

describe("adapter selection and entry lifecycle", () => {
  it("prefers native brackets, selects managed only with both safeguards, and rejects unsafe adapters", () => {
    expect(selectProtectionMode({ ...managed, supportsNativeBracketProtection: true })).toMatchObject({
      protectionMode: "NATIVE_BRACKET",
    });
    expect(selectProtectionMode(managed)).toMatchObject({ protectionMode: "MANAGED_PROTECTION" });
    expect(selectProtectionMode({
      ...managed,
      supportsCloseOnlyExit: false,
      supportsNativeBracketProtection: false,
    })).toEqual({ status: "EXECUTION_NOT_SUPPORTED", reason: "ADAPTER_NOT_SAFE_FOR_PROTECTION" });
  });

  it("creates one stable entry identity across original and pending retries", () => {
    const original = fresh();
    const first = requestEntrySubmission(original, managed);
    const parallelRetry = requestEntrySubmission(original, managed);
    expect(first.status).toBe("ENTRY_SUBMISSION_READY");
    expect(parallelRetry.status).toBe("ENTRY_SUBMISSION_READY");
    if (first.status !== "ENTRY_SUBMISSION_READY" || parallelRetry.status !== "ENTRY_SUBMISSION_READY") return;
    const pendingRetry = requestEntrySubmission(first.attempt, managed);
    expect(pendingRetry.status).toBe("ENTRY_SUBMISSION_READY");
    if (pendingRetry.status !== "ENTRY_SUBMISSION_READY") return;
    expect(parallelRetry.request.idempotencyKey).toBe(first.request.idempotencyKey);
    expect(pendingRetry.request).toEqual(first.request);
    expect(requestEntrySubmission(working(), managed)).toMatchObject({
      status: "TRANSITION_REJECTED", reason: "INVALID_TRANSITION",
    });
  });

  it("acknowledges pending to working and rejects wrong identities", () => {
    const submitted = pending();
    const base = {
      executionAttemptId: submitted.attempt.executionAttemptId,
      idempotencyKey: submitted.key,
      adapterOrderId: "ORDER-1",
      acknowledgedAt: 1_000,
    };
    expect(acknowledgeEntrySubmission(submitted.attempt, { ...base, executionAttemptId: "other" })).toMatchObject({
      reason: "EVENT_ATTEMPT_MISMATCH",
    });
    expect(acknowledgeEntrySubmission(submitted.attempt, { ...base, idempotencyKey: "other" })).toMatchObject({
      reason: "IDEMPOTENCY_KEY_MISMATCH",
    });
    expect(acknowledgeEntrySubmission(submitted.attempt, base).attempt.state).toBe("ENTRY_WORKING");
    expect(acknowledgeEntrySubmission(fresh(), base)).toMatchObject({ reason: "INVALID_TRANSITION" });
  });

  it("preserves opaque broker rejection reasons", () => {
    const submitted = pending();
    const result = rejectEntrySubmission(submitted.attempt, {
      executionAttemptId: submitted.attempt.executionAttemptId,
      idempotencyKey: submitted.key,
      adapterReasonCode: "VENUE-X-42",
      rejectedAt: 1_000,
    });
    expect(result.attempt).toMatchObject({ state: "REJECTED", entryRejectionReason: "VENUE-X-42" });
  });
});

describe("exact fills, deduplication, and event ordering", () => {
  it("accumulates 0.1 + 0.2 exactly, then reaches full fill", () => {
    const partial = fill(fill(working(), "F1", "0.1", 1_001), "F2", "0.2", 1_002);
    expect(partial).toMatchObject({ state: "ENTRY_PARTIALLY_FILLED", filledEntryQuantity: "0.3" });
    const full = fill(partial, "F3", "0.7", 1_003);
    expect(full).toMatchObject({ state: "ENTRY_FILLED", filledEntryQuantity: "1" });
  });

  it("ignores an identical duplicate fill and rejects a conflicting reuse", () => {
    const base = working();
    const event = {
      executionAttemptId: base.executionAttemptId,
      adapterOrderId: "ORDER-1",
      fillId: "F1",
      filledQuantity: "0.4",
      fillPrice: "100",
      filledAt: 1_001,
    };
    const first = applyEntryFill(base, event);
    const duplicate = applyEntryFill(first.attempt, event);
    expect(duplicate).toMatchObject({ status: "DUPLICATE_EVENT_IGNORED" });
    expect(duplicate.attempt.filledEntryQuantity).toBe("0.4");
    expect(applyEntryFill(first.attempt, { ...event, filledQuantity: "0.5" })).toMatchObject({
      status: "DATA_REJECTED", reason: "DUPLICATE_FILL_CONFLICT",
    });
  });

  it("rejects overfills, wrong orders, pre-ack fills, and cross-attempt events", () => {
    const base = working();
    const event = {
      executionAttemptId: base.executionAttemptId,
      adapterOrderId: "ORDER-1",
      fillId: "F1",
      filledQuantity: "1.1",
      fillPrice: "100",
      filledAt: 1_001,
    };
    expect(applyEntryFill(base, event)).toMatchObject({ status: "DATA_REJECTED", reason: "OVERFILL_DETECTED" });
    expect(applyEntryFill(base, { ...event, filledQuantity: "0.1", adapterOrderId: "wrong" })).toMatchObject({
      reason: "ADAPTER_ORDER_ID_MISMATCH",
    });
    expect(applyEntryFill(fresh(), { ...event, filledQuantity: "0.1" })).toMatchObject({ reason: "INVALID_TRANSITION" });
    expect(applyEntryFill(base, { ...event, filledQuantity: "0.1", executionAttemptId: "other" })).toMatchObject({
      reason: "EVENT_ATTEMPT_MISMATCH",
    });
  });

  it("allows equal timestamps but rejects backward execution time", () => {
    const first = fill(working(), "F1", "0.1", 1_000);
    expect(applyEntryFill(first, {
      executionAttemptId: first.executionAttemptId,
      adapterOrderId: "ORDER-1",
      fillId: "F2",
      filledQuantity: "0.1",
      fillPrice: "100",
      filledAt: 1_000,
    }).status).toBe("EXECUTION_ATTEMPT_UPDATED");
    expect(applyEntryFill(first, {
      executionAttemptId: first.executionAttemptId,
      adapterOrderId: "ORDER-1",
      fillId: "F3",
      filledQuantity: "0.1",
      fillPrice: "100",
      filledAt: 999,
    })).toMatchObject({ reason: "OUT_OF_ORDER_EXECUTION_EVENT" });
  });
});

describe("protection coverage", () => {
  it("cannot protect before a fill and protects all uncovered partial exposure", () => {
    expect(requestProtection(working())).toMatchObject({ reason: "NO_UNPROTECTED_FILLED_QUANTITY" });
    const partial = fill(working(), "F1", "0.4", 1_001);
    const requested = requestProtection(partial);
    expect(requested.status).toBe("PROTECTION_REQUEST_READY");
    if (requested.status !== "PROTECTION_REQUEST_READY") return;
    expect(requested.request).toMatchObject({
      protectedQuantity: "0.4",
      targetCumulativeProtectedQuantity: "0.4",
    });
    expect(requestProtection(requested.attempt).status).toBe("PROTECTION_REQUEST_READY");
  });

  it("uses cumulative identity while requesting only newly uncovered quantity", () => {
    const partial = fill(working(), "F1", "0.4", 1_001);
    const first = requestProtection(partial);
    if (first.status !== "PROTECTION_REQUEST_READY") throw new Error("protection request failed");
    const accepted = acknowledgeProtection(first.attempt, {
      executionAttemptId: first.attempt.executionAttemptId,
      protectionRequestId: first.request.protectionRequestId,
      idempotencyKey: first.request.idempotencyKey,
      protectedQuantity: "0.40",
      acknowledgedAt: 1_002,
    });
    expect(accepted.attempt).toMatchObject({ state: "ENTRY_PARTIALLY_FILLED", protectedQuantity: "0.40" });
    const more = fill(accepted.attempt, "F2", "0.3", 1_003);
    const second = requestProtection(more);
    if (second.status !== "PROTECTION_REQUEST_READY") throw new Error("second protection request failed");
    expect(second.request).toMatchObject({
      protectedQuantity: "0.3",
      targetCumulativeProtectedQuantity: "0.7",
    });
    expect(second.request.idempotencyKey).not.toBe(first.request.idempotencyKey);
  });

  it("validates protection request identity and never accepts excess coverage", () => {
    const requested = requestProtection(fill(working(), "F1", "0.4", 1_001));
    if (requested.status !== "PROTECTION_REQUEST_READY") throw new Error("protection request failed");
    const event = {
      executionAttemptId: requested.attempt.executionAttemptId,
      protectionRequestId: requested.request.protectionRequestId,
      idempotencyKey: requested.request.idempotencyKey,
      protectedQuantity: "0.4",
      acknowledgedAt: 1_002,
    };
    expect(acknowledgeProtection(requested.attempt, { ...event, protectionRequestId: "wrong" })).toMatchObject({
      reason: "PROTECTION_REQUEST_MISMATCH",
    });
    expect(acknowledgeProtection(requested.attempt, { ...event, protectedQuantity: "0.5" })).toMatchObject({
      reason: "PROTECTION_REQUEST_MISMATCH",
    });
  });

  it("marks full coverage as protected only after explicit acknowledgement", () => {
    const requested = requestProtection(fill(working(native), "F1", "1", 1_001));
    if (requested.status !== "PROTECTION_REQUEST_READY") throw new Error("protection request failed");
    expect(requested.attempt).toMatchObject({ state: "PROTECTION_PENDING", protectedQuantity: "0" });
    const accepted = acknowledgeProtection(requested.attempt, {
      executionAttemptId: requested.attempt.executionAttemptId,
      protectionRequestId: requested.request.protectionRequestId,
      idempotencyKey: requested.request.idempotencyKey,
      protectedQuantity: "1.0",
      acknowledgedAt: 1_002,
    });
    expect(accepted.attempt).toMatchObject({ state: "PROTECTED", protectedQuantity: "1.0", unprotectedFilledQuantity: "0" });
  });

  it("makes protection rejection safety-critical and leaves exposure visible", () => {
    const requested = requestProtection(fill(working(), "F1", "0.4", 1_001));
    if (requested.status !== "PROTECTION_REQUEST_READY") throw new Error("protection request failed");
    const failed = rejectProtection(requested.attempt, {
      executionAttemptId: requested.attempt.executionAttemptId,
      protectionRequestId: requested.request.protectionRequestId,
      idempotencyKey: requested.request.idempotencyKey,
      adapterReasonCode: "PROTECTION-DENIED",
      rejectedAt: 1_002,
    });
    expect(failed.attempt).toMatchObject({
      state: "FAILED",
      protectionFailureReason: "PROTECTION-DENIED",
      protectedQuantity: "0",
      unprotectedFilledQuantity: "0.4",
    });
  });
});

describe("cancellation and partial-cancel safety", () => {
  it("uses one deterministic cancellation identity across retries", () => {
    const first = requestEntryCancellation(working());
    expect(first.status).toBe("CANCELLATION_REQUEST_READY");
    if (first.status !== "CANCELLATION_REQUEST_READY") return;
    const retry = requestEntryCancellation(first.attempt);
    expect(retry.status).toBe("CANCELLATION_REQUEST_READY");
    if (retry.status !== "CANCELLATION_REQUEST_READY") return;
    expect(retry.request).toEqual(first.request);
  });

  it("acknowledges zero-fill cancellation as CANCELED", () => {
    const requested = requestEntryCancellation(working());
    if (requested.status !== "CANCELLATION_REQUEST_READY") throw new Error("cancel request failed");
    const accepted = acknowledgeCancellation(requested.attempt, {
      executionAttemptId: requested.attempt.executionAttemptId,
      cancellationRequestId: requested.request.cancellationRequestId,
      idempotencyKey: requested.request.idempotencyKey,
      adapterOrderId: "ORDER-1",
      acknowledgedAt: 1_001,
    });
    expect(accepted.attempt.state).toBe("CANCELED");
  });

  it("retains partial filled and unprotected exposure after cancel", () => {
    const partial = fill(working(), "F1", "0.4", 1_001);
    const requested = requestEntryCancellation(partial);
    if (requested.status !== "CANCELLATION_REQUEST_READY") throw new Error("cancel request failed");
    const accepted = acknowledgeCancellation(requested.attempt, {
      executionAttemptId: requested.attempt.executionAttemptId,
      cancellationRequestId: requested.request.cancellationRequestId,
      idempotencyKey: requested.request.idempotencyKey,
      adapterOrderId: "ORDER-1",
      acknowledgedAt: 1_002,
    });
    expect(accepted.attempt).toMatchObject({
      state: "ENTRY_CANCELED_WITH_EXPOSURE",
      filledEntryQuantity: "0.4",
      unprotectedFilledQuantity: "0.4",
    });
    expect(requestProtection(accepted.attempt).status).toBe("PROTECTION_REQUEST_READY");
  });

  it("cannot cancel a fully filled entry or use a mismatched cancellation acknowledgement", () => {
    expect(requestEntryCancellation(fill(working(), "F1", "1", 1_001))).toMatchObject({ reason: "INVALID_TRANSITION" });
    const requested = requestEntryCancellation(working());
    if (requested.status !== "CANCELLATION_REQUEST_READY") throw new Error("cancel request failed");
    expect(acknowledgeCancellation(requested.attempt, {
      executionAttemptId: requested.attempt.executionAttemptId,
      cancellationRequestId: "wrong",
      idempotencyKey: requested.request.idempotencyKey,
      adapterOrderId: "ORDER-1",
      acknowledgedAt: 1_001,
    })).toMatchObject({ reason: "CANCELLATION_REQUEST_MISMATCH" });
  });

  it("never relabels a fill completed during cancel-pending as canceled", () => {
    const requested = requestEntryCancellation(working());
    if (requested.status !== "CANCELLATION_REQUEST_READY") throw new Error("cancel request failed");
    const filled = fill(requested.attempt, "F1", "1", 1_001);
    const accepted = acknowledgeCancellation(filled, {
      executionAttemptId: filled.executionAttemptId,
      cancellationRequestId: requested.request.cancellationRequestId,
      idempotencyKey: requested.request.idempotencyKey,
      adapterOrderId: "ORDER-1",
      acknowledgedAt: 1_002,
    });
    expect(accepted.attempt).toMatchObject({ state: "ENTRY_FILLED", filledEntryQuantity: "1" });
  });
});

describe("purity and immutability", () => {
  it("does not mutate caller inputs and freezes attempts, arrays, capabilities, requests, and events", () => {
    const source = plan();
    const before = JSON.stringify(source);
    const attempt = fresh();
    const submission = requestEntrySubmission(attempt, managed);
    const event = createFillEvent({
      executionAttemptId: attempt.executionAttemptId,
      adapterOrderId: "ORDER-1",
      fillId: "F1",
      filledQuantity: "0.1",
      fillPrice: "100",
      filledAt: 1_001,
    });
    expect(JSON.stringify(source)).toBe(before);
    expect(Object.isFrozen(attempt)).toBe(true);
    expect(Object.isFrozen(attempt.processedFills)).toBe(true);
    expect(Object.isFrozen(managed)).toBe(true);
    expect(Object.isFrozen(event)).toBe(true);
    expect(submission.status === "ENTRY_SUBMISSION_READY" && Object.isFrozen(submission.request)).toBe(true);
  });

  it("returns deeply equivalent results for repeated pure transitions", () => {
    const attempt = fresh();
    expect(requestEntrySubmission(attempt, managed)).toEqual(requestEntrySubmission(attempt, managed));
  });
});
