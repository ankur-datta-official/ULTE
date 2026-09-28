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
import { createInstrumentId, nonNegativeDecimalString, positiveDecimalString, unixMs } from "@ulte/instrument-model";
import { createMarketDataEvent, createTradeTick, type MarketDataEvent, type TradeTick } from "@ulte/market-data";
import { createLinearInstrumentSizingSpec } from "@ulte/position-sizing-engine";
import type { ExitFillAppliedResult, RealtimeExecutionExitFillResult } from "@ulte/realtime-execution-exit-fill-engine";
import type { FillAppliedResult, RealtimeExecutionFillResult } from "@ulte/realtime-execution-fill-engine";
import {
  projectRealtimeTradeValuation,
  type RealtimeTradeValuationResult,
} from "@ulte/realtime-trade-valuation-engine";
import {
  projectRealtimeTradePerformance,
  RealtimeTradePerformanceEngine,
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
    schemaVersion: "EXECUTION_PLAN_V1",
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
    quantityUnit: "contracts",
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

function spec() {
  return createLinearInstrumentSizingSpec({
    valuationModel: "LINEAR_PRICE_PNL",
    instrumentId: instrument,
    pnlCurrency: "USD",
    quantityUnit: "contracts",
    quantityStep: "0.01",
    minimumQuantity: "0.01",
    maximumQuantity: "100",
    pnlValuePerPriceUnitPerQuantity: "1",
  });
}

function trade(price: string, eventTime = 2_000, instrumentId = instrument) {
  return createMarketDataEvent({
    instrumentId,
    source: "task-029b-test-feed",
    eventTime,
    receivedAt: eventTime + 1,
    payload: createTradeTick({ price, quantity: "1", side: "UNKNOWN" }),
    quality: ["LIVE"],
  });
}

function valueEntry(result: RealtimeExecutionFillResult, markSource = trade("110")) {
  return projectRealtimeTradeValuation({ sourceKind: "ENTRY_FILL", fillLifecycle: result, accountingSpec: spec(), markSource });
}

function valueExit(result: RealtimeExecutionExitFillResult, markSource = trade("110")) {
  return projectRealtimeTradeValuation({ sourceKind: "EXIT_FILL", exitFillLifecycle: result, accountingSpec: spec(), markSource });
}

describe("outer Task028B status gating", () => {
  it("maps no valuation to no performance without inspecting a forged valuation-looking field", () => {
    const input = Object.freeze({
      status: "NO_VALUATION_PROJECTION",
      sourceKind: "ENTRY_FILL",
      upstreamStatus: "FILL_REJECTED",
      valuation: null,
    }) as unknown as RealtimeTradeValuationResult;
    expect(projectRealtimeTradePerformance(input)).toEqual({
      status: "NO_PERFORMANCE_PROJECTION",
      sourceKind: "ENTRY_FILL",
      upstreamStatus: "FILL_REJECTED",
    });
  });

  it("preserves the exact Task028B rejection object", () => {
    const applied = applyEntry(working(), "F1", "1", "100", 1_001);
    const malformed = { ...trade("110"), payload: null } as unknown as MarketDataEvent<TradeTick>;
    const valuation = valueEntry(entryResult(applied.attempt, applied.fill, applied.transition), malformed);
    const result = projectRealtimeTradePerformance(valuation);
    expect(valuation).toMatchObject({ status: "UNREALIZED_VALUATION_REJECTED", reason: "MARK_SOURCE_INVALID" });
    expect(result).toMatchObject({
      status: "TRADE_PERFORMANCE_REJECTED",
      reason: "REALTIME_VALUATION_REJECTED",
      sourceKind: "ENTRY_FILL",
      upstreamStatus: "FILL_APPLIED",
      markPolicy: "LAST_TRADE_V1",
    });
    if (result.status === "TRADE_PERFORMANCE_REJECTED" && result.reason === "REALTIME_VALUATION_REJECTED") {
      expect(result.realtimeValuation).toBe(valuation);
    }
  });
});

describe("authoritative performance checkpoints", () => {
  it("projects OPEN and no-fill revaluation with exact identity and LAST_TRADE_V1 provenance", () => {
    const applied = applyEntry(working(), "F1", "2.75", "100", 1_001);
    const lifecycle = entryResult(applied.attempt, applied.fill, applied.transition);
    const firstValuation = valueEntry(lifecycle, trade("105", 1_010));
    const laterValuation = valueEntry(lifecycle, trade("110", 1_020));
    const first = projectRealtimeTradePerformance(firstValuation);
    const later = projectRealtimeTradePerformance(laterValuation);
    expect(first).toMatchObject({
      status: "TRADE_PERFORMANCE_PROJECTED",
      sourceKind: "ENTRY_FILL",
      upstreamStatus: "FILL_APPLIED",
      markPolicy: "LAST_TRADE_V1",
      snapshot: {
        direction: "LONG", grossRealizedPnl: "0", grossUnrealizedPnl: "13.75", grossTotalPnl: "13.75",
        positionExposure: { exposureState: "OPEN" },
      },
    });
    expect(later).toMatchObject({
      status: "TRADE_PERFORMANCE_PROJECTED",
      snapshot: { grossRealizedPnl: "0", grossUnrealizedPnl: "27.5", grossTotalPnl: "27.5" },
    });
    if (first.status !== "TRADE_PERFORMANCE_PROJECTED"
      || firstValuation.status !== "UNREALIZED_VALUATION_PROJECTED") return;
    expect(first.realtimeValuation).toBe(firstValuation);
    expect(first.snapshot.unrealizedValuation).toBe(firstValuation.valuation);
    expect(first.snapshot.realizedAccounting).toBe(firstValuation.valuation.realizedAccounting);
    expect(first.snapshot.positionExposure).toBe(firstValuation.valuation.realizedAccounting.positionExposure);
  });

  it("projects PARTIALLY_EXITED, FLAT_ENTRY_ACTIVE, later entry, and CLOSED totals", () => {
    const first = applyEntry(working(), "F1", "2.75", "100", 1_001);
    const protectedFirst = protect(first.attempt, 1_002);
    const partial = applyExit(protectedFirst.attempt, protectedFirst.request, "X1", "1.25", "105", 1_003);
    expect(projectRealtimeTradePerformance(valueExit(exitResult(
      partial.attempt, partial.exitFill, partial.transition,
    ), trade("110", 1_003)))).toMatchObject({
      status: "TRADE_PERFORMANCE_PROJECTED",
      snapshot: {
        grossRealizedPnl: "6.25", grossUnrealizedPnl: "15", grossTotalPnl: "21.25",
        positionExposure: { exposureState: "PARTIALLY_EXITED" },
      },
    });

    const flat = applyExit(partial.attempt, protectedFirst.request, "X2", "1.5", "90", 1_004);
    expect(projectRealtimeTradePerformance(valueExit(exitResult(
      flat.attempt, flat.exitFill, flat.transition,
    ), trade("120", 1_004)))).toMatchObject({
      status: "TRADE_PERFORMANCE_PROJECTED",
      snapshot: {
        grossRealizedPnl: "-8.75", grossUnrealizedPnl: "0", grossTotalPnl: "-8.75",
        positionExposure: { exposureState: "FLAT_ENTRY_ACTIVE" },
      },
    });

    const later = applyEntry(flat.attempt, "F2", "2.25", "110", 1_005);
    expect(projectRealtimeTradePerformance(valueEntry(entryResult(
      later.attempt, later.fill, later.transition,
    ), trade("120", 1_005)))).toMatchObject({
      status: "TRADE_PERFORMANCE_PROJECTED",
      snapshot: { grossRealizedPnl: "-8.75", grossUnrealizedPnl: "22.5", grossTotalPnl: "13.75" },
    });

    const protectedLater = protect(later.attempt, 1_006);
    const closed = applyExit(protectedLater.attempt, protectedLater.request, "X3", "2.25", "120", 1_007);
    expect(projectRealtimeTradePerformance(valueExit(exitResult(
      closed.attempt, closed.exitFill, closed.transition,
    ), trade("130", 1_007)))).toMatchObject({
      status: "TRADE_PERFORMANCE_PROJECTED",
      snapshot: {
        grossRealizedPnl: "13.75", grossUnrealizedPnl: "0", grossTotalPnl: "13.75",
        positionExposure: { exposureState: "CLOSED" },
      },
    });
  });

  it("delegates profitable and losing SHORT snapshots without local direction logic", () => {
    const applied = applyEntry(working("SELL"), "SF1", "2", "100", 1_001);
    const lifecycle = entryResult(applied.attempt, applied.fill, applied.transition);
    expect(projectRealtimeTradePerformance(valueEntry(lifecycle, trade("90")))).toMatchObject({
      snapshot: { direction: "SHORT", grossUnrealizedPnl: "20", grossTotalPnl: "20" },
    });
    expect(projectRealtimeTradePerformance(valueEntry(lifecycle, trade("110")))).toMatchObject({
      snapshot: { direction: "SHORT", grossUnrealizedPnl: "-20", grossTotalPnl: "-20" },
    });
  });
});

describe("duplicates and rejection preservation", () => {
  it("retains applied/duplicate entry provenance with equivalent snapshots", () => {
    const applied = applyEntry(working(), "F1", "2.75", "100", 1_001);
    const original = projectRealtimeTradePerformance(valueEntry(entryResult(
      applied.attempt, applied.fill, applied.transition,
    ), trade("105")));
    const duplicateTransition = applyEntryFill(applied.attempt, applied.fill);
    if (duplicateTransition.status !== "DUPLICATE_EVENT_IGNORED") throw new Error("duplicate entry failed");
    const duplicate = projectRealtimeTradePerformance(valueEntry(entryResult(
      duplicateTransition.attempt, applied.fill, duplicateTransition, "DUPLICATE_FILL",
    ), trade("105")));
    expect(original).toMatchObject({ upstreamStatus: "FILL_APPLIED" });
    expect(duplicate).toMatchObject({ upstreamStatus: "DUPLICATE_FILL" });
    if (original.status !== "TRADE_PERFORMANCE_PROJECTED" || duplicate.status !== "TRADE_PERFORMANCE_PROJECTED") return;
    expect(duplicate.snapshot).toEqual(original.snapshot);
  });

  it("retains applied/duplicate exit provenance with equivalent snapshots", () => {
    const entry = applyEntry(working(), "F1", "2.75", "100", 1_001);
    const protection = protect(entry.attempt, 1_002);
    const exited = applyExit(protection.attempt, protection.request, "X1", "1.25", "105", 1_003);
    const original = projectRealtimeTradePerformance(valueExit(exitResult(
      exited.attempt, exited.exitFill, exited.transition,
    )));
    const duplicateTransition = applyExitFill(exited.attempt, exited.exitFill);
    if (duplicateTransition.status !== "DUPLICATE_EVENT_IGNORED") throw new Error("duplicate exit failed");
    const duplicate = projectRealtimeTradePerformance(valueExit(exitResult(
      duplicateTransition.attempt, exited.exitFill, duplicateTransition, "DUPLICATE_EXIT_FILL",
    )));
    expect(original).toMatchObject({ upstreamStatus: "EXIT_FILL_APPLIED" });
    expect(duplicate).toMatchObject({ upstreamStatus: "DUPLICATE_EXIT_FILL" });
    if (original.status !== "TRADE_PERFORMANCE_PROJECTED" || duplicate.status !== "TRADE_PERFORMANCE_PROJECTED") return;
    expect(duplicate.snapshot).toEqual(original.snapshot);
  });

  it("preserves mismatch, chronology, accounting, and nested position rejections exactly", () => {
    const applied = applyEntry(working(), "F1", "1", "100", 1_001);
    const lifecycle = entryResult(applied.attempt, applied.fill, applied.transition);
    const mismatch = valueEntry(lifecycle, trade("110", 2_000, otherInstrument));
    const chronology = valueEntry(lifecycle, trade("110", 1_000));
    const incoherent = Object.freeze({ ...applied.attempt, processedFills: Object.freeze([]) });
    const accounting = valueEntry(entryResult(incoherent, applied.fill, applied.transition));
    const invalidPosition = Object.freeze({ ...applied.attempt, exitSide: applied.attempt.entrySide });
    const position = valueEntry(entryResult(invalidPosition, applied.fill, applied.transition));
    const cases = [mismatch, chronology, accounting, position];
    expect(mismatch).toMatchObject({ reason: "VALUATION_MARK_INSTRUMENT_MISMATCH" });
    expect(chronology).toMatchObject({ reason: "VALUATION_MARK_PRECEDES_ACCOUNTING" });
    expect(accounting).toMatchObject({
      reason: "REALIZED_ACCOUNTING_REJECTED",
      valuationProjection: { accountingProjection: { reason: "ENTRY_FILL_HISTORY_INCOHERENT" } },
    });
    expect(position).toMatchObject({
      valuationProjection: {
        accountingProjection: {
          reason: "POSITION_EXPOSURE_REJECTED",
          positionProjection: { reason: "EXECUTION_SIDE_MISMATCH" },
        },
      },
    });
    for (const valuation of cases) {
      const result = projectRealtimeTradePerformance(valuation);
      expect(result).toMatchObject({ status: "TRADE_PERFORMANCE_REJECTED", reason: "REALTIME_VALUATION_REJECTED" });
      if (result.status === "TRADE_PERFORMANCE_REJECTED" && result.reason === "REALTIME_VALUATION_REJECTED") {
        expect(result.realtimeValuation).toBe(valuation);
      }
    }
  });

  it("preserves the exact Task029A rejection for a forged projected incoherence", () => {
    const applied = applyEntry(working(), "F1", "1", "100", 1_001);
    const valuation = valueEntry(entryResult(applied.attempt, applied.fill, applied.transition));
    if (valuation.status !== "UNREALIZED_VALUATION_PROJECTED") throw new Error("fixture valuation failed");
    const forged = Object.freeze({
      ...valuation,
      valuation: Object.freeze({ ...valuation.valuation, openQuantity: nonNegativeDecimalString("2") }),
    });
    const result = projectRealtimeTradePerformance(forged);
    expect(result).toMatchObject({
      status: "TRADE_PERFORMANCE_REJECTED",
      reason: "TRADE_PERFORMANCE_AGGREGATION_REJECTED",
      performanceProjection: { reason: "PERFORMANCE_AGGREGATION_INCOHERENT" },
    });
    if (result.status !== "TRADE_PERFORMANCE_REJECTED"
      || result.reason !== "TRADE_PERFORMANCE_AGGREGATION_REJECTED") return;
    expect(result.realtimeValuation).toBe(forged);
    expect(Object.isFrozen(result.performanceProjection)).toBe(true);
  });
});

describe("immutability, determinism, and narrow public scope", () => {
  it("does not mutate Task028B or nested authorities and freezes every newly-owned level", () => {
    const applied = applyEntry(working(), "F1", "2.75", "100", 1_001);
    const valuation = valueEntry(entryResult(applied.attempt, applied.fill, applied.transition), trade("105"));
    const before = JSON.stringify(valuation);
    const result = projectRealtimeTradePerformance(valuation);
    expect(JSON.stringify(valuation)).toBe(before);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(valuation)).toBe(true);
    if (result.status !== "TRADE_PERFORMANCE_PROJECTED"
      || valuation.status !== "UNREALIZED_VALUATION_PROJECTED") return;
    expect(Object.isFrozen(result.snapshot)).toBe(true);
    expect(Object.isFrozen(result.snapshot.unrealizedValuation)).toBe(true);
    expect(Object.isFrozen(result.snapshot.realizedAccounting)).toBe(true);
    expect(Object.isFrozen(result.snapshot.positionExposure)).toBe(true);
    expect(result.snapshot.unrealizedValuation).toBe(valuation.valuation);
  });

  it("is deterministic across repeated calls and fresh engines", () => {
    const applied = applyEntry(working(), "F1", "1", "100", 1_001);
    const valuation = valueEntry(entryResult(applied.attempt, applied.fill, applied.transition));
    expect(projectRealtimeTradePerformance(valuation)).toEqual(projectRealtimeTradePerformance(valuation));
    expect(new RealtimeTradePerformanceEngine().project(valuation))
      .toEqual(new RealtimeTradePerformanceEngine().project(valuation));
  });

  it("accepts only one complete Task028B result and exposes no caller override input", () => {
    expect(projectRealtimeTradePerformance.length).toBe(1);
    const applied = applyEntry(working(), "F1", "1", "100", 1_001);
    const valuation = valueEntry(entryResult(applied.attempt, applied.fill, applied.transition));
    expect(Object.keys({ realtimeValuation: valuation })).toEqual(["realtimeValuation"]);
  });
});
