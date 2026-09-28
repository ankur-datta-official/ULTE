import { describe, expect, it } from "vitest";
import {
  acknowledgeEntrySubmission,
  acknowledgeProtection,
  applyEntryFill,
  createAdapterCapabilities,
  createEntryAcknowledgement,
  createExecutionAttempt,
  createExitFillEvent,
  createFillEvent,
  createProtectionAcknowledgement,
  requestEntrySubmission,
  requestProtection,
  type AdapterCapabilities,
  type ExecutionAttempt,
  type ExitFillEvent,
} from "@ulte/execution-engine";
import { createInstrumentId, positiveDecimalString, unixMs } from "@ulte/instrument-model";
import type {
  ProtectionAcknowledgementAppliedResult,
  RealtimeExecutionProtectionLifecycleResult,
} from "@ulte/realtime-execution-protection-lifecycle-engine";
import {
  applyRealtimeExecutionExitFill,
  RealtimeExecutionExitFillEngine,
  type RealtimeExecutionExitFillInput,
} from "./index.js";

const instrument = createInstrumentId({ venue: "TEST", venueSymbol: "ABC", instrumentKind: "CFD" });
const managedCapabilities = createAdapterCapabilities({
  supportsClientIdempotency: true,
  supportsCloseOnlyExit: true,
  supportsNativeBracketProtection: false,
  supportsProtectionModification: false,
  supportsOrderCancellation: true,
  supportsPartialFillReporting: true,
});
const nativeCapabilities = createAdapterCapabilities({
  ...managedCapabilities,
  supportsNativeBracketProtection: true,
});

function submittedAttempt(capabilities: AdapterCapabilities = managedCapabilities): ExecutionAttempt {
  const plan = Object.freeze({
    status: "EXECUTION_PLAN_READY",
    schemaVersion: "EXECUTION_PLAN_V1",
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
    quantity: positiveDecimalString("10"),
    quantityUnit: "contract",
    entryInstruction: Object.freeze({
      kind: "ENTRY_LIMIT", side: "BUY", price: positiveDecimalString("100"),
      quantity: positiveDecimalString("10"), positionEffect: "OPEN",
    }),
    protectiveStopInstruction: Object.freeze({
      kind: "PROTECTIVE_STOP_TRIGGER", side: "SELL", triggerPrice: positiveDecimalString("90"),
      quantity: positiveDecimalString("10"), positionEffect: "CLOSE",
    }),
    profitTargetInstruction: Object.freeze({
      kind: "PROFIT_TARGET_LIMIT", side: "SELL", price: positiveDecimalString("130"),
      quantity: positiveDecimalString("10"), positionEffect: "CLOSE",
    }),
    priceTick: positiveDecimalString("0.01"),
    quantityStep: positiveDecimalString("0.01"),
    bidAtPreparation: positiveDecimalString("99.99"),
    askAtPreparation: positiveDecimalString("100"),
    intentAgeMs: 100,
    quoteAgeMs: 0,
    entryDeviationBps: "0",
    approvedRiskAmount: positiveDecimalString("100"),
    actualRiskAmount: positiveDecimalString("100"),
    netRewardRiskBps: "30000",
  } as const);
  const created = createExecutionAttempt(plan);
  if (created.status !== "EXECUTION_ATTEMPT_READY") throw new Error("fixture creation failed");
  const requested = requestEntrySubmission(created, capabilities);
  if (requested.status !== "ENTRY_SUBMISSION_READY") throw new Error("fixture submission failed");
  const acknowledged = acknowledgeEntrySubmission(requested.attempt, createEntryAcknowledgement({
    executionAttemptId: requested.attempt.executionAttemptId,
    idempotencyKey: requested.attempt.submissionIdempotencyKey,
    adapterOrderId: "entry-order-1",
    acknowledgedAt: 1_100,
  }));
  if (acknowledged.status !== "EXECUTION_ATTEMPT_UPDATED") throw new Error("fixture acknowledgement failed");
  return acknowledged.attempt;
}

function protectedLifecycle(
  entryFillQuantity = "10",
  capabilities: AdapterCapabilities = managedCapabilities,
): ProtectionAcknowledgementAppliedResult {
  const submitted = submittedAttempt(capabilities);
  const entryFill = createFillEvent({
    executionAttemptId: submitted.executionAttemptId,
    adapterOrderId: submitted.adapterOrderId!,
    fillId: "entry-fill-1",
    filledQuantity: entryFillQuantity,
    fillPrice: "100",
    filledAt: 1_200,
  });
  const filled = applyEntryFill(submitted, entryFill);
  if (filled.status !== "EXECUTION_ATTEMPT_UPDATED") throw new Error("fixture fill failed");
  const requested = requestProtection(filled.attempt);
  if (requested.status !== "PROTECTION_REQUEST_READY") throw new Error("fixture protection failed");
  const acknowledgement = createProtectionAcknowledgement({
    executionAttemptId: requested.request.executionAttemptId,
    protectionRequestId: requested.request.protectionRequestId,
    idempotencyKey: requested.request.idempotencyKey,
    protectedQuantity: requested.request.targetCumulativeProtectedQuantity,
    acknowledgedAt: 1_400,
  });
  const transition = acknowledgeProtection(requested.attempt, acknowledgement);
  if (transition.status !== "EXECUTION_ATTEMPT_UPDATED") throw new Error("fixture protection acknowledgement failed");
  return Object.freeze({
    status: "PROTECTION_ACKNOWLEDGEMENT_APPLIED",
    preparationCycleId: "preparation-1",
    protectionAsOf: unixMs(1_300),
    observationAsOf: unixMs(1_400),
    acknowledgement,
    executionAttempt: transition.attempt,
    transitionResult: transition,
  });
}

function incrementallyProtectedLifecycle(): ProtectionAcknowledgementAppliedResult {
  const first = protectedLifecycle("2.75");
  const additionalFill = createFillEvent({
    executionAttemptId: first.executionAttempt.executionAttemptId,
    adapterOrderId: first.executionAttempt.adapterOrderId!,
    fillId: "entry-fill-2",
    filledQuantity: "1.25",
    fillPrice: "100",
    filledAt: 1_500,
  });
  const filled = applyEntryFill(first.executionAttempt, additionalFill);
  if (filled.status !== "EXECUTION_ATTEMPT_UPDATED") throw new Error("incremental fill failed");
  const requested = requestProtection(filled.attempt);
  if (requested.status !== "PROTECTION_REQUEST_READY") throw new Error("incremental protection failed");
  const acknowledgement = createProtectionAcknowledgement({
    executionAttemptId: requested.request.executionAttemptId,
    protectionRequestId: requested.request.protectionRequestId,
    idempotencyKey: requested.request.idempotencyKey,
    protectedQuantity: requested.request.targetCumulativeProtectedQuantity,
    acknowledgedAt: 1_700,
  });
  const transition = acknowledgeProtection(requested.attempt, acknowledgement);
  if (transition.status !== "EXECUTION_ATTEMPT_UPDATED") throw new Error("incremental acknowledgement failed");
  return Object.freeze({
    status: "PROTECTION_ACKNOWLEDGEMENT_APPLIED",
    preparationCycleId: "preparation-2",
    protectionAsOf: unixMs(1_600),
    observationAsOf: unixMs(1_700),
    acknowledgement,
    executionAttempt: transition.attempt,
    transitionResult: transition,
  });
}

function exitFill(
  lifecycle: ProtectionAcknowledgementAppliedResult,
  values: Partial<ExitFillEvent> = {},
): ExitFillEvent {
  return createExitFillEvent({
    executionAttemptId: lifecycle.executionAttempt.executionAttemptId,
    protectionRequestId: lifecycle.executionAttempt.acknowledgedProtections[0]!.request.protectionRequestId,
    exitSide: lifecycle.executionAttempt.exitSide,
    exitLeg: "PROTECTIVE_STOP",
    fillId: "exit-fill-1",
    filledQuantity: "2.5",
    fillPrice: "90",
    filledAt: 1_500,
    ...values,
  });
}

function apply(
  lifecycle: ProtectionAcknowledgementAppliedResult,
  fill: ExitFillEvent | undefined = exitFill(lifecycle),
  current: ExecutionAttempt | undefined = lifecycle.executionAttempt,
  observationAsOf: number | undefined = 1_500,
) {
  return applyRealtimeExecutionExitFill({
    protectionLifecycle: lifecycle,
    executionAttempt: current,
    exitFill: fill,
    observationAsOf,
  });
}

describe("Task 024 gating and authoritative evidence", () => {
  it.each(["NO_PROTECTION_LIFECYCLE", "PROTECTION_LIFECYCLE_REJECTED"] as const)(
    "%s is non-actionable without exit fill, attempt, or observation context",
    (status) => {
      const upstream = Object.freeze({
        status,
        preparationCycleId: "preparation-1",
        ...(status === "PROTECTION_LIFECYCLE_REJECTED" ? { reason: "CURRENT_ATTEMPT_MISMATCH" } : {
          upstreamStatus: "NO_PROTECTION_ACTION",
        }),
      }) as RealtimeExecutionProtectionLifecycleResult;
      const output = applyRealtimeExecutionExitFill({ protectionLifecycle: upstream });
      expect(output).toEqual({
        status: "NO_EXIT_FILL_PROCESSING",
        preparationCycleId: "preparation-1",
        upstreamStatus: status,
      });
      expect(Object.isFrozen(output)).toBe(true);
    },
  );

  it("does not let a protected-looking attempt bypass a rejected Task 024 outer status", () => {
    const lifecycle = protectedLifecycle();
    const rejected = Object.freeze({
      status: "PROTECTION_LIFECYCLE_REJECTED",
      reason: "CURRENT_ATTEMPT_MISMATCH",
      preparationCycleId: lifecycle.preparationCycleId,
      executionAttempt: lifecycle.executionAttempt,
    }) as const;
    expect(applyRealtimeExecutionExitFill({
      protectionLifecycle: rejected,
      executionAttempt: lifecycle.executionAttempt,
      exitFill: exitFill(lifecycle),
      observationAsOf: 1_500,
    })).toMatchObject({ status: "NO_EXIT_FILL_PROCESSING" });
  });

  it("requires an explicit exit fill and never treats protection acknowledgement as an exit", () => {
    const lifecycle = protectedLifecycle();
    expect(applyRealtimeExecutionExitFill({
      protectionLifecycle: lifecycle,
      executionAttempt: lifecycle.executionAttempt,
      observationAsOf: 1_500,
    })).toMatchObject({
      status: "EXIT_FILL_REJECTED",
      reason: "EXIT_FILL_MISSING",
    });
    expect(lifecycle.executionAttempt.exitedQuantity).toBe("0");
  });

  it("rejects malformed exit input and an entry FillEvent masquerading as an exit", () => {
    const lifecycle = protectedLifecycle();
    const malformed = Object.freeze({ ...exitFill(lifecycle), filledQuantity: "not-decimal" });
    const entry = createFillEvent({
      executionAttemptId: lifecycle.executionAttempt.executionAttemptId,
      adapterOrderId: lifecycle.executionAttempt.adapterOrderId!,
      fillId: "entry-disguised",
      filledQuantity: "1",
      fillPrice: "90",
      filledAt: 1_500,
    });
    expect(apply(lifecycle, malformed as ExitFillEvent)).toMatchObject({ reason: "EXIT_FILL_EVENT_NOT_NORMALIZED" });
    expect(apply(lifecycle, entry as unknown as ExitFillEvent)).toMatchObject({
      reason: "EXIT_FILL_EVENT_NOT_NORMALIZED",
    });
  });
});

describe("observation boundary and domain chronology", () => {
  it.each([undefined, -1, 1.5, Number.NaN])("rejects invalid observationAsOf %s", (value) => {
    const lifecycle = protectedLifecycle();
    expect(applyRealtimeExecutionExitFill({
      protectionLifecycle: lifecycle,
      executionAttempt: lifecycle.executionAttempt,
      exitFill: exitFill(lifecycle),
      observationAsOf: value,
    })).toMatchObject({
      reason: "INVALID_OBSERVATION_TIME",
    });
  });

  it("rejects a future exit before transition and accepts exact equality", () => {
    const lifecycle = protectedLifecycle();
    const fill = exitFill(lifecycle, { filledAt: unixMs(1_501) });
    expect(apply(lifecycle, fill, lifecycle.executionAttempt, 1_500)).toMatchObject({
      reason: "EXIT_FILL_OBSERVED_IN_FUTURE",
    });
    expect(apply(lifecycle, fill, lifecycle.executionAttempt, 1_501)).toMatchObject({
      status: "EXIT_FILL_APPLIED",
    });
    expect(lifecycle.executionAttempt.exitedQuantity).toBe("0");
  });

  it("delegates backward chronology, accepts equality, and preserves caller order without sorting", () => {
    const lifecycle = protectedLifecycle();
    expect(apply(lifecycle, exitFill(lifecycle, { filledAt: unixMs(1_399) }), lifecycle.executionAttempt, 1_500))
      .toMatchObject({ reason: "OUT_OF_ORDER_EXECUTION_EVENT", transitionResult: { reason: "OUT_OF_ORDER_EXECUTION_EVENT" } });
    const equal = apply(lifecycle, exitFill(lifecycle, { filledAt: unixMs(1_400) }), lifecycle.executionAttempt, 1_400);
    expect(equal).toMatchObject({ status: "EXIT_FILL_APPLIED" });
    if (equal.status !== "EXIT_FILL_APPLIED") throw new Error("equal chronology failed");
    const second = apply(lifecycle, exitFill(lifecycle, {
      fillId: "exit-fill-earlier-id",
      filledQuantity: positiveDecimalString("1"),
      filledAt: unixMs(1_500),
    }), equal.executionAttempt, 1_500);
    if (second.status !== "EXIT_FILL_APPLIED") throw new Error("second exit failed");
    expect(second.executionAttempt.processedExitFills.map(({ fillId }) => fillId))
      .toEqual(["exit-fill-1", "exit-fill-earlier-id"]);
  });
});

describe("current-attempt lineage and continuation", () => {
  it.each([
    ["execution attempt", { executionAttemptId: "other-attempt" }],
    ["execution plan", { executionPlanId: "other-plan" }],
    ["instrument", { instrumentId: createInstrumentId({ venue: "TEST", venueSymbol: "XYZ", instrumentKind: "CFD" }) }],
    ["entry side", { entrySide: "SELL" as const }],
    ["exit side", { exitSide: "BUY" as const }],
    ["quantity", { quantity: positiveDecimalString("11") }],
    ["entry price", { entryPrice: positiveDecimalString("101") }],
    ["stop price", { stopTriggerPrice: positiveDecimalString("89") }],
    ["target price", { targetPrice: positiveDecimalString("131") }],
    ["approved risk", { approvedRiskAmount: positiveDecimalString("99") }],
    ["actual risk", { actualRiskAmount: positiveDecimalString("99") }],
  ])("rejects changed immutable %s identity", (_name, patch) => {
    const lifecycle = protectedLifecycle();
    const changed = Object.freeze({ ...lifecycle.executionAttempt, ...patch }) as ExecutionAttempt;
    expect(apply(lifecycle, exitFill(lifecycle), changed)).toMatchObject({ reason: "CURRENT_ATTEMPT_MISMATCH" });
  });

  it("rejects removed or changed Task 024 entry-fill history", () => {
    const lifecycle = protectedLifecycle();
    const removed = Object.freeze({ ...lifecycle.executionAttempt, processedFills: Object.freeze([]) }) as ExecutionAttempt;
    const changedFill = Object.freeze({
      ...lifecycle.executionAttempt.processedFills[0]!,
      fillPrice: positiveDecimalString("101"),
    });
    const changed = Object.freeze({
      ...lifecycle.executionAttempt,
      processedFills: Object.freeze([changedFill]),
    }) as ExecutionAttempt;
    expect(apply(lifecycle, exitFill(lifecycle), removed)).toMatchObject({ reason: "CURRENT_ATTEMPT_MISMATCH" });
    expect(apply(lifecycle, exitFill(lifecycle), changed)).toMatchObject({ reason: "CURRENT_ATTEMPT_MISMATCH" });
  });

  it("rejects removed or modified acknowledged-protection provenance", () => {
    const lifecycle = protectedLifecycle();
    const removed = Object.freeze({
      ...lifecycle.executionAttempt,
      acknowledgedProtections: Object.freeze([]),
    }) as ExecutionAttempt;
    const record = lifecycle.executionAttempt.acknowledgedProtections[0]!;
    const modified = Object.freeze({
      ...lifecycle.executionAttempt,
      acknowledgedProtections: Object.freeze([Object.freeze({
        ...record,
        acknowledgement: Object.freeze({ ...record.acknowledgement, protectionRequestId: "changed" }),
      })]),
    }) as ExecutionAttempt;
    expect(apply(lifecycle, exitFill(lifecycle), removed)).toMatchObject({ reason: "CURRENT_ATTEMPT_MISMATCH" });
    expect(apply(lifecycle, exitFill(lifecycle), modified)).toMatchObject({ reason: "CURRENT_ATTEMPT_MISMATCH" });
  });

  it("accepts replay-verifiable prior exits but rejects removal, mutation, and quantity regression", () => {
    const lifecycle = protectedLifecycle();
    const first = apply(lifecycle);
    if (first.status !== "EXIT_FILL_APPLIED") throw new Error("first exit failed");
    expect(apply(lifecycle, exitFill(lifecycle, {
      fillId: "exit-fill-2",
      filledAt: unixMs(1_600),
    }), first.executionAttempt, 1_600)).toMatchObject({ status: "EXIT_FILL_APPLIED" });

    const removed = Object.freeze({
      ...first.executionAttempt,
      processedExitFills: Object.freeze([]),
    }) as ExecutionAttempt;
    const mutated = Object.freeze({
      ...first.executionAttempt,
      processedExitFills: Object.freeze([Object.freeze({
        ...first.executionAttempt.processedExitFills[0]!,
        fillPrice: positiveDecimalString("91"),
      })]),
    }) as ExecutionAttempt;
    const regressed = Object.freeze({
      ...first.executionAttempt,
      exitedQuantity: "0" as ExecutionAttempt["exitedQuantity"],
    }) as ExecutionAttempt;
    expect(apply(lifecycle, exitFill(lifecycle), removed)).toMatchObject({ reason: "CURRENT_ATTEMPT_MISMATCH" });
    expect(apply(lifecycle, exitFill(lifecycle), mutated)).toMatchObject({ reason: "DUPLICATE_EXIT_FILL_CONFLICT" });
    expect(apply(lifecycle, exitFill(lifecycle), regressed)).toMatchObject({ reason: "CURRENT_ATTEMPT_MISMATCH" });
  });
});

describe("explicit leg identity and lifecycle delegation", () => {
  it.each([
    ["PROTECTIVE_STOP", "130"],
    ["PROFIT_TARGET", "90"],
  ] as const)("preserves explicit %s at a price resembling the opposite leg", (exitLeg, fillPrice) => {
    const lifecycle = protectedLifecycle();
    const result = apply(lifecycle, exitFill(lifecycle, {
      exitLeg,
      fillPrice: positiveDecimalString(fillPrice),
    }));
    expect(result).toMatchObject({ status: "EXIT_FILL_APPLIED", exitFill: { exitLeg, fillPrice } });
  });

  it("accumulates 2.5 + 3.25 + 4.25 exactly and preserves partial/terminal states", () => {
    const lifecycle = protectedLifecycle();
    const first = apply(lifecycle, exitFill(lifecycle, { filledQuantity: positiveDecimalString("2.5") }));
    if (first.status !== "EXIT_FILL_APPLIED") throw new Error("first exit failed");
    expect(first.executionAttempt).toMatchObject({ exitedQuantity: "2.5", state: "EXIT_PARTIALLY_FILLED" });
    const second = apply(lifecycle, exitFill(lifecycle, {
      fillId: "exit-fill-2",
      filledQuantity: positiveDecimalString("3.25"),
      filledAt: unixMs(1_600),
    }), first.executionAttempt, 1_600);
    if (second.status !== "EXIT_FILL_APPLIED") throw new Error("second exit failed");
    expect(second.executionAttempt).toMatchObject({ exitedQuantity: "5.75", state: "EXIT_PARTIALLY_FILLED" });
    const third = apply(lifecycle, exitFill(lifecycle, {
      fillId: "exit-fill-3",
      filledQuantity: positiveDecimalString("4.25"),
      exitLeg: "PROFIT_TARGET",
      filledAt: unixMs(1_700),
    }), second.executionAttempt, 1_700);
    expect(third).toMatchObject({
      status: "EXIT_FILL_APPLIED",
      executionAttempt: { exitedQuantity: "10", state: "EXIT_FILLED" },
    });
  });

  it("keeps a full-current-exposure early exit non-terminal while entry remains WORKING", () => {
    const lifecycle = protectedLifecycle("2.75");
    const result = apply(lifecycle, exitFill(lifecycle, { filledQuantity: positiveDecimalString("2.75") }));
    expect(result).toMatchObject({
      status: "EXIT_FILL_APPLIED",
      executionAttempt: {
        entryOrderStatus: "WORKING",
        exitedQuantity: "2.75",
        state: "EXIT_PARTIALLY_FILLED",
      },
    });
  });

  it.each([
    ["unknown provenance", { protectionRequestId: "unknown-request" }, "EXIT_PROTECTION_REQUEST_NOT_ACKNOWLEDGED"],
    ["wrong attempt", { executionAttemptId: "wrong-attempt" }, "EVENT_ATTEMPT_MISMATCH"],
    ["wrong exit side", { exitSide: "BUY" as const }, "EXIT_SIDE_MISMATCH"],
    ["over exit", { filledQuantity: positiveDecimalString("10.01") }, "OVER_EXIT_DETECTED"],
  ])("delegates %s rejection", (_name, patch, reason) => {
    const lifecycle = protectedLifecycle();
    expect(apply(lifecycle, exitFill(lifecycle, patch))).toMatchObject({ reason, transitionResult: { reason } });
    expect(lifecycle.executionAttempt.exitedQuantity).toBe("0");
  });

  it("delegates the older protection request coverage ceiling", () => {
    const lifecycle = incrementallyProtectedLifecycle();
    const olderRequestId = lifecycle.executionAttempt.acknowledgedProtections[0]!.request.protectionRequestId;
    const first = apply(lifecycle, exitFill(lifecycle, {
      protectionRequestId: olderRequestId,
      filledQuantity: positiveDecimalString("2"),
      filledAt: unixMs(1_800),
    }), lifecycle.executionAttempt, 1_800);
    if (first.status !== "EXIT_FILL_APPLIED") throw new Error("first exit failed");
    expect(apply(lifecycle, exitFill(lifecycle, {
      protectionRequestId: olderRequestId,
      fillId: "exit-fill-2",
      filledQuantity: positiveDecimalString("1"),
      filledAt: unixMs(1_900),
    }), first.executionAttempt, 1_900)).toMatchObject({ reason: "EXIT_COVERAGE_EXCEEDED" });
  });
});

describe("duplicates, races, modes, and purity", () => {
  it("maps an exact replay to DUPLICATE_EXIT_FILL without changing exited quantity", () => {
    const lifecycle = protectedLifecycle();
    const fill = exitFill(lifecycle);
    const first = apply(lifecycle, fill);
    if (first.status !== "EXIT_FILL_APPLIED") throw new Error("first exit failed");
    const duplicate = apply(lifecycle, fill, first.executionAttempt);
    expect(duplicate).toMatchObject({ status: "DUPLICATE_EXIT_FILL", executionAttempt: { exitedQuantity: "2.5" } });
    if (duplicate.status !== "DUPLICATE_EXIT_FILL") throw new Error("duplicate mapping failed");
    expect(duplicate.executionAttempt).toBe(first.executionAttempt);
  });

  it.each([
    ["quantity", { filledQuantity: positiveDecimalString("2.6") }],
    ["price", { fillPrice: positiveDecimalString("91") }],
    ["leg", { exitLeg: "PROFIT_TARGET" as const }],
  ])("rejects same fillId with changed %s", (_name, patch) => {
    const lifecycle = protectedLifecycle();
    const first = apply(lifecycle);
    if (first.status !== "EXIT_FILL_APPLIED") throw new Error("first exit failed");
    expect(apply(lifecycle, exitFill(lifecycle, patch), first.executionAttempt)).toMatchObject({
      reason: "DUPLICATE_EXIT_FILL_CONFLICT",
    });
  });

  it.each([
    ["PROTECTIVE_STOP", "PROFIT_TARGET"],
    ["PROFIT_TARGET", "PROTECTIVE_STOP"],
  ] as const)("rejects a later %s/%s race after the first leg fully exits", (firstLeg, secondLeg) => {
    const lifecycle = protectedLifecycle();
    const first = apply(lifecycle, exitFill(lifecycle, {
      exitLeg: firstLeg,
      filledQuantity: positiveDecimalString("10"),
    }));
    if (first.status !== "EXIT_FILL_APPLIED") throw new Error("full exit failed");
    expect(apply(lifecycle, exitFill(lifecycle, {
      exitLeg: secondLeg,
      fillId: "race-fill-2",
      filledQuantity: positiveDecimalString("1"),
      filledAt: unixMs(1_600),
    }), first.executionAttempt, 1_600)).toMatchObject({ reason: "OVER_EXIT_DETECTED" });
    expect(first.executionAttempt.acknowledgedProtections).toEqual(lifecycle.executionAttempt.acknowledgedProtections);
  });

  it.each([
    ["MANAGED_PROTECTION", managedCapabilities],
    ["NATIVE_BRACKET", nativeCapabilities],
  ] as const)("uses the same transition for %s", (mode, capabilities) => {
    const lifecycle = protectedLifecycle("10", capabilities);
    expect(apply(lifecycle)).toMatchObject({
      status: "EXIT_FILL_APPLIED",
      executionAttempt: { protectionMode: mode, exitedQuantity: "2.5" },
    });
  });

  it("is immutable, atomic, deterministic, and stateless", () => {
    const lifecycle = protectedLifecycle();
    const fill = exitFill(lifecycle);
    const input = Object.freeze({
      protectionLifecycle: lifecycle,
      executionAttempt: lifecycle.executionAttempt,
      exitFill: fill,
      observationAsOf: 1_500,
    } satisfies RealtimeExecutionExitFillInput);
    const lifecycleBefore = JSON.stringify(lifecycle);
    const attemptBefore = JSON.stringify(lifecycle.executionAttempt);
    const fillBefore = JSON.stringify(fill);
    const first = applyRealtimeExecutionExitFill(input);
    const second = applyRealtimeExecutionExitFill(input);
    const third = new RealtimeExecutionExitFillEngine().apply(input);
    expect(second).toEqual(first);
    expect(third).toEqual(first);
    expect(JSON.stringify(lifecycle)).toBe(lifecycleBefore);
    expect(JSON.stringify(lifecycle.executionAttempt)).toBe(attemptBefore);
    expect(JSON.stringify(fill)).toBe(fillBefore);
    expect(Object.isFrozen(first)).toBe(true);
    if (first.status !== "EXIT_FILL_APPLIED") throw new Error("expected applied exit");
    expect(Object.isFrozen(first.executionAttempt)).toBe(true);
    expect(first.executionAttempt).not.toBe(lifecycle.executionAttempt);
    expect("position" in first).toBe(false);
    expect("pnl" in first).toBe(false);
    expect(RealtimeExecutionExitFillEngine.length).toBe(0);
  });
});
