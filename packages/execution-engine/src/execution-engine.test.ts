import { describe, expect, it } from "vitest";
import {
  currencyCode,
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
  applyExitFill,
  applyEntryFill,
  createAdapterCapabilities,
  createExecutionAttempt,
  createExitFillEvent,
  createFillEvent,
  rejectCancellation,
  rejectEntrySubmission,
  rejectProtection,
  requestEntryCancellation,
  requestEntrySubmission,
  requestProtection,
  selectProtectionMode,
  type AdapterCapabilities,
  type ExecutionAttempt,
  type ProtectionRequest,
} from "./index.js";

const instrument = createInstrumentId({ venue: "TEST", venueSymbol: "ABC", instrumentKind: "CFD" });

function plan(overrides: Partial<ReadyExecutionPlan> = {}): ReadyExecutionPlan {
  const quantity = overrides.quantity ?? positiveDecimalString("1.0");
  const entrySide = overrides.entrySide ?? "BUY";
  const exitSide = overrides.exitSide ?? "SELL";
  return Object.freeze({
    status: "EXECUTION_PLAN_READY",
    schemaVersion: "EXECUTION_PLAN_V2",
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
    accountCurrency: currencyCode("USD"),
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

function pending(
  capabilities: AdapterCapabilities = managed,
  overrides: Partial<ReadyExecutionPlan> = {},
): {
  readonly attempt: ExecutionAttempt;
  readonly key: string;
} {
  const result = requestEntrySubmission(fresh(overrides), capabilities);
  expect(result.status).toBe("ENTRY_SUBMISSION_READY");
  if (result.status !== "ENTRY_SUBMISSION_READY") throw new Error("entry request failed");
  return { attempt: result.attempt, key: result.request.idempotencyKey };
}

function working(
  capabilities: AdapterCapabilities = managed,
  overrides: Partial<ReadyExecutionPlan> = {},
): ExecutionAttempt {
  const submitted = pending(capabilities, overrides);
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

function protect(
  attempt: ExecutionAttempt,
  at: number,
): { readonly attempt: ExecutionAttempt; readonly request: ProtectionRequest } {
  const requested = requestProtection(attempt);
  expect(requested.status).toBe("PROTECTION_REQUEST_READY");
  if (requested.status !== "PROTECTION_REQUEST_READY") throw new Error("protection request failed");
  const accepted = acknowledgeProtection(requested.attempt, {
    executionAttemptId: attempt.executionAttemptId,
    protectionRequestId: requested.request.protectionRequestId,
    idempotencyKey: requested.request.idempotencyKey,
    protectedQuantity: requested.request.targetCumulativeProtectedQuantity,
    acknowledgedAt: at,
  });
  expect(accepted.status).toBe("EXECUTION_ATTEMPT_UPDATED");
  return { attempt: accepted.attempt, request: requested.request };
}

function exitInput(
  attempt: ExecutionAttempt,
  request: ProtectionRequest,
  overrides: Partial<Parameters<typeof createExitFillEvent>[0]> = {},
): Parameters<typeof createExitFillEvent>[0] {
  return {
    executionAttemptId: attempt.executionAttemptId,
    protectionRequestId: request.protectionRequestId,
    exitSide: attempt.exitSide,
    exitLeg: "PROTECTIVE_STOP",
    fillId: "X1",
    filledQuantity: "1",
    fillPrice: "90",
    filledAt: 1_003,
    ...overrides,
  };
}

describe("execution attempt creation and identity", () => {
  it("creates only from a ready plan with the required zeroed initial state", () => {
    const result = fresh();
    expect(result).toMatchObject({
      status: "EXECUTION_ATTEMPT_READY",
      state: "READY_FOR_ENTRY_SUBMISSION",
      filledEntryQuantity: "0",
      protectedQuantity: "0",
      exitedQuantity: "0",
      unprotectedFilledQuantity: "0",
      entryPrice: "100",
      stopTriggerPrice: "90",
      targetPrice: "130",
    });
  });

  it("initializes immutable exit and acknowledged-protection ledgers under schema V3", () => {
    const attempt = fresh();
    expect(attempt.schemaVersion).toBe("EXECUTION_ATTEMPT_V3");
    expect(attempt.processedExitFills).toEqual([]);
    expect(attempt.acknowledgedProtections).toEqual([]);
    expect(Object.isFrozen(attempt.processedExitFills)).toBe(true);
    expect(Object.isFrozen(attempt.acknowledgedProtections)).toBe(true);
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

  it("copies the authoritative account currency with its unchanged risk amounts", () => {
    const source = plan({
      accountCurrency: currencyCode("BDT"),
      approvedRiskAmount: positiveDecimalString("1200"),
      actualRiskAmount: positiveDecimalString("1000"),
    });
    const before = JSON.stringify(source);
    const attempt = createExecutionAttempt(source);
    expect(attempt).toMatchObject({
      status: "EXECUTION_ATTEMPT_READY",
      schemaVersion: "EXECUTION_ATTEMPT_V3",
      accountCurrency: "BDT",
      approvedRiskAmount: "1200",
      actualRiskAmount: "1000",
    });
    expect(source).toMatchObject({ accountCurrency: "BDT", approvedRiskAmount: "1200", actualRiskAmount: "1000" });
    expect(JSON.stringify(source)).toBe(before);
  });

  it("fails closed for missing, malformed, and legacy-schema account-currency plans", () => {
    const { accountCurrency: _accountCurrency, ...missingCurrency } = plan();
    const invalidPlans = [
      missingCurrency,
      { ...plan(), accountCurrency: " " },
      { ...plan(), schemaVersion: "EXECUTION_PLAN_V1" },
    ];
    for (const invalid of invalidPlans) {
      expect(createExecutionAttempt(invalid as unknown as ReadyExecutionPlan)).toMatchObject({
        status: "DATA_REJECTED",
        reason: "INVALID_EXECUTION_PLAN",
      });
    }
  });
});

describe("account-currency lifecycle provenance", () => {
  const bdt = currencyCode("BDT");

  function expectBdt(...attempts: readonly ExecutionAttempt[]): void {
    for (const attempt of attempts) expect(attempt.accountCurrency).toBe(bdt);
  }

  it("preserves the risk denomination through entry, protection, exits, and duplicate delivery", () => {
    const created = fresh({ accountCurrency: bdt, approvedRiskAmount: positiveDecimalString("1200"), actualRiskAmount: positiveDecimalString("1000") });
    const original = JSON.stringify(created);
    const submitted = requestEntrySubmission(created, managed);
    if (submitted.status !== "ENTRY_SUBMISSION_READY") throw new Error("entry request failed");
    const acknowledged = acknowledgeEntrySubmission(submitted.attempt, {
      executionAttemptId: created.executionAttemptId,
      idempotencyKey: submitted.request.idempotencyKey,
      adapterOrderId: "ORDER-BDT",
      acknowledgedAt: 1_000,
    });
    const entry = {
      executionAttemptId: created.executionAttemptId,
      adapterOrderId: "ORDER-BDT",
      fillId: "ENTRY-BDT-1",
      filledQuantity: "0.4",
      fillPrice: "100",
      filledAt: 1_001,
    };
    const partialEntry = applyEntryFill(acknowledged.attempt, entry);
    const duplicateEntry = applyEntryFill(partialEntry.attempt, entry);
    const protection = requestProtection(partialEntry.attempt);
    if (protection.status !== "PROTECTION_REQUEST_READY") throw new Error("protection request failed");
    const protectedAttempt = acknowledgeProtection(protection.attempt, {
      executionAttemptId: created.executionAttemptId,
      protectionRequestId: protection.request.protectionRequestId,
      idempotencyKey: protection.request.idempotencyKey,
      protectedQuantity: "0.4",
      acknowledgedAt: 1_002,
    });
    const firstExitInput = exitInput(protectedAttempt.attempt, protection.request, {
      fillId: "EXIT-BDT-1",
      filledQuantity: "0.2",
      filledAt: 1_003,
    });
    const partialExit = applyExitFill(protectedAttempt.attempt, firstExitInput);
    const duplicateExit = applyExitFill(partialExit.attempt, firstExitInput);
    const fullEntry = applyEntryFill(partialExit.attempt, { ...entry, fillId: "ENTRY-BDT-2", filledQuantity: "0.6", filledAt: 1_004 });
    const secondProtection = requestProtection(fullEntry.attempt);
    if (secondProtection.status !== "PROTECTION_REQUEST_READY") throw new Error("second protection request failed");
    const fullyProtected = acknowledgeProtection(secondProtection.attempt, {
      executionAttemptId: created.executionAttemptId,
      protectionRequestId: secondProtection.request.protectionRequestId,
      idempotencyKey: secondProtection.request.idempotencyKey,
      protectedQuantity: "1",
      acknowledgedAt: 1_005,
    });
    const closed = applyExitFill(fullyProtected.attempt, exitInput(fullyProtected.attempt, secondProtection.request, {
      fillId: "EXIT-BDT-2",
      filledQuantity: "0.8",
      filledAt: 1_006,
    }));

    expectBdt(created, submitted.attempt, acknowledged.attempt, partialEntry.attempt, duplicateEntry.attempt,
      protection.attempt, protectedAttempt.attempt, partialExit.attempt, duplicateExit.attempt, fullEntry.attempt,
      secondProtection.attempt, fullyProtected.attempt, closed.attempt);
    expect(duplicateEntry.status).toBe("DUPLICATE_EVENT_IGNORED");
    expect(duplicateExit.status).toBe("DUPLICATE_EVENT_IGNORED");
    expect(closed.attempt).toMatchObject({ state: "EXIT_FILLED", actualRiskAmount: "1000", approvedRiskAmount: "1200" });
    expect(JSON.stringify(created)).toBe(original);
  });

  it("preserves the denomination through entry, protection, and cancellation rejection branches", () => {
    const created = fresh({ accountCurrency: bdt });
    const submitted = requestEntrySubmission(created, managed);
    if (submitted.status !== "ENTRY_SUBMISSION_READY") throw new Error("entry request failed");
    const entryRejected = rejectEntrySubmission(submitted.attempt, {
      executionAttemptId: created.executionAttemptId,
      idempotencyKey: submitted.request.idempotencyKey,
      adapterReasonCode: "ENTRY-DENIED",
      rejectedAt: 1_000,
    });

    const active = working(managed, { accountCurrency: bdt });
    const cancelRequested = requestEntryCancellation(active);
    if (cancelRequested.status !== "CANCELLATION_REQUEST_READY") throw new Error("cancel request failed");
    const cancelRejected = rejectCancellation(cancelRequested.attempt, {
      executionAttemptId: active.executionAttemptId,
      cancellationRequestId: cancelRequested.request.cancellationRequestId,
      idempotencyKey: cancelRequested.request.idempotencyKey,
      adapterOrderId: "ORDER-1",
      adapterReasonCode: "CANCEL-DENIED",
      rejectedAt: 1_001,
    });
    const cancelAcknowledged = acknowledgeCancellation(cancelRequested.attempt, {
      executionAttemptId: active.executionAttemptId,
      cancellationRequestId: cancelRequested.request.cancellationRequestId,
      idempotencyKey: cancelRequested.request.idempotencyKey,
      adapterOrderId: "ORDER-1",
      acknowledgedAt: 1_001,
    });

    const filled = fill(working(managed, { accountCurrency: bdt }), "F-BDT", "0.4", 1_001);
    const protectionRequested = requestProtection(filled);
    if (protectionRequested.status !== "PROTECTION_REQUEST_READY") throw new Error("protection request failed");
    const protectionRejected = rejectProtection(protectionRequested.attempt, {
      executionAttemptId: filled.executionAttemptId,
      protectionRequestId: protectionRequested.request.protectionRequestId,
      idempotencyKey: protectionRequested.request.idempotencyKey,
      adapterReasonCode: "PROTECTION-DENIED",
      rejectedAt: 1_002,
    });

    expectBdt(submitted.attempt, entryRejected.attempt, active, cancelRequested.attempt, cancelRejected.attempt,
      cancelAcknowledged.attempt, filled, protectionRequested.attempt, protectionRejected.attempt);
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

describe("authoritative exit event normalization", () => {
  const base = {
    executionAttemptId: "attempt-1",
    protectionRequestId: "protection-1",
    exitSide: "SELL" as const,
    exitLeg: "PROTECTIVE_STOP" as const,
    fillId: "exit-1",
    filledQuantity: "2.5",
    fillPrice: "90.25",
    filledAt: 2_000,
  };

  it.each(["PROTECTIVE_STOP", "PROFIT_TARGET"] as const)("accepts an explicit %s leg", (exitLeg) => {
    expect(createExitFillEvent({ ...base, exitLeg })).toEqual({
      kind: "EXIT_FILL",
      ...base,
      exitLeg,
    });
  });

  it("rejects malformed legs, quantities, prices, timestamps, sides, and identities", () => {
    const malformed = [
      { ...base, exitLeg: "OTHER" },
      { ...base, exitSide: "HOLD" },
      { ...base, filledQuantity: "0" },
      { ...base, filledQuantity: "-1" },
      { ...base, filledQuantity: "1e3" },
      { ...base, fillPrice: "not-a-price" },
      { ...base, filledAt: -1 },
      { ...base, executionAttemptId: "" },
      { ...base, protectionRequestId: " " },
      { ...base, fillId: "" },
    ];
    for (const input of malformed) {
      expect(() => createExitFillEvent(input as Parameters<typeof createExitFillEvent>[0])).toThrow();
    }
  });

  it("freezes normalized events and does not mutate primitive input", () => {
    const input = { ...base };
    const before = JSON.stringify(input);
    const event = createExitFillEvent(input);
    expect(JSON.stringify(input)).toBe(before);
    expect(Object.isFrozen(event)).toBe(true);
  });
});

describe("acknowledged protection provenance", () => {
  it("appends immutable request and acknowledgement evidence with cumulative ceilings", () => {
    const initial = working();
    const firstFill = fill(initial, "F1", "0.4", 1_001);
    const first = protect(firstFill, 1_002);
    const secondFill = fill(first.attempt, "F2", "0.3", 1_003);
    const second = protect(secondFill, 1_004);

    expect(second.attempt.acknowledgedProtections).toHaveLength(2);
    expect(second.attempt.acknowledgedProtections[0]).toMatchObject({
      kind: "ACKNOWLEDGED_PROTECTION",
      request: {
        protectionRequestId: first.request.protectionRequestId,
        mode: "MANAGED_PROTECTION",
        protectedQuantity: "0.4",
        targetCumulativeProtectedQuantity: "0.4",
      },
      acknowledgement: { protectedQuantity: "0.4", acknowledgedAt: 1_002 },
    });
    expect(second.attempt.acknowledgedProtections[1]?.request).toMatchObject({
      protectionRequestId: second.request.protectionRequestId,
      protectedQuantity: "0.3",
      targetCumulativeProtectedQuantity: "0.7",
    });
    expect(Object.isFrozen(second.attempt.acknowledgedProtections)).toBe(true);
    expect(Object.isFrozen(second.attempt.acknowledgedProtections[0])).toBe(true);
    expect(Object.isFrozen(second.attempt.acknowledgedProtections[0]?.request)).toBe(true);
    expect(Object.isFrozen(second.attempt.acknowledgedProtections[0]?.acknowledgement)).toBe(true);
  });
});

describe("authoritative exit fill lifecycle", () => {
  it("requires matching attempt, side, and acknowledged protection identity", () => {
    const entered = fill(working(), "F1", "1", 1_001);
    const protectedAttempt = protect(entered, 1_002);
    const event = exitInput(protectedAttempt.attempt, protectedAttempt.request);
    expect(applyExitFill(protectedAttempt.attempt, { ...event, executionAttemptId: "other" })).toMatchObject({
      reason: "EVENT_ATTEMPT_MISMATCH",
    });
    expect(applyExitFill(protectedAttempt.attempt, { ...event, exitSide: "BUY" })).toMatchObject({
      reason: "EXIT_SIDE_MISMATCH",
    });
    expect(applyExitFill(protectedAttempt.attempt, { ...event, protectionRequestId: "unknown" })).toMatchObject({
      reason: "EXIT_PROTECTION_REQUEST_NOT_ACKNOWLEDGED",
    });
    expect(applyExitFill(entered, event)).toMatchObject({
      reason: "EXIT_PROTECTION_REQUEST_NOT_ACKNOWLEDGED",
    });
    const entryEvent = createFillEvent({
      executionAttemptId: entered.executionAttemptId,
      adapterOrderId: "ORDER-1",
      fillId: "entry-not-exit",
      filledQuantity: "0.1",
      fillPrice: "100",
      filledAt: 1_002,
    });
    expect(applyExitFill(protectedAttempt.attempt, entryEvent as unknown as Parameters<typeof applyExitFill>[1]))
      .toMatchObject({ reason: "INVALID_EVENT" });
  });

  it("preserves authoritative leg identity regardless of execution price", () => {
    const entered = fill(working({ ...managed }), "F1", "1", 1_001);
    const protectedAttempt = protect(entered, 1_002);
    const stop = applyExitFill(protectedAttempt.attempt, exitInput(protectedAttempt.attempt, protectedAttempt.request, {
      exitLeg: "PROTECTIVE_STOP",
      fillPrice: "130",
      filledQuantity: "0.4",
    }));
    expect(stop.attempt.processedExitFills[0]).toMatchObject({ exitLeg: "PROTECTIVE_STOP", fillPrice: "130" });
    const target = applyExitFill(stop.attempt, exitInput(stop.attempt, protectedAttempt.request, {
      exitLeg: "PROFIT_TARGET",
      fillId: "X2",
      fillPrice: "90",
      filledQuantity: "0.6",
      filledAt: 1_004,
    }));
    expect(target.attempt.processedExitFills[1]).toMatchObject({ exitLeg: "PROFIT_TARGET", fillPrice: "90" });
    expect(target.attempt.state).toBe("EXIT_FILLED");
  });

  it("accumulates exact partial exits and becomes terminal only after full non-working entry exit", () => {
    const entered = fill(working(), "F1", "1", 1_001);
    const protectedAttempt = protect(entered, 1_002);
    const first = applyExitFill(protectedAttempt.attempt, exitInput(protectedAttempt.attempt, protectedAttempt.request, {
      filledQuantity: "0.25",
    }));
    const second = applyExitFill(first.attempt, exitInput(first.attempt, protectedAttempt.request, {
      fillId: "X2", filledQuantity: "0.325", filledAt: 1_004,
    }));
    const third = applyExitFill(second.attempt, exitInput(second.attempt, protectedAttempt.request, {
      fillId: "X3", filledQuantity: "0.425", filledAt: 1_005,
    }));
    expect(first.attempt).toMatchObject({ exitedQuantity: "0.25", state: "EXIT_PARTIALLY_FILLED" });
    expect(second.attempt).toMatchObject({ exitedQuantity: "0.575", state: "EXIT_PARTIALLY_FILLED" });
    expect(third.attempt).toMatchObject({ exitedQuantity: "1", state: "EXIT_FILLED" });
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.attempt)).toBe(true);
    expect(Object.isFrozen(first.attempt.processedExitFills)).toBe(true);
    expect(third.attempt).not.toHaveProperty("realizedPnL");
  });

  it("keeps entry and exit fill identity domains separate and remains deterministic", () => {
    const entered = fill(working(), "SAME-ID", "1", 1_001);
    const protectedAttempt = protect(entered, 1_002);
    const event = exitInput(protectedAttempt.attempt, protectedAttempt.request, { fillId: "SAME-ID" });
    const first = applyExitFill(protectedAttempt.attempt, event);
    const replay = applyExitFill(protectedAttempt.attempt, event);
    expect(first).toEqual(replay);
    expect(first).toMatchObject({
      status: "EXECUTION_ATTEMPT_UPDATED",
      attempt: {
        processedFills: [{ fillId: "SAME-ID" }],
        processedExitFills: [{ fillId: "SAME-ID" }],
      },
    });
  });

  it("accumulates 2.5 + 3.25 + 4.25 exactly to 10", () => {
    const entered = fill(working(managed, { quantity: positiveDecimalString("10") }), "F1", "10", 1_001);
    const requested = requestProtection(entered);
    expect(requested.status).toBe("PROTECTION_REQUEST_READY");
    if (requested.status !== "PROTECTION_REQUEST_READY") return;
    const acknowledged = acknowledgeProtection(requested.attempt, {
      executionAttemptId: requested.attempt.executionAttemptId,
      protectionRequestId: requested.request.protectionRequestId,
      idempotencyKey: requested.request.idempotencyKey,
      protectedQuantity: "10",
      acknowledgedAt: 1_002,
    }).attempt;
    const quantities = ["2.5", "3.25", "4.25"];
    const final = quantities.reduce((attempt, quantity, index) => applyExitFill(attempt, exitInput(
      attempt,
      requested.request,
      { fillId: `X${index + 1}`, filledQuantity: quantity, filledAt: 1_003 + index },
    )).attempt, acknowledged);
    expect(final).toMatchObject({ exitedQuantity: "10", state: "EXIT_FILLED" });
  });

  it("rejects global over-exit and an older request's cumulative coverage ceiling", () => {
    const initial = working(managed, { quantity: positiveDecimalString("10") });
    const firstEntry = fill(initial, "F1", "5", 1_001);
    const firstProtection = protect(firstEntry, 1_002);
    const fullEntry = fill(firstProtection.attempt, "F2", "5", 1_003);
    const fullProtection = protect(fullEntry, 1_004);
    expect(applyExitFill(fullProtection.attempt, exitInput(fullProtection.attempt, fullProtection.request, {
      filledQuantity: "10.01", filledAt: 1_005,
    }))).toMatchObject({
      status: "DATA_REJECTED",
      reason: "OVER_EXIT_DETECTED",
      attempt: { exitedQuantity: "0", protectedQuantity: "10", filledEntryQuantity: "10" },
    });
    expect(applyExitFill(fullProtection.attempt, exitInput(fullProtection.attempt, firstProtection.request, {
      filledQuantity: "6", filledAt: 1_005,
    }))).toMatchObject({
      status: "DATA_REJECTED",
      reason: "EXIT_COVERAGE_EXCEEDED",
      attempt: { exitedQuantity: "0", protectedQuantity: "10", filledEntryQuantity: "10" },
    });
  });

  it("ignores exact duplicates and rejects every meaningful conflicting reuse atomically", () => {
    const entered = fill(working(), "F1", "1", 1_001);
    const protectedAttempt = protect(entered, 1_002);
    const event = exitInput(protectedAttempt.attempt, protectedAttempt.request, { filledQuantity: "0.4" });
    const first = applyExitFill(protectedAttempt.attempt, event);
    const duplicate = applyExitFill(first.attempt, event);
    expect(duplicate).toMatchObject({ status: "DUPLICATE_EVENT_IGNORED", attempt: { exitedQuantity: "0.4" } });
    for (const changed of [
      { filledQuantity: "0.5" },
      { fillPrice: "91" },
      { exitLeg: "PROFIT_TARGET" as const },
    ]) {
      const conflict = applyExitFill(first.attempt, { ...event, ...changed });
      expect(conflict).toMatchObject({ status: "DATA_REJECTED", reason: "DUPLICATE_EXIT_FILL_CONFLICT" });
      expect(conflict.attempt).toBe(first.attempt);
    }
    expect(protectedAttempt.attempt.exitedQuantity).toBe("0");
  });

  it("accepts equal chronology, rejects backward chronology, and never sorts events", () => {
    const entered = fill(working(), "F1", "1", 1_001);
    const protectedAttempt = protect(entered, 1_002);
    const equal = applyExitFill(protectedAttempt.attempt, exitInput(protectedAttempt.attempt, protectedAttempt.request, {
      filledQuantity: "0.2", filledAt: 1_002,
    }));
    expect(equal.status).toBe("EXECUTION_ATTEMPT_UPDATED");
    expect(applyExitFill(equal.attempt, exitInput(equal.attempt, protectedAttempt.request, {
      fillId: "X2", filledQuantity: "0.2", filledAt: 1_001,
    }))).toMatchObject({ reason: "OUT_OF_ORDER_EXECUTION_EVENT" });
    expect(equal.attempt.processedExitFills.map(({ fillId }) => fillId)).toEqual(["X1"]);
  });

  it.each([
    ["PROTECTIVE_STOP", "PROFIT_TARGET"],
    ["PROFIT_TARGET", "PROTECTIVE_STOP"],
  ] as const)("rejects a %s/%s race after the first leg fully exits", (firstLeg, secondLeg) => {
    const entered = fill(working(), "F1", "1", 1_001);
    const protectedAttempt = protect(entered, 1_002);
    const first = applyExitFill(protectedAttempt.attempt, exitInput(protectedAttempt.attempt, protectedAttempt.request, {
      exitLeg: firstLeg,
    }));
    const second = applyExitFill(first.attempt, exitInput(first.attempt, protectedAttempt.request, {
      exitLeg: secondLeg, fillId: "X2", filledAt: 1_004,
    }));
    expect(first.attempt.processedExitFills).toHaveLength(1);
    expect(second).toMatchObject({ status: "DATA_REJECTED", reason: "OVER_EXIT_DETECTED" });
    expect(second.attempt.processedExitFills).toHaveLength(1);
  });

  it.each([
    ["managed", managed],
    ["native", native],
  ] as const)("applies the same exit arithmetic for %s protection", (_name, capabilities) => {
    const entered = fill(working(capabilities), "F1", "1", 1_001);
    const protectedAttempt = protect(entered, 1_002);
    expect(applyExitFill(protectedAttempt.attempt, exitInput(protectedAttempt.attempt, protectedAttempt.request)))
      .toMatchObject({ status: "EXECUTION_ATTEMPT_UPDATED", attempt: { exitedQuantity: "1", state: "EXIT_FILLED" } });
  });
});

describe("partial entry, early exit, and later entry fills", () => {
  it("keeps a working entry non-terminal, then protects and exits later incremental exposure", () => {
    const base = working(managed, { quantity: positiveDecimalString("10") });
    const partial = fill(base, "F1", "2.75", 1_001);
    const firstProtection = protect(partial, 1_002);
    const earlyExit = applyExitFill(firstProtection.attempt, exitInput(firstProtection.attempt, firstProtection.request, {
      filledQuantity: "2.75",
    })).attempt;
    expect(earlyExit).toMatchObject({
      entryOrderStatus: "WORKING",
      filledEntryQuantity: "2.75",
      exitedQuantity: "2.75",
      state: "EXIT_PARTIALLY_FILLED",
    });

    const laterEntry = fill(earlyExit, "F2", "1.25", 1_004);
    expect(laterEntry).toMatchObject({ filledEntryQuantity: "4", exitedQuantity: "2.75" });
    const secondRequest = requestProtection(laterEntry);
    expect(secondRequest).toMatchObject({
      status: "PROTECTION_REQUEST_READY",
      request: { protectedQuantity: "1.25", targetCumulativeProtectedQuantity: "4" },
    });
    if (secondRequest.status !== "PROTECTION_REQUEST_READY") return;
    const secondAcknowledgement = acknowledgeProtection(secondRequest.attempt, {
      executionAttemptId: secondRequest.attempt.executionAttemptId,
      protectionRequestId: secondRequest.request.protectionRequestId,
      idempotencyKey: secondRequest.request.idempotencyKey,
      protectedQuantity: "4",
      acknowledgedAt: 1_005,
    });
    const finalExit = applyExitFill(secondAcknowledgement.attempt, exitInput(
      secondAcknowledgement.attempt,
      secondRequest.request,
      { fillId: "X2", filledQuantity: "1.25", filledAt: 1_006 },
    ));
    expect(finalExit.attempt).toMatchObject({
      filledEntryQuantity: "4",
      protectedQuantity: "4",
      exitedQuantity: "4",
      entryOrderStatus: "WORKING",
      state: "EXIT_PARTIALLY_FILLED",
    });
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
