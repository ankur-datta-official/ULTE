import { describe, expect, it } from "vitest";
import {
  createAdapterCapabilities,
  createEntryAcknowledgement,
  createExecutionAttempt,
  createFillEvent,
  requestEntrySubmission,
  type ExecutionAttempt,
  type FillEvent,
} from "@ulte/execution-engine";
import type { ReadyExecutionPlan } from "@ulte/execution-preparation-engine";
import {
  currencyCode,
  createInstrumentId,
  positiveDecimalString,
  unixMs,
} from "@ulte/instrument-model";
import type {
  RealtimeExecutionSubmissionResult,
  SubmissionConfirmedResult,
} from "@ulte/realtime-execution-submission-engine";
import {
  applyRealtimeExecutionFill,
  initializeRealtimeExecutionFillLifecycle,
} from "./index.js";

const instrument = createInstrumentId({ venue: "TEST", venueSymbol: "ABC", instrumentKind: "CFD" });
const capabilities = createAdapterCapabilities({
  supportsClientIdempotency: true,
  supportsCloseOnlyExit: true,
  supportsNativeBracketProtection: false,
  supportsProtectionModification: false,
  supportsOrderCancellation: true,
  supportsPartialFillReporting: true,
});

function plan(quantity = "10"): ReadyExecutionPlan {
  const normalizedQuantity = positiveDecimalString(quantity);
  return Object.freeze({
    status: "EXECUTION_PLAN_READY",
    schemaVersion: "EXECUTION_PLAN_V2",
    executionPlanId: "plan-1",
    tradeIntentId: "intent-1",
    candidateId: "candidate-1",
    instrumentId: instrument,
    intentAsOf: unixMs(900),
    marketSnapshotAsOf: unixMs(1_000),
    preparedAsOf: unixMs(1_000),
    direction: "UP",
    entrySide: "BUY",
    exitSide: "SELL",
    quantity: normalizedQuantity,
    quantityUnit: "contract", accountCurrency: currencyCode("USD"),
    entryInstruction: Object.freeze({
      kind: "ENTRY_LIMIT", side: "BUY", price: positiveDecimalString("100"),
      quantity: normalizedQuantity, positionEffect: "OPEN",
    }),
    protectiveStopInstruction: Object.freeze({
      kind: "PROTECTIVE_STOP_TRIGGER", side: "SELL", triggerPrice: positiveDecimalString("90"),
      quantity: normalizedQuantity, positionEffect: "CLOSE",
    }),
    profitTargetInstruction: Object.freeze({
      kind: "PROFIT_TARGET_LIMIT", side: "SELL", price: positiveDecimalString("130"),
      quantity: normalizedQuantity, positionEffect: "CLOSE",
    }),
    priceTick: positiveDecimalString("1"),
    quantityStep: positiveDecimalString("0.01"),
    bidAtPreparation: positiveDecimalString("100"),
    askAtPreparation: positiveDecimalString("100"),
    intentAgeMs: 100,
    quoteAgeMs: 0,
    entryDeviationBps: "0",
    approvedRiskAmount: positiveDecimalString("100"),
    actualRiskAmount: positiveDecimalString("100"),
    netRewardRiskBps: "30000",
  });
}

function confirmed(options: {
  readonly quantity?: string;
  readonly acknowledgementAt?: number;
  readonly acknowledgement?: boolean;
} = {}): SubmissionConfirmedResult {
  const created = createExecutionAttempt(plan(options.quantity));
  if (created.status !== "EXECUTION_ATTEMPT_READY") throw new Error("attempt creation failed");
  const requested = requestEntrySubmission(created, capabilities);
  if (requested.status !== "ENTRY_SUBMISSION_READY") throw new Error("entry request failed");
  const acknowledgement = createEntryAcknowledgement({
    executionAttemptId: requested.attempt.executionAttemptId,
    idempotencyKey: requested.attempt.submissionIdempotencyKey,
    adapterOrderId: "ORDER-1",
    acknowledgedAt: options.acknowledgementAt ?? 1_100,
  });
  const durableResult = Object.freeze({
    status: "CONFIRMED",
    operation: "ENTRY_SUBMISSION",
    idempotencyKey: requested.attempt.submissionIdempotencyKey,
    requestFingerprint: "fingerprint-1",
    auditDelivery: "NOT_CONFIGURED",
    record: Object.freeze({
      executionAttemptId: requested.attempt.executionAttemptId,
      idempotencyKey: requested.attempt.submissionIdempotencyKey,
      adapterOrderId: "ORDER-1",
    }),
    ...(options.acknowledgement === false ? {} : { acknowledgement }),
  });
  return Object.freeze({
    status: "SUBMISSION_CONFIRMED",
    preparationCycleId: "preparation-1",
    submissionAsOf: unixMs(1_100),
    executionAttempt: requested.attempt,
    durableResult,
  }) as unknown as SubmissionConfirmedResult;
}

function nonConfirmed(status: Exclude<RealtimeExecutionSubmissionResult["status"], "SUBMISSION_CONFIRMED">) {
  return Object.freeze({
    status,
    preparationCycleId: "preparation-1",
  }) as unknown as RealtimeExecutionSubmissionResult;
}

function initialized(submission = confirmed()): ExecutionAttempt {
  const result = initializeRealtimeExecutionFillLifecycle(submission);
  if (result.status !== "FILL_LIFECYCLE_INITIALIZED") throw new Error("initialization failed");
  return result.executionAttempt;
}

function fill(
  attempt: ExecutionAttempt,
  fillId: string,
  filledQuantity: string,
  fillPrice = "100.25",
  filledAt = 1_101,
): FillEvent {
  return createFillEvent({
    executionAttemptId: attempt.executionAttemptId,
    adapterOrderId: "ORDER-1",
    fillId,
    filledQuantity,
    fillPrice,
    filledAt,
  });
}

function apply(
  submission: RealtimeExecutionSubmissionResult,
  attempt: ExecutionAttempt,
  event: FillEvent,
  observationAsOf = event.filledAt,
) {
  return applyRealtimeExecutionFill({ submission, executionAttempt: attempt, fill: event, observationAsOf });
}

describe("Task 021 gating and acknowledgement separation", () => {
  it("initializes only a confirmed accepted submission and keeps acknowledgement fill-free", () => {
    const submission = confirmed();
    expect(submission.executionAttempt.processedFills).toEqual([]);
    const result = initializeRealtimeExecutionFillLifecycle(submission);
    expect(result).toMatchObject({
      status: "FILL_LIFECYCLE_INITIALIZED",
      executionAttempt: {
        state: "ENTRY_WORKING",
        entryOrderStatus: "WORKING",
        filledEntryQuantity: "0",
        exitedQuantity: "0",
        processedFills: [],
        processedExitFills: [],
        acknowledgedProtections: [],
      },
    });
  });

  it.each([
    "NO_SUBMISSION",
    "SUBMISSION_BLOCKED",
    "SUBMISSION_REJECTED",
    "RECONCILIATION_REQUIRED",
    "DURABLE_SUBMISSION_CONTROL",
  ] as const)("returns NO_FILL_PROCESSING for %s", (status) => {
    const submission = nonConfirmed(status);
    expect(initializeRealtimeExecutionFillLifecycle(submission)).toEqual({
      status: "NO_FILL_PROCESSING",
      preparationCycleId: "preparation-1",
      upstreamStatus: status,
    });
    const attempt = initialized();
    expect(apply(submission, attempt, fill(attempt, "F1", "1"))).toMatchObject({
      status: "NO_FILL_PROCESSING", upstreamStatus: status,
    });
  });

  it("does not reconstruct an acknowledgement for a durable confirmation replay", () => {
    expect(initializeRealtimeExecutionFillLifecycle(confirmed({ acknowledgement: false }))).toMatchObject({
      status: "FILL_REJECTED", reason: "CONFIRMED_ACKNOWLEDGEMENT_MISSING",
    });
  });

  it("rejects acknowledgement chronology that predates submission", () => {
    expect(initializeRealtimeExecutionFillLifecycle(confirmed({ acknowledgementAt: 1_099 }))).toMatchObject({
      status: "FILL_REJECTED", reason: "ACKNOWLEDGEMENT_CHRONOLOGY_INVALID",
    });
  });
});

describe("partial, full, invalid, and overfill transitions", () => {
  it("reuses exact execution-engine accumulation for three decimal partial fills", () => {
    const submission = confirmed();
    const initial = initialized(submission);
    const first = apply(submission, initial, fill(initial, "F1", "2.5", "100.10", 1_101));
    expect(first).toMatchObject({
      status: "FILL_APPLIED",
      executionAttempt: { state: "ENTRY_PARTIALLY_FILLED", filledEntryQuantity: "2.5", lastFillPrice: "100.10" },
    });
    if (first.status !== "FILL_APPLIED") throw new Error("first fill failed");
    const second = apply(submission, first.executionAttempt, fill(first.executionAttempt, "F2", "3.25", "100.20", 1_102));
    expect(second).toMatchObject({ executionAttempt: { filledEntryQuantity: "5.75", processedFills: [{ fillId: "F1" }, { fillId: "F2" }] } });
    if (second.status !== "FILL_APPLIED") throw new Error("second fill failed");
    const third = apply(submission, second.executionAttempt, fill(second.executionAttempt, "F3", "4.25", "100.30", 1_103));
    expect(third).toMatchObject({
      status: "FILL_APPLIED",
      executionAttempt: {
        state: "ENTRY_FILLED", entryOrderStatus: "FILLED", filledEntryQuantity: "10",
        lastFillPrice: "100.30", processedFills: [{ fillId: "F1" }, { fillId: "F2" }, { fillId: "F3" }],
      },
    });
    if (third.status !== "FILL_APPLIED") throw new Error("third fill failed");
    expect(apply(submission, third.executionAttempt, fill(third.executionAttempt, "F4", "0.01", "100", 1_104)))
      .toMatchObject({ status: "FILL_REJECTED", reason: "INVALID_TRANSITION" });
  });

  it("rejects an overfill without changing the supplied attempt", () => {
    const submission = confirmed();
    const attempt = initialized(submission);
    const before = JSON.stringify(attempt);
    const result = apply(submission, attempt, fill(attempt, "F1", "10.01"));
    expect(result).toMatchObject({ status: "FILL_REJECTED", reason: "OVERFILL_DETECTED", executionAttempt: attempt });
    expect(JSON.stringify(attempt)).toBe(before);
  });

  it.each([
    ["0", "100"],
    ["-1", "100"],
    ["1", "not-a-price"],
  ])("rejects invalid quantity/price %s/%s through existing validation", (filledQuantity, fillPrice) => {
    const submission = confirmed();
    const attempt = initialized(submission);
    const malformed = Object.freeze({
      kind: "FILL",
      executionAttemptId: attempt.executionAttemptId,
      adapterOrderId: "ORDER-1",
      fillId: "F1",
      filledQuantity,
      fillPrice,
      filledAt: 1_101,
    }) as unknown as FillEvent;
    expect(apply(submission, attempt, malformed)).toMatchObject({ status: "FILL_REJECTED", reason: "INVALID_EVENT" });
    expect(attempt.processedFills).toEqual([]);
  });
});

describe("duplicate identity, execution coherence, and chronology", () => {
  it("ignores an exact duplicate and rejects a changed payload with the same fill ID", () => {
    const submission = confirmed();
    const initial = initialized(submission);
    const event = fill(initial, "F1", "2.5", "100.25", 1_101);
    const first = apply(submission, initial, event);
    if (first.status !== "FILL_APPLIED") throw new Error("first fill failed");
    const duplicate = apply(submission, first.executionAttempt, event);
    expect(duplicate).toMatchObject({
      status: "DUPLICATE_FILL",
      executionAttempt: { filledEntryQuantity: "2.5", lastFillPrice: "100.25", processedFills: [{ fillId: "F1" }] },
    });
    const before = JSON.stringify(first.executionAttempt);
    const conflict = apply(submission, first.executionAttempt, fill(first.executionAttempt, "F1", "2.5", "101", 1_101));
    expect(conflict).toMatchObject({ status: "FILL_REJECTED", reason: "DUPLICATE_FILL_CONFLICT" });
    expect(JSON.stringify(first.executionAttempt)).toBe(before);
  });

  it("rejects wrong fill attempt and adapter-order identities", () => {
    const submission = confirmed();
    const attempt = initialized(submission);
    expect(apply(submission, attempt, createFillEvent({
      executionAttemptId: "other", adapterOrderId: "ORDER-1", fillId: "F1",
      filledQuantity: "1", fillPrice: "100", filledAt: 1_101,
    }))).toMatchObject({ status: "FILL_REJECTED", reason: "EVENT_ATTEMPT_MISMATCH" });
    expect(apply(submission, attempt, createFillEvent({
      executionAttemptId: attempt.executionAttemptId, adapterOrderId: "OTHER", fillId: "F1",
      filledQuantity: "1", fillPrice: "100", filledAt: 1_101,
    }))).toMatchObject({ status: "FILL_REJECTED", reason: "ADAPTER_ORDER_ID_MISMATCH" });
  });

  it("rejects a current attempt with changed idempotency or instrument identity", () => {
    const submission = confirmed();
    const attempt = initialized(submission);
    const otherInstrument = createInstrumentId({ venue: "TEST", venueSymbol: "OTHER", instrumentKind: "CFD" });
    for (const changed of [
      Object.freeze({ ...attempt, submissionIdempotencyKey: "other" }),
      Object.freeze({ ...attempt, instrumentId: otherInstrument }),
    ] as const) {
      expect(apply(submission, changed, fill(attempt, "F1", "1"))).toMatchObject({
        status: "FILL_REJECTED", reason: "CURRENT_ATTEMPT_MISMATCH",
      });
    }
  });

  it("rejects future and out-of-order events but accepts the exact observation boundary", () => {
    const submission = confirmed();
    const attempt = initialized(submission);
    expect(apply(submission, attempt, fill(attempt, "F1", "1", "100", 1_102), 1_101))
      .toMatchObject({ status: "FILL_REJECTED", reason: "FILL_OBSERVED_IN_FUTURE" });
    expect(apply(submission, attempt, fill(attempt, "F1", "1", "100", 1_100), 1_100))
      .toMatchObject({ status: "FILL_APPLIED" });
    expect(apply(submission, attempt, fill(attempt, "F1", "1", "100", 1_099), 1_100))
      .toMatchObject({ status: "FILL_REJECTED", reason: "OUT_OF_ORDER_EXECUTION_EVENT" });
  });
});

describe("purity and deterministic replay", () => {
  it("does not mutate caller values and freezes all public results", () => {
    const submission = confirmed();
    const attempt = initialized(submission);
    const event = fill(attempt, "F1", "1");
    const before = JSON.stringify({ submission, attempt, event });
    const result = apply(submission, attempt, event);
    expect(JSON.stringify({ submission, attempt, event })).toBe(before);
    expect(Object.isFrozen(result)).toBe(true);
    expect(result.status === "FILL_APPLIED" && Object.isFrozen(result.executionAttempt)).toBe(true);
    expect(result.status === "FILL_APPLIED" && Object.isFrozen(result.executionAttempt.processedFills)).toBe(true);
    expect(Object.isFrozen(event)).toBe(true);
  });

  it("replays the same authoritative fill sequence to an equal final state", () => {
    const project = (): ExecutionAttempt => {
      const submission = confirmed();
      let attempt = initialized(submission);
      for (const [fillId, quantity, price, at] of [
        ["F1", "2.5", "100.1", 1_101],
        ["F2", "3.25", "100.2", 1_102],
        ["F3", "4.25", "100.3", 1_103],
      ] as const) {
        const result = apply(submission, attempt, fill(attempt, fillId, quantity, price, at));
        if (result.status !== "FILL_APPLIED") throw new Error("replay fill failed");
        attempt = result.executionAttempt;
      }
      return attempt;
    };
    expect(project()).toEqual(project());
  });
});
