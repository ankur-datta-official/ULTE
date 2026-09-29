import { describe, expect, it } from "vitest";
import {
  acknowledgeEntrySubmission,
  acknowledgeProtection,
  applyEntryFill,
  applyExitFill,
  createAdapterCapabilities,
  createExecutionAttempt,
  createExitFillEvent,
  createFillEvent,
  requestEntrySubmission,
  requestProtection,
  type ExecutionAttempt,
  type ExecutionUpdateResult,
  type ExitFillEvent,
  type FillEvent,
  type ProtectionRequest,
} from "@ulte/execution-engine";
import type { ReadyExecutionPlan } from "@ulte/execution-preparation-engine";
import {
  currencyCode, createInstrumentId, positiveDecimalString, unixMs } from "@ulte/instrument-model";
import type {
  ExitFillAppliedResult,
  RealtimeExecutionExitFillResult,
} from "@ulte/realtime-execution-exit-fill-engine";
import type {
  FillAppliedResult,
  RealtimeExecutionFillResult,
} from "@ulte/realtime-execution-fill-engine";
import {
  projectRealtimePositionExposure,
  RealtimePositionExposureEngine,
} from "./index.js";

const instrument = createInstrumentId({ venue: "TEST", venueSymbol: "ABC", instrumentKind: "CFD" });
const capabilities = createAdapterCapabilities({
  supportsClientIdempotency: false,
  supportsCloseOnlyExit: true,
  supportsNativeBracketProtection: false,
  supportsProtectionModification: true,
  supportsOrderCancellation: true,
  supportsPartialFillReporting: true,
});

function plan(entrySide: "BUY" | "SELL" = "BUY"): ReadyExecutionPlan {
  const exitSide = entrySide === "BUY" ? "SELL" : "BUY";
  const quantity = positiveDecimalString("10");
  return Object.freeze({
    status: "EXECUTION_PLAN_READY",
    schemaVersion: "EXECUTION_PLAN_V2",
    executionPlanId: `plan-${entrySide}`,
    tradeIntentId: `intent-${entrySide}`,
    candidateId: `candidate-${entrySide}`,
    instrumentId: instrument,
    intentAsOf: unixMs(800),
    marketSnapshotAsOf: unixMs(850),
    preparedAsOf: unixMs(900),
    direction: entrySide === "BUY" ? "UP" : "DOWN",
    entrySide,
    exitSide,
    quantity,
    quantityUnit: "contracts", accountCurrency: currencyCode("USD"),
    entryInstruction: Object.freeze({
      kind: "ENTRY_LIMIT", side: entrySide, price: positiveDecimalString("100"), quantity, positionEffect: "OPEN",
    }),
    protectiveStopInstruction: Object.freeze({
      kind: "PROTECTIVE_STOP_TRIGGER", side: exitSide,
      triggerPrice: positiveDecimalString(entrySide === "BUY" ? "90" : "110"),
      quantity, positionEffect: "CLOSE",
    }),
    profitTargetInstruction: Object.freeze({
      kind: "PROFIT_TARGET_LIMIT", side: exitSide,
      price: positiveDecimalString(entrySide === "BUY" ? "130" : "70"),
      quantity, positionEffect: "CLOSE",
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
  });
}

function working(entrySide: "BUY" | "SELL" = "BUY"): ExecutionAttempt {
  const created = createExecutionAttempt(plan(entrySide));
  if (created.status !== "EXECUTION_ATTEMPT_READY") throw new Error("attempt creation failed");
  const submitted = requestEntrySubmission(created, capabilities);
  if (submitted.status !== "ENTRY_SUBMISSION_READY") throw new Error("entry request failed");
  const acknowledged = acknowledgeEntrySubmission(submitted.attempt, {
    executionAttemptId: created.executionAttemptId,
    idempotencyKey: submitted.request.idempotencyKey,
    adapterOrderId: "ORDER-1",
    acknowledgedAt: 1_000,
  });
  if (acknowledged.status !== "EXECUTION_ATTEMPT_UPDATED") throw new Error("entry acknowledgement failed");
  return acknowledged.attempt;
}

function applyEntry(attempt: ExecutionAttempt, fillId: string, quantity: string, at: number) {
  const fill = createFillEvent({
    executionAttemptId: attempt.executionAttemptId,
    adapterOrderId: "ORDER-1",
    fillId,
    filledQuantity: quantity,
    fillPrice: "100",
    filledAt: at,
  });
  const transition = applyEntryFill(attempt, fill);
  if (transition.status !== "EXECUTION_ATTEMPT_UPDATED") throw new Error("entry fill failed");
  return { attempt: transition.attempt, fill, transition };
}

function protect(attempt: ExecutionAttempt, at: number): { attempt: ExecutionAttempt; request: ProtectionRequest } {
  const requested = requestProtection(attempt);
  if (requested.status !== "PROTECTION_REQUEST_READY") throw new Error("protection request failed");
  const acknowledged = acknowledgeProtection(requested.attempt, {
    executionAttemptId: attempt.executionAttemptId,
    protectionRequestId: requested.request.protectionRequestId,
    idempotencyKey: requested.request.idempotencyKey,
    protectedQuantity: requested.request.targetCumulativeProtectedQuantity,
    acknowledgedAt: at,
  });
  if (acknowledged.status !== "EXECUTION_ATTEMPT_UPDATED") throw new Error("protection acknowledgement failed");
  return { attempt: acknowledged.attempt, request: requested.request };
}

function applyExit(
  attempt: ExecutionAttempt,
  request: ProtectionRequest,
  fillId: string,
  quantity: string,
  at: number,
) {
  const exitFill = createExitFillEvent({
    executionAttemptId: attempt.executionAttemptId,
    protectionRequestId: request.protectionRequestId,
    exitSide: attempt.exitSide,
    exitLeg: "PROFIT_TARGET",
    fillId,
    filledQuantity: quantity,
    fillPrice: "130",
    filledAt: at,
  });
  const transition = applyExitFill(attempt, exitFill);
  if (transition.status !== "EXECUTION_ATTEMPT_UPDATED") throw new Error("exit fill failed");
  return { attempt: transition.attempt, exitFill, transition };
}

function entryResult(
  attempt: ExecutionAttempt,
  fill: FillEvent,
  transition: ExecutionUpdateResult,
  status: FillAppliedResult["status"] = "FILL_APPLIED",
): FillAppliedResult {
  return Object.freeze({
    status,
    preparationCycleId: "cycle-1",
    submissionAsOf: unixMs(999),
    observationAsOf: fill.filledAt,
    fill,
    executionAttempt: attempt,
    transitionResult: transition,
  });
}

function exitResult(
  attempt: ExecutionAttempt,
  exitFill: ExitFillEvent,
  transition: ExecutionUpdateResult,
  status: ExitFillAppliedResult["status"] = "EXIT_FILL_APPLIED",
): ExitFillAppliedResult {
  return Object.freeze({
    status,
    preparationCycleId: "cycle-1",
    protectionAsOf: unixMs(1_002),
    observationAsOf: exitFill.filledAt,
    exitFill,
    executionAttempt: attempt,
    transitionResult: transition,
  });
}

function projectEntry(result: RealtimeExecutionFillResult) {
  return projectRealtimePositionExposure({ sourceKind: "ENTRY_FILL", fillLifecycle: result });
}

function projectExit(result: RealtimeExecutionExitFillResult) {
  return projectRealtimePositionExposure({ sourceKind: "EXIT_FILL", exitFillLifecycle: result });
}

describe("realtime position exposure projection", () => {
  it("gates entry results by outer status and cannot be bypassed by an embedded attempt", () => {
    const applied = applyEntry(working(), "F1", "2.75", 1_001);
    const rejected: RealtimeExecutionFillResult = Object.freeze({
      status: "FILL_REJECTED",
      reason: "OVERFILL_DETECTED",
      preparationCycleId: "cycle-1",
      executionAttempt: applied.attempt,
    });
    const noProcessing: RealtimeExecutionFillResult = Object.freeze({
      status: "NO_FILL_PROCESSING",
      preparationCycleId: "cycle-1",
      upstreamStatus: "NO_SUBMISSION",
    });
    expect(projectEntry(rejected)).toEqual({
      status: "NO_POSITION_PROJECTION", sourceKind: "ENTRY_FILL", upstreamStatus: "FILL_REJECTED",
    });
    expect(projectEntry(noProcessing)).toEqual({
      status: "NO_POSITION_PROJECTION", sourceKind: "ENTRY_FILL", upstreamStatus: "NO_FILL_PROCESSING",
    });
  });

  it("gates exit rejected/no-processing results without inspecting attempt-looking data", () => {
    const applied = applyEntry(working(), "F1", "2.75", 1_001);
    const rejected: RealtimeExecutionExitFillResult = Object.freeze({
      status: "EXIT_FILL_REJECTED",
      reason: "OVER_EXIT_DETECTED",
      preparationCycleId: "cycle-1",
      executionAttempt: applied.attempt,
    });
    const noProcessing: RealtimeExecutionExitFillResult = Object.freeze({
      status: "NO_EXIT_FILL_PROCESSING",
      preparationCycleId: "cycle-1",
      upstreamStatus: "NO_PROTECTION_LIFECYCLE",
    });
    expect(projectExit(rejected)).toEqual({
      status: "NO_POSITION_PROJECTION", sourceKind: "EXIT_FILL", upstreamStatus: "EXIT_FILL_REJECTED",
    });
    expect(projectExit(noProcessing)).toEqual({
      status: "NO_POSITION_PROJECTION", sourceKind: "EXIT_FILL", upstreamStatus: "NO_EXIT_FILL_PROCESSING",
    });
  });

  it.each([
    ["BUY", "LONG"],
    ["SELL", "SHORT"],
  ] as const)("projects actionable %s entry fill as %s OPEN exposure", (side, direction) => {
    const applied = applyEntry(working(side), "F1", "2.75", 1_001);
    const result = projectEntry(entryResult(applied.attempt, applied.fill, applied.transition));
    expect(result).toMatchObject({
      status: "POSITION_EXPOSURE_PROJECTED",
      sourceKind: "ENTRY_FILL",
      upstreamStatus: "FILL_APPLIED",
      positionExposure: {
        direction,
        filledEntryQuantity: "2.75",
        exitedQuantity: "0",
        openQuantity: "2.75",
        exposureState: "OPEN",
        executionAsOf: 1_001,
      },
    });
  });

  it("projects early exit, later entry reopening, and final full-fill exit through the domain", () => {
    const firstEntry = applyEntry(working(), "F1", "2.75", 1_001);
    const firstProtection = protect(firstEntry.attempt, 1_002);
    const earlyExit = applyExit(firstProtection.attempt, firstProtection.request, "X1", "2.75", 1_003);
    const flat = projectExit(exitResult(earlyExit.attempt, earlyExit.exitFill, earlyExit.transition));
    expect(flat).toMatchObject({
      status: "POSITION_EXPOSURE_PROJECTED",
      positionExposure: {
        openQuantity: "0", entryCanIncreaseExposure: true, exposureState: "FLAT_ENTRY_ACTIVE",
      },
    });

    const secondEntry = applyEntry(earlyExit.attempt, "F2", "1.25", 1_004);
    const reopened = projectEntry(entryResult(secondEntry.attempt, secondEntry.fill, secondEntry.transition));
    expect(reopened).toMatchObject({
      status: "POSITION_EXPOSURE_PROJECTED",
      positionExposure: {
        filledEntryQuantity: "4", exitedQuantity: "2.75", openQuantity: "1.25",
        exposureState: "PARTIALLY_EXITED",
      },
    });

    const secondProtection = protect(secondEntry.attempt, 1_005);
    const thirdEntry = applyEntry(secondProtection.attempt, "F3", "6", 1_006);
    const thirdProtection = protect(thirdEntry.attempt, 1_007);
    const secondExit = applyExit(thirdProtection.attempt, secondProtection.request, "X2", "1.25", 1_008);
    const finalExit = applyExit(secondExit.attempt, thirdProtection.request, "X3", "6", 1_009);
    const closed = projectExit(exitResult(finalExit.attempt, finalExit.exitFill, finalExit.transition));
    expect(closed).toMatchObject({
      status: "POSITION_EXPOSURE_PROJECTED",
      positionExposure: {
        filledEntryQuantity: "10", exitedQuantity: "10", openQuantity: "0",
        entryOrderStatus: "FILLED", executionState: "EXIT_FILLED",
        entryCanIncreaseExposure: false, exposureState: "CLOSED", executionAsOf: 1_009,
      },
    });
  });

  it("projects exact entry and exit duplicates identically without local memory", () => {
    const firstEntry = applyEntry(working(), "F1", "2.75", 1_001);
    const entryApplied = entryResult(firstEntry.attempt, firstEntry.fill, firstEntry.transition);
    const entryDuplicateTransition = applyEntryFill(firstEntry.attempt, firstEntry.fill);
    if (entryDuplicateTransition.status !== "DUPLICATE_EVENT_IGNORED") throw new Error("entry duplicate failed");
    const entryDuplicate = entryResult(
      entryDuplicateTransition.attempt,
      firstEntry.fill,
      entryDuplicateTransition,
      "DUPLICATE_FILL",
    );
    const appliedEntryProjection = projectEntry(entryApplied);
    const duplicateEntryProjection = projectEntry(entryDuplicate);
    expect(appliedEntryProjection.status).toBe("POSITION_EXPOSURE_PROJECTED");
    expect(duplicateEntryProjection.status).toBe("POSITION_EXPOSURE_PROJECTED");
    if (appliedEntryProjection.status !== "POSITION_EXPOSURE_PROJECTED"
      || duplicateEntryProjection.status !== "POSITION_EXPOSURE_PROJECTED") return;
    expect(duplicateEntryProjection.positionExposure).toEqual(appliedEntryProjection.positionExposure);

    const protection = protect(firstEntry.attempt, 1_002);
    const firstExit = applyExit(protection.attempt, protection.request, "X1", "2.75", 1_003);
    const exitApplied = exitResult(firstExit.attempt, firstExit.exitFill, firstExit.transition);
    const exitDuplicateTransition = applyExitFill(firstExit.attempt, firstExit.exitFill);
    if (exitDuplicateTransition.status !== "DUPLICATE_EVENT_IGNORED") throw new Error("exit duplicate failed");
    const exitDuplicate = exitResult(
      exitDuplicateTransition.attempt,
      firstExit.exitFill,
      exitDuplicateTransition,
      "DUPLICATE_EXIT_FILL",
    );
    const appliedExitProjection = projectExit(exitApplied);
    const duplicateExitProjection = projectExit(exitDuplicate);
    expect(appliedExitProjection.status).toBe("POSITION_EXPOSURE_PROJECTED");
    expect(duplicateExitProjection.status).toBe("POSITION_EXPOSURE_PROJECTED");
    if (appliedExitProjection.status !== "POSITION_EXPOSURE_PROJECTED"
      || duplicateExitProjection.status !== "POSITION_EXPOSURE_PROJECTED") return;
    expect(duplicateExitProjection.positionExposure).toEqual(appliedExitProjection.positionExposure);
    expect(new RealtimePositionExposureEngine().project({
      sourceKind: "EXIT_FILL", exitFillLifecycle: exitDuplicate,
    })).toEqual(new RealtimePositionExposureEngine().project({
      sourceKind: "EXIT_FILL", exitFillLifecycle: exitDuplicate,
    }));
  });

  it("preserves position-engine rejection and keeps it distinct from upstream rejection", () => {
    const applied = applyEntry(working(), "F1", "2.75", 1_001);
    const impossible = Object.freeze({ ...applied.attempt, exitSide: applied.attempt.entrySide });
    const result = projectEntry(entryResult(impossible, applied.fill, applied.transition));
    expect(result).toMatchObject({
      status: "POSITION_EXPOSURE_REJECTED",
      sourceKind: "ENTRY_FILL",
      upstreamStatus: "FILL_APPLIED",
      reason: "EXECUTION_SIDE_MISMATCH",
      positionProjection: { status: "POSITION_EXPOSURE_REJECTED", reason: "EXECUTION_SIDE_MISMATCH" },
    });
  });

  it("is immutable, deterministic, source-preserving, and exposes no override inputs", () => {
    const applied = applyEntry(working(), "F1", "2.75", 1_001);
    const upstream = entryResult(applied.attempt, applied.fill, applied.transition);
    const upstreamBefore = JSON.stringify(upstream);
    const attemptBefore = JSON.stringify(upstream.executionAttempt);
    const first = projectEntry(upstream);
    const second = projectEntry(upstream);
    expect(first).toEqual(second);
    expect(JSON.stringify(upstream)).toBe(upstreamBefore);
    expect(JSON.stringify(upstream.executionAttempt)).toBe(attemptBefore);
    expect(Object.isFrozen(first)).toBe(true);
    if (first.status !== "POSITION_EXPOSURE_PROJECTED") return;
    expect(Object.isFrozen(first.positionExposure)).toBe(true);
    expect(Object.isFrozen(first.positionProjection)).toBe(true);
    expect(Object.keys({ sourceKind: "ENTRY_FILL", fillLifecycle: upstream }).sort())
      .toEqual(["fillLifecycle", "sourceKind"]);

    const protection = protect(applied.attempt, 1_002);
    const exited = applyExit(protection.attempt, protection.request, "X1", "1", 1_003);
    const exitUpstream = exitResult(exited.attempt, exited.exitFill, exited.transition);
    const exitBefore = JSON.stringify(exitUpstream);
    const exitAttemptBefore = JSON.stringify(exitUpstream.executionAttempt);
    const exitProjection = projectExit(exitUpstream);
    expect(JSON.stringify(exitUpstream)).toBe(exitBefore);
    expect(JSON.stringify(exitUpstream.executionAttempt)).toBe(exitAttemptBefore);
    expect(Object.isFrozen(exitProjection)).toBe(true);
    expect(Object.keys({ sourceKind: "EXIT_FILL", exitFillLifecycle: exitUpstream }).sort())
      .toEqual(["exitFillLifecycle", "sourceKind"]);
  });
});
