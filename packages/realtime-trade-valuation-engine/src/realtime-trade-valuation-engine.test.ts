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
import { createMarketDataEvent, createTradeTick, type MarketDataEvent, type TradeTick } from "@ulte/market-data";
import { createLinearInstrumentSizingSpec } from "@ulte/position-sizing-engine";
import type { ExitFillAppliedResult, RealtimeExecutionExitFillResult } from "@ulte/realtime-execution-exit-fill-engine";
import type { FillAppliedResult, RealtimeExecutionFillResult } from "@ulte/realtime-execution-fill-engine";
import {
  projectRealtimeTradeValuation,
  REALTIME_VALUATION_MARK_POLICY_V1,
  RealtimeTradeValuationEngine,
} from "./index.js";

const instrument = createInstrumentId({ venue: "TEST", venueSymbol: "ABC", instrumentKind: "CFD" });
const otherInstrument = createInstrumentId({ venue: "TEST", venueSymbol: "OTHER", instrumentKind: "CFD" });
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
      triggerPrice: positiveDecimalString(entrySide === "BUY" ? "90" : "110"), quantity, positionEffect: "CLOSE",
    }),
    profitTargetInstruction: Object.freeze({
      kind: "PROFIT_TARGET_LIMIT", side: exitSide,
      price: positiveDecimalString(entrySide === "BUY" ? "130" : "70"), quantity, positionEffect: "CLOSE",
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

function applyEntry(attempt: ExecutionAttempt, fillId: string, quantity: string, price: string, at: number) {
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

function trade(price: string, eventTime = 2_000, receivedAt = eventTime, instrumentId = instrument) {
  return createMarketDataEvent({
    instrumentId,
    source: "task-028b-test-feed",
    eventTime,
    receivedAt,
    payload: createTradeTick({ price, quantity: "1", side: "UNKNOWN" }),
    quality: ["LIVE"],
  });
}

function projectEntry(result: RealtimeExecutionFillResult, markSource = trade("110"), accountingSpec = spec()) {
  return projectRealtimeTradeValuation({ sourceKind: "ENTRY_FILL", fillLifecycle: result, accountingSpec, markSource });
}

function projectExit(result: RealtimeExecutionExitFillResult, markSource = trade("110"), accountingSpec = spec()) {
  return projectRealtimeTradeValuation({ sourceKind: "EXIT_FILL", exitFillLifecycle: result, accountingSpec, markSource });
}

describe("realtime valuation status gating", () => {
  it("projects applied and duplicate entry results identically", () => {
    const applied = applyEntry(working(), "F1", "2.75", "100", 1_001);
    const lifecycle = entryResult(applied.attempt, applied.fill, applied.transition);
    const original = projectEntry(lifecycle, trade("105"));
    const duplicateTransition = applyEntryFill(applied.attempt, applied.fill);
    if (duplicateTransition.status !== "DUPLICATE_EVENT_IGNORED") throw new Error("duplicate failed");
    const duplicate = projectEntry(entryResult(
      duplicateTransition.attempt, applied.fill, duplicateTransition, "DUPLICATE_FILL",
    ), trade("105"));
    expect(original).toMatchObject({
      status: "UNREALIZED_VALUATION_PROJECTED",
      upstreamStatus: "FILL_APPLIED",
      markPolicy: "LAST_TRADE_V1",
      valuation: { grossUnrealizedPnl: "13.75", openQuantity: "2.75" },
    });
    expect(duplicate).toMatchObject({ status: "UNREALIZED_VALUATION_PROJECTED", upstreamStatus: "DUPLICATE_FILL" });
    if (original.status !== "UNREALIZED_VALUATION_PROJECTED" || duplicate.status !== "UNREALIZED_VALUATION_PROJECTED") return;
    expect(duplicate.valuation).toEqual(original.valuation);
  });

  it("gates rejected/no-processing entry results before attempt or malformed mark inspection", () => {
    const applied = applyEntry(working(), "F1", "2.75", "100", 1_001);
    const rejected: RealtimeExecutionFillResult = Object.freeze({
      status: "FILL_REJECTED",
      reason: "OVERFILL_DETECTED",
      preparationCycleId: "cycle-1",
      executionAttempt: applied.attempt,
    });
    const noProcessing: RealtimeExecutionFillResult = Object.freeze({
      status: "NO_FILL_PROCESSING", preparationCycleId: "cycle-1", upstreamStatus: "NO_SUBMISSION",
    });
    const malformed = { payload: null } as unknown as MarketDataEvent<TradeTick>;
    expect(projectEntry(rejected, trade("110"))).toEqual({
      status: "NO_VALUATION_PROJECTION", sourceKind: "ENTRY_FILL", upstreamStatus: "FILL_REJECTED",
    });
    expect(projectEntry(rejected, malformed)).toEqual({
      status: "NO_VALUATION_PROJECTION", sourceKind: "ENTRY_FILL", upstreamStatus: "FILL_REJECTED",
    });
    expect(projectEntry(noProcessing)).toEqual({
      status: "NO_VALUATION_PROJECTION", sourceKind: "ENTRY_FILL", upstreamStatus: "NO_FILL_PROCESSING",
    });
  });

  it("projects applied and duplicate exit results identically without valuing exited basis", () => {
    const entry = applyEntry(working(), "F1", "2.75", "100", 1_001);
    const protection = protect(entry.attempt, 1_002);
    const exited = applyExit(protection.attempt, protection.request, "X1", "1.25", "105", 1_003);
    const original = projectExit(exitResult(exited.attempt, exited.exitFill, exited.transition));
    const duplicateTransition = applyExitFill(exited.attempt, exited.exitFill);
    if (duplicateTransition.status !== "DUPLICATE_EVENT_IGNORED") throw new Error("duplicate failed");
    const duplicate = projectExit(exitResult(
      duplicateTransition.attempt, exited.exitFill, duplicateTransition, "DUPLICATE_EXIT_FILL",
    ));
    expect(original).toMatchObject({
      status: "UNREALIZED_VALUATION_PROJECTED",
      valuation: {
        grossUnrealizedPnl: "15",
        openQuantity: "1.5",
        openLotValuations: [{ remainingQuantity: "1.5" }],
      },
    });
    expect(duplicate).toMatchObject({ status: "UNREALIZED_VALUATION_PROJECTED", upstreamStatus: "DUPLICATE_EXIT_FILL" });
    if (original.status !== "UNREALIZED_VALUATION_PROJECTED" || duplicate.status !== "UNREALIZED_VALUATION_PROJECTED") return;
    expect(duplicate.valuation).toEqual(original.valuation);
  });

  it("gates rejected/no-processing exit results before attempt or mark inspection", () => {
    const applied = applyEntry(working(), "F1", "2.75", "100", 1_001);
    const rejected: RealtimeExecutionExitFillResult = Object.freeze({
      status: "EXIT_FILL_REJECTED",
      reason: "OVER_EXIT_DETECTED",
      preparationCycleId: "cycle-1",
      executionAttempt: applied.attempt,
    });
    const noProcessing: RealtimeExecutionExitFillResult = Object.freeze({
      status: "NO_EXIT_FILL_PROCESSING", preparationCycleId: "cycle-1", upstreamStatus: "NO_PROTECTION_LIFECYCLE",
    });
    const malformed = { eventTime: "future" } as unknown as MarketDataEvent<TradeTick>;
    expect(projectExit(rejected, trade("110"))).toEqual({
      status: "NO_VALUATION_PROJECTION", sourceKind: "EXIT_FILL", upstreamStatus: "EXIT_FILL_REJECTED",
    });
    expect(projectExit(rejected, malformed)).toEqual({
      status: "NO_VALUATION_PROJECTION", sourceKind: "EXIT_FILL", upstreamStatus: "EXIT_FILL_REJECTED",
    });
    expect(projectExit(noProcessing)).toEqual({
      status: "NO_VALUATION_PROJECTION", sourceKind: "EXIT_FILL", upstreamStatus: "NO_EXIT_FILL_PROCESSING",
    });
  });
});

describe("LAST_TRADE_V1 resolution and authoritative valuation", () => {
  it("uses trade price and eventTime, never receivedAt, and revalues without a new fill", () => {
    const applied = applyEntry(working(), "F1", "2.75", "100", 1_001);
    const lifecycle = entryResult(applied.attempt, applied.fill, applied.transition);
    const first = projectEntry(lifecycle, trade("110", 1_010, 9_999));
    const later = projectEntry(lifecycle, trade("120", 1_020, 1_005));
    expect(first).toMatchObject({
      status: "UNREALIZED_VALUATION_PROJECTED",
      markPolicy: REALTIME_VALUATION_MARK_POLICY_V1,
      valuation: { markPrice: "110", markAsOf: 1_010, grossUnrealizedPnl: "27.5" },
    });
    expect(later).toMatchObject({
      status: "UNREALIZED_VALUATION_PROJECTED",
      valuation: { markPrice: "120", markAsOf: 1_020, grossUnrealizedPnl: "55" },
    });
    if (first.status !== "UNREALIZED_VALUATION_PROJECTED" || later.status !== "UNREALIZED_VALUATION_PROJECTED") return;
    expect(first.valuation.executionAttemptId).toBe(later.valuation.executionAttemptId);
    expect(lifecycle.executionAttempt).toBe(applied.attempt);
    expect(projectEntry(lifecycle, trade("110", 1_010, 9_999))).toEqual(first);
  });

  it("preserves mark mismatch and chronology decisions from Task028A and allows equal time", () => {
    const applied = applyEntry(working(), "F1", "1", "100", 1_001);
    const lifecycle = entryResult(applied.attempt, applied.fill, applied.transition);
    expect(projectEntry(lifecycle, trade("110", 2_000, 2_000, otherInstrument))).toMatchObject({
      status: "UNREALIZED_VALUATION_REJECTED",
      reason: "VALUATION_MARK_INSTRUMENT_MISMATCH",
      valuationProjection: { reason: "VALUATION_MARK_INSTRUMENT_MISMATCH" },
    });
    expect(projectEntry(lifecycle, trade("110", 1_000))).toMatchObject({
      status: "UNREALIZED_VALUATION_REJECTED",
      reason: "VALUATION_MARK_PRECEDES_ACCOUNTING",
      valuationProjection: { reason: "VALUATION_MARK_PRECEDES_ACCOUNTING" },
    });
    expect(projectEntry(lifecycle, trade("110", 1_001))).toMatchObject({
      status: "UNREALIZED_VALUATION_PROJECTED",
      valuation: { grossUnrealizedPnl: "10", markAsOf: 1_001 },
    });
  });

  it("rejects a malformed mark source without fabricating a Task028A rejection", () => {
    const applied = applyEntry(working(), "F1", "1", "100", 1_001);
    const malformed = { ...trade("110"), payload: { price: "0", quantity: "1", side: "UNKNOWN" } } as unknown as MarketDataEvent<TradeTick>;
    const result = projectEntry(entryResult(applied.attempt, applied.fill, applied.transition), malformed);
    expect(result).toEqual({
      status: "UNREALIZED_VALUATION_REJECTED",
      sourceKind: "ENTRY_FILL",
      upstreamStatus: "FILL_APPLIED",
      markPolicy: "LAST_TRADE_V1",
      reason: "MARK_SOURCE_INVALID",
    });
    expect("valuationProjection" in result).toBe(false);
  });

  it("keeps flat-active and closed at zero and values only a later fresh basis", () => {
    const first = applyEntry(working(), "F1", "2.75", "100", 1_001);
    const firstProtection = protect(first.attempt, 1_002);
    const partial = applyExit(firstProtection.attempt, firstProtection.request, "X1", "1.25", "105", 1_003);
    const flat = applyExit(partial.attempt, firstProtection.request, "X2", "1.5", "90", 1_004);
    expect(projectExit(exitResult(flat.attempt, flat.exitFill, flat.transition), trade("120", 1_004))).toMatchObject({
      status: "UNREALIZED_VALUATION_PROJECTED",
      valuation: {
        grossUnrealizedPnl: "0", openQuantity: "0", openLotValuations: [],
        realizedAccounting: { positionExposure: { exposureState: "FLAT_ENTRY_ACTIVE" } },
      },
    });

    const later = applyEntry(flat.attempt, "F2", "2.25", "110", 1_005);
    expect(projectEntry(entryResult(later.attempt, later.fill, later.transition), trade("120", 1_005))).toMatchObject({
      status: "UNREALIZED_VALUATION_PROJECTED",
      valuation: {
        grossUnrealizedPnl: "22.5",
        openLotValuations: [{ entryFillId: "F2", entryPrice: "110", remainingQuantity: "2.25" }],
      },
    });

    const secondProtection = protect(later.attempt, 1_006);
    const closed = applyExit(secondProtection.attempt, secondProtection.request, "X3", "2.25", "120", 1_007);
    expect(projectExit(exitResult(closed.attempt, closed.exitFill, closed.transition), trade("130", 1_007))).toMatchObject({
      status: "UNREALIZED_VALUATION_PROJECTED",
      valuation: {
        grossUnrealizedPnl: "0", openQuantity: "0", openLotValuations: [],
        realizedAccounting: { positionExposure: { exposureState: "CLOSED" } },
      },
    });
  });

  it("delegates both profitable and losing SHORT marks to Task028A", () => {
    const applied = applyEntry(working("SELL"), "SF1", "2", "100", 1_001);
    const lifecycle = entryResult(applied.attempt, applied.fill, applied.transition);
    expect(projectEntry(lifecycle, trade("90"))).toMatchObject({
      status: "UNREALIZED_VALUATION_PROJECTED",
      valuation: { direction: "SHORT", grossUnrealizedPnl: "20" },
    });
    expect(projectEntry(lifecycle, trade("110"))).toMatchObject({
      status: "UNREALIZED_VALUATION_PROJECTED",
      valuation: { direction: "SHORT", grossUnrealizedPnl: "-20" },
    });
  });

  it("preserves exact Task028A, Task027A, and position rejection nesting", () => {
    const applied = applyEntry(working(), "F1", "2.75", "100", 1_001);
    const incoherent = Object.freeze({ ...applied.attempt, processedFills: Object.freeze([]) });
    const accountingFailure = projectEntry(entryResult(incoherent, applied.fill, applied.transition));
    expect(accountingFailure).toMatchObject({
      status: "UNREALIZED_VALUATION_REJECTED",
      reason: "REALIZED_ACCOUNTING_REJECTED",
      valuationProjection: {
        status: "UNREALIZED_VALUATION_REJECTED",
        reason: "REALIZED_ACCOUNTING_REJECTED",
        accountingProjection: { reason: "ENTRY_FILL_HISTORY_INCOHERENT" },
      },
    });
    const invalidPosition = Object.freeze({ ...applied.attempt, exitSide: applied.attempt.entrySide });
    expect(projectEntry(entryResult(invalidPosition, applied.fill, applied.transition))).toMatchObject({
      status: "UNREALIZED_VALUATION_REJECTED",
      reason: "REALIZED_ACCOUNTING_REJECTED",
      valuationProjection: {
        accountingProjection: {
          reason: "POSITION_EXPOSURE_REJECTED",
          positionProjection: { reason: "EXECUTION_SIDE_MISMATCH" },
        },
      },
    });
  });
});

describe("purity, immutability, determinism, and narrow inputs", () => {
  it("does not mutate inputs and returns frozen wrappers with Task028A frozen valuation", () => {
    const applied = applyEntry(working(), "F1", "2.75", "100", 1_001);
    const lifecycle = entryResult(applied.attempt, applied.fill, applied.transition);
    const accountingSpec = spec();
    const markSource = trade("110");
    const before = [JSON.stringify(lifecycle), JSON.stringify(lifecycle.executionAttempt), JSON.stringify(accountingSpec), JSON.stringify(markSource)];
    const result = projectEntry(lifecycle, markSource, accountingSpec);
    expect([JSON.stringify(lifecycle), JSON.stringify(lifecycle.executionAttempt), JSON.stringify(accountingSpec), JSON.stringify(markSource)]).toEqual(before);
    expect(Object.isFrozen(result)).toBe(true);
    if (result.status !== "UNREALIZED_VALUATION_PROJECTED") return;
    expect(Object.isFrozen(result.valuation)).toBe(true);
    expect(Object.isFrozen(result.valuation.openLotValuations)).toBe(true);
    expect(Object.isFrozen(result.valuation.openLotValuations[0])).toBe(true);
  });

  it("is deterministic across repeated calls, repeated events, and fresh engines", () => {
    const applied = applyEntry(working(), "F1", "1", "100", 1_001);
    const input = {
      sourceKind: "ENTRY_FILL",
      fillLifecycle: entryResult(applied.attempt, applied.fill, applied.transition),
      accountingSpec: spec(),
      markSource: trade("110"),
    } as const;
    expect(projectRealtimeTradeValuation(input)).toEqual(projectRealtimeTradeValuation(input));
    expect(new RealtimeTradeValuationEngine().project(input)).toEqual(new RealtimeTradeValuationEngine().project(input));
  });

  it("exposes no caller attempt, mark, basis, direction, or PnL override", () => {
    const applied = applyEntry(working(), "F1", "1", "100", 1_001);
    const input = {
      sourceKind: "ENTRY_FILL",
      fillLifecycle: entryResult(applied.attempt, applied.fill, applied.transition),
      accountingSpec: spec(),
      markSource: trade("110"),
    };
    expect(Object.keys(input).sort()).toEqual(["accountingSpec", "fillLifecycle", "markSource", "sourceKind"]);
    for (const prohibited of [
      "executionAttempt", "valuationMark", "markPrice", "markAsOf", "positionExposure",
      "realizedAccounting", "openBasisLots", "direction", "grossUnrealizedPnl",
    ]) expect(prohibited in input).toBe(false);
  });
});
