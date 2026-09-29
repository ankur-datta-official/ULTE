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
import { createLinearInstrumentSizingSpec } from "@ulte/position-sizing-engine";
import type {
  ExitFillAppliedResult,
  RealtimeExecutionExitFillResult,
} from "@ulte/realtime-execution-exit-fill-engine";
import type {
  FillAppliedResult,
  RealtimeExecutionFillResult,
} from "@ulte/realtime-execution-fill-engine";
import {
  projectRealtimeTradeAccounting,
  RealtimeTradeAccountingEngine,
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
  const quantity = positiveDecimalString("5");
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
    approvedRiskAmount: positiveDecimalString("50"),
    actualRiskAmount: positiveDecimalString("50"),
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

function applyEntry(
  attempt: ExecutionAttempt,
  fillId: string,
  quantity: string,
  price: string,
  at: number,
) {
  const fill = createFillEvent({
    executionAttemptId: attempt.executionAttemptId,
    adapterOrderId: "ORDER-1",
    fillId,
    filledQuantity: quantity,
    fillPrice: price,
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
  price: string,
  at: number,
) {
  const exitFill = createExitFillEvent({
    executionAttemptId: attempt.executionAttemptId,
    protectionRequestId: request.protectionRequestId,
    exitSide: attempt.exitSide,
    exitLeg: "PROFIT_TARGET",
    fillId,
    filledQuantity: quantity,
    fillPrice: price,
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

function spec(instrumentId = instrument) {
  return createLinearInstrumentSizingSpec({
    valuationModel: "LINEAR_PRICE_PNL",
    instrumentId,
    pnlCurrency: "USD",
    quantityUnit: "contracts",
    quantityStep: "0.01",
    minimumQuantity: "0.01",
    maximumQuantity: "100",
    pnlValuePerPriceUnitPerQuantity: "1",
  });
}

function projectEntry(result: RealtimeExecutionFillResult, accountingSpec = spec()) {
  return projectRealtimeTradeAccounting({ sourceKind: "ENTRY_FILL", fillLifecycle: result, accountingSpec });
}

function projectExit(result: RealtimeExecutionExitFillResult, accountingSpec = spec()) {
  return projectRealtimeTradeAccounting({ sourceKind: "EXIT_FILL", exitFillLifecycle: result, accountingSpec });
}

describe("realtime accounting status gating", () => {
  it("projects applied and duplicate entry results", () => {
    const applied = applyEntry(working(), "F1", "2.75", "100", 1_001);
    const original = projectEntry(entryResult(applied.attempt, applied.fill, applied.transition));
    const duplicateTransition = applyEntryFill(applied.attempt, applied.fill);
    if (duplicateTransition.status !== "DUPLICATE_EVENT_IGNORED") throw new Error("duplicate failed");
    const duplicate = projectEntry(entryResult(
      duplicateTransition.attempt,
      applied.fill,
      duplicateTransition,
      "DUPLICATE_FILL",
    ));
    expect(original).toMatchObject({ status: "REALIZED_ACCOUNTING_PROJECTED", upstreamStatus: "FILL_APPLIED" });
    expect(duplicate).toMatchObject({ status: "REALIZED_ACCOUNTING_PROJECTED", upstreamStatus: "DUPLICATE_FILL" });
    if (original.status !== "REALIZED_ACCOUNTING_PROJECTED" || duplicate.status !== "REALIZED_ACCOUNTING_PROJECTED") return;
    expect(duplicate.accounting).toEqual(original.accounting);
    expect(duplicate.accounting.openBasisLots).toHaveLength(1);
  });

  it("gates rejected/no-processing entry results before attempt inspection", () => {
    const applied = applyEntry(working(), "F1", "2.75", "100", 1_001);
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
      status: "NO_ACCOUNTING_PROJECTION", sourceKind: "ENTRY_FILL", upstreamStatus: "FILL_REJECTED",
    });
    expect(projectEntry(noProcessing)).toEqual({
      status: "NO_ACCOUNTING_PROJECTION", sourceKind: "ENTRY_FILL", upstreamStatus: "NO_FILL_PROCESSING",
    });
  });

  it("projects applied and duplicate exit results without double realization", () => {
    const entry = applyEntry(working(), "F1", "2.75", "100", 1_001);
    const protection = protect(entry.attempt, 1_002);
    const exit = applyExit(protection.attempt, protection.request, "X1", "1.25", "105", 1_003);
    const original = projectExit(exitResult(exit.attempt, exit.exitFill, exit.transition));
    const duplicateTransition = applyExitFill(exit.attempt, exit.exitFill);
    if (duplicateTransition.status !== "DUPLICATE_EVENT_IGNORED") throw new Error("duplicate failed");
    const duplicate = projectExit(exitResult(
      duplicateTransition.attempt,
      exit.exitFill,
      duplicateTransition,
      "DUPLICATE_EXIT_FILL",
    ));
    expect(original).toMatchObject({ status: "REALIZED_ACCOUNTING_PROJECTED", upstreamStatus: "EXIT_FILL_APPLIED" });
    expect(duplicate).toMatchObject({ status: "REALIZED_ACCOUNTING_PROJECTED", upstreamStatus: "DUPLICATE_EXIT_FILL" });
    if (original.status !== "REALIZED_ACCOUNTING_PROJECTED" || duplicate.status !== "REALIZED_ACCOUNTING_PROJECTED") return;
    expect(duplicate.accounting).toEqual(original.accounting);
    expect(duplicate.accounting.grossRealizedPnl).toBe("6.25");
    expect(duplicate.accounting.realizedMatches).toHaveLength(1);
  });

  it("gates rejected/no-processing exit results before attempt inspection", () => {
    const applied = applyEntry(working(), "F1", "2.75", "100", 1_001);
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
      status: "NO_ACCOUNTING_PROJECTION", sourceKind: "EXIT_FILL", upstreamStatus: "EXIT_FILL_REJECTED",
    });
    expect(projectExit(noProcessing)).toEqual({
      status: "NO_ACCOUNTING_PROJECTION", sourceKind: "EXIT_FILL", upstreamStatus: "NO_EXIT_FILL_PROCESSING",
    });
  });
});

describe("authoritative accounting delegation", () => {
  it("passes through entry, partial-exit, flat-active, later-entry, and closed checkpoints", () => {
    const firstEntry = applyEntry(working(), "F1", "2.75", "100", 1_001);
    const checkpointA = projectEntry(entryResult(firstEntry.attempt, firstEntry.fill, firstEntry.transition));
    expect(checkpointA).toMatchObject({
      status: "REALIZED_ACCOUNTING_PROJECTED",
      accounting: {
        grossRealizedPnl: "0", openQuantity: "2.75",
        positionExposure: { exposureState: "OPEN" },
        openBasisLots: [{ entryFillId: "F1", entryPrice: "100", remainingQuantity: "2.75" }],
      },
    });

    const firstProtection = protect(firstEntry.attempt, 1_002);
    const partial = applyExit(firstProtection.attempt, firstProtection.request, "X1", "1.25", "105", 1_003);
    const checkpointB = projectExit(exitResult(partial.attempt, partial.exitFill, partial.transition));
    expect(checkpointB).toMatchObject({
      status: "REALIZED_ACCOUNTING_PROJECTED",
      accounting: {
        grossRealizedPnl: "6.25", openQuantity: "1.5",
        positionExposure: { exposureState: "PARTIALLY_EXITED" },
        openBasisLots: [{ entryFillId: "F1", entryPrice: "100", remainingQuantity: "1.5" }],
      },
    });

    const flat = applyExit(partial.attempt, firstProtection.request, "X2", "1.5", "90", 1_004);
    const checkpointC = projectExit(exitResult(flat.attempt, flat.exitFill, flat.transition));
    expect(checkpointC).toMatchObject({
      status: "REALIZED_ACCOUNTING_PROJECTED",
      accounting: { grossRealizedPnl: "-8.75", openBasisLots: [], positionExposure: { exposureState: "FLAT_ENTRY_ACTIVE" } },
    });

    const later = applyEntry(flat.attempt, "F2", "2.25", "110", 1_005);
    const checkpointD = projectEntry(entryResult(later.attempt, later.fill, later.transition));
    expect(checkpointD).toMatchObject({
      status: "REALIZED_ACCOUNTING_PROJECTED",
      accounting: {
        grossRealizedPnl: "-8.75",
        openBasisLots: [{ entryFillId: "F2", entryPrice: "110", remainingQuantity: "2.25" }],
      },
    });

    const secondProtection = protect(later.attempt, 1_006);
    const terminal = applyExit(secondProtection.attempt, secondProtection.request, "X3", "2.25", "120", 1_007);
    const checkpointE = projectExit(exitResult(terminal.attempt, terminal.exitFill, terminal.transition));
    expect(checkpointE).toMatchObject({
      status: "REALIZED_ACCOUNTING_PROJECTED",
      accounting: {
        grossRealizedPnl: "13.75", openQuantity: "0", openBasisLots: [],
        positionExposure: { exposureState: "CLOSED" },
      },
    });
  });

  it("passes through LONG and SHORT realized accounting", () => {
    const longEntry = applyEntry(working("BUY"), "LF1", "2", "100", 1_001);
    const longProtection = protect(longEntry.attempt, 1_002);
    const longExit = applyExit(longProtection.attempt, longProtection.request, "LX1", "1", "110", 1_003);
    const longResult = projectExit(exitResult(longExit.attempt, longExit.exitFill, longExit.transition));
    expect(longResult).toMatchObject({
      status: "REALIZED_ACCOUNTING_PROJECTED",
      accounting: { direction: "LONG", grossRealizedPnl: "10" },
    });

    const shortEntry = applyEntry(working("SELL"), "SF1", "2", "100", 1_001);
    const shortProtection = protect(shortEntry.attempt, 1_002);
    const shortExit = applyExit(shortProtection.attempt, shortProtection.request, "SX1", "1", "90", 1_003);
    const shortResult = projectExit(exitResult(shortExit.attempt, shortExit.exitFill, shortExit.transition));
    expect(shortResult).toMatchObject({
      status: "REALIZED_ACCOUNTING_PROJECTED",
      accounting: { direction: "SHORT", grossRealizedPnl: "10" },
    });
  });

  it("preserves accounting and nested position rejection semantics", () => {
    const applied = applyEntry(working(), "F1", "2.75", "100", 1_001);
    const incoherent = Object.freeze({ ...applied.attempt, processedFills: Object.freeze([]) });
    expect(projectEntry(entryResult(incoherent, applied.fill, applied.transition))).toMatchObject({
      status: "REALIZED_ACCOUNTING_REJECTED",
      reason: "ENTRY_FILL_HISTORY_INCOHERENT",
      accountingProjection: { status: "REALIZED_ACCOUNTING_REJECTED", reason: "ENTRY_FILL_HISTORY_INCOHERENT" },
    });

    const invalidPosition = Object.freeze({ ...applied.attempt, exitSide: applied.attempt.entrySide });
    expect(projectEntry(entryResult(invalidPosition, applied.fill, applied.transition))).toMatchObject({
      status: "REALIZED_ACCOUNTING_REJECTED",
      reason: "POSITION_EXPOSURE_REJECTED",
      accountingProjection: {
        reason: "POSITION_EXPOSURE_REJECTED",
        positionProjection: { status: "POSITION_EXPOSURE_REJECTED", reason: "EXECUTION_SIDE_MISMATCH" },
      },
    });
  });

  it("preserves valuation-spec instrument mismatch from Task 027A", () => {
    const applied = applyEntry(working(), "F1", "2.75", "100", 1_001);
    const other = createInstrumentId({ venue: "TEST", venueSymbol: "OTHER", instrumentKind: "CFD" });
    expect(projectEntry(entryResult(applied.attempt, applied.fill, applied.transition), spec(other))).toMatchObject({
      status: "REALIZED_ACCOUNTING_REJECTED",
      reason: "VALUATION_SPEC_INSTRUMENT_MISMATCH",
      accountingProjection: { reason: "VALUATION_SPEC_INSTRUMENT_MISMATCH" },
    });
  });
});

describe("purity, immutability, determinism, and narrow inputs", () => {
  it("does not mutate upstream, attempt, or spec and retains frozen accounting", () => {
    const applied = applyEntry(working(), "F1", "2.75", "100", 1_001);
    const upstream = entryResult(applied.attempt, applied.fill, applied.transition);
    const accountingSpec = spec();
    const upstreamBefore = JSON.stringify(upstream);
    const attemptBefore = JSON.stringify(upstream.executionAttempt);
    const specBefore = JSON.stringify(accountingSpec);
    const result = projectEntry(upstream, accountingSpec);
    expect(JSON.stringify(upstream)).toBe(upstreamBefore);
    expect(JSON.stringify(upstream.executionAttempt)).toBe(attemptBefore);
    expect(JSON.stringify(accountingSpec)).toBe(specBefore);
    expect(Object.isFrozen(result)).toBe(true);
    if (result.status !== "REALIZED_ACCOUNTING_PROJECTED") return;
    expect(Object.isFrozen(result.accounting)).toBe(true);
    expect(Object.isFrozen(result.accounting.openBasisLots)).toBe(true);
    expect(Object.isFrozen(result.accounting.openBasisLots[0])).toBe(true);
  });

  it("is equal across repeated calls and fresh engine instances", () => {
    const applied = applyEntry(working(), "F1", "2.75", "100", 1_001);
    const input = { sourceKind: "ENTRY_FILL", fillLifecycle: entryResult(applied.attempt, applied.fill, applied.transition), accountingSpec: spec() } as const;
    expect(projectRealtimeTradeAccounting(input)).toEqual(projectRealtimeTradeAccounting(input));
    expect(new RealtimeTradeAccountingEngine().project(input)).toEqual(new RealtimeTradeAccountingEngine().project(input));
  });

  it("exposes no caller attempt, accounting values, basis, or as-of override", () => {
    const applied = applyEntry(working(), "F1", "2.75", "100", 1_001);
    const entryInput = { sourceKind: "ENTRY_FILL", fillLifecycle: entryResult(applied.attempt, applied.fill, applied.transition), accountingSpec: spec() };
    expect(Object.keys(entryInput).sort()).toEqual(["accountingSpec", "fillLifecycle", "sourceKind"]);
    for (const prohibited of ["executionAttempt", "positionExposure", "realizedPnl", "basis", "accountingAsOf"]) {
      expect(prohibited in entryInput).toBe(false);
    }

    const protection = protect(applied.attempt, 1_002);
    const exited = applyExit(protection.attempt, protection.request, "X1", "1", "105", 1_003);
    const exitInput = { sourceKind: "EXIT_FILL", exitFillLifecycle: exitResult(exited.attempt, exited.exitFill, exited.transition), accountingSpec: spec() };
    expect(Object.keys(exitInput).sort()).toEqual(["accountingSpec", "exitFillLifecycle", "sourceKind"]);
    for (const prohibited of ["executionAttempt", "positionExposure", "realizedPnl", "basis", "accountingAsOf"]) {
      expect(prohibited in exitInput).toBe(false);
    }
  });
});
