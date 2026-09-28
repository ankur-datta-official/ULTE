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
import { createInstrumentId, positiveDecimalString, unixMs } from "@ulte/instrument-model";
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
  createTradeCostEvent,
  projectTradeCostAccounting,
  type TradeCostEvent,
  type TradeCostEventInput,
} from "@ulte/trade-cost-accounting-engine";
import {
  RealtimeTradeCostAccountingEngine,
  projectRealtimeTradeCostAccounting,
} from "./index.js";

const instrument = createInstrumentId({ venue: "TEST", venueSymbol: "ABC", instrumentKind: "CFD" });
const otherInstrument = createInstrumentId({ venue: "TEST", venueSymbol: "XYZ", instrumentKind: "CFD" });
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
  const quantity = positiveDecimalString("2.75");
  return Object.freeze({
    status: "EXECUTION_PLAN_READY",
    schemaVersion: "EXECUTION_PLAN_V1",
    executionPlanId: `cost-plan-${entrySide}`,
    tradeIntentId: `cost-intent-${entrySide}`,
    candidateId: `cost-candidate-${entrySide}`,
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
    adapterOrderId: `ORDER-${entrySide}`,
    acknowledgedAt: 1_000,
  });
  if (acknowledged.status !== "EXECUTION_ATTEMPT_UPDATED") throw new Error("acknowledgement failed");
  return acknowledged.attempt;
}

function enter(entrySide: "BUY" | "SELL" = "BUY") {
  const attempt = working(entrySide);
  const fill = createFillEvent({
    executionAttemptId: attempt.executionAttemptId,
    adapterOrderId: `ORDER-${entrySide}`,
    fillId: `F1-${entrySide}`,
    filledQuantity: "2.75",
    fillPrice: "100",
    filledAt: 1_001,
  });
  const transition = applyEntryFill(attempt, fill);
  if (transition.status !== "EXECUTION_ATTEMPT_UPDATED") throw new Error("entry fill failed");
  return { attempt: transition.attempt, fill, transition };
}

function protect(attempt: ExecutionAttempt): { attempt: ExecutionAttempt; request: ProtectionRequest } {
  const requested = requestProtection(attempt);
  if (requested.status !== "PROTECTION_REQUEST_READY") throw new Error("protection request failed");
  const acknowledged = acknowledgeProtection(requested.attempt, {
    executionAttemptId: attempt.executionAttemptId,
    protectionRequestId: requested.request.protectionRequestId,
    idempotencyKey: requested.request.idempotencyKey,
    protectedQuantity: requested.request.targetCumulativeProtectedQuantity,
    acknowledgedAt: 1_002,
  });
  if (acknowledged.status !== "EXECUTION_ATTEMPT_UPDATED") throw new Error("protection failed");
  return { attempt: acknowledged.attempt, request: requested.request };
}

function exit(attempt: ExecutionAttempt, request: ProtectionRequest, fillId: string, quantity: string, at: number) {
  const exitFill = createExitFillEvent({
    executionAttemptId: attempt.executionAttemptId,
    protectionRequestId: request.protectionRequestId,
    exitSide: attempt.exitSide,
    exitLeg: "PROFIT_TARGET",
    fillId,
    filledQuantity: quantity,
    fillPrice: attempt.entrySide === "BUY" ? "105" : "95",
    filledAt: at,
  });
  const transition = applyExitFill(attempt, exitFill);
  if (transition.status !== "EXECUTION_ATTEMPT_UPDATED") throw new Error("exit fill failed");
  return { attempt: transition.attempt, exitFill, transition };
}

function entryLifecycle(
  source: ReturnType<typeof enter>,
  status: FillAppliedResult["status"] = "FILL_APPLIED",
): FillAppliedResult {
  return Object.freeze({
    status,
    preparationCycleId: "cycle-cost",
    submissionAsOf: unixMs(999),
    observationAsOf: source.fill.filledAt,
    fill: source.fill,
    executionAttempt: source.attempt,
    transitionResult: source.transition,
  });
}

function exitLifecycle(
  source: ReturnType<typeof exit>,
  status: ExitFillAppliedResult["status"] = "EXIT_FILL_APPLIED",
): ExitFillAppliedResult {
  return Object.freeze({
    status,
    preparationCycleId: "cycle-cost",
    protectionAsOf: unixMs(1_002),
    observationAsOf: source.exitFill.filledAt,
    exitFill: source.exitFill,
    executionAttempt: source.attempt,
    transitionResult: source.transition,
  });
}

function spec(instrumentId = instrument, pnlCurrency = "USD") {
  return createLinearInstrumentSizingSpec({
    valuationModel: "LINEAR_PRICE_PNL",
    instrumentId,
    pnlCurrency,
    quantityUnit: "contracts",
    quantityStep: "0.01",
    minimumQuantity: "0.01",
    maximumQuantity: "100",
    pnlValuePerPriceUnitPerQuantity: "1",
  });
}

function cost(attempt: ExecutionAttempt, overrides: Partial<TradeCostEventInput> = {}): TradeCostEvent {
  return createTradeCostEvent({
    costEventId: "C1",
    executionAttemptId: attempt.executionAttemptId,
    instrumentId: attempt.instrumentId,
    costType: "COMMISSION",
    effect: "DEBIT",
    amount: "1.25",
    currency: "USD",
    effectiveAt: 1_001,
    source: "TEST_PROVIDER",
    ...overrides,
  });
}

function projectEntry(
  fillLifecycle: RealtimeExecutionFillResult,
  observedCostEvents: readonly TradeCostEvent[] = [],
  accountingSpec = spec(),
) {
  return projectRealtimeTradeCostAccounting({
    sourceKind: "ENTRY_FILL", fillLifecycle, accountingSpec, observedCostEvents,
  });
}

function projectExit(
  exitFillLifecycle: RealtimeExecutionExitFillResult,
  observedCostEvents: readonly TradeCostEvent[] = [],
  accountingSpec = spec(),
) {
  return projectRealtimeTradeCostAccounting({
    sourceKind: "EXIT_FILL", exitFillLifecycle, accountingSpec, observedCostEvents,
  });
}

function expectProjected(result: ReturnType<typeof projectEntry>) {
  expect(result.status).toBe("TRADE_COST_ACCOUNTING_PROJECTED");
  if (result.status !== "TRADE_COST_ACCOUNTING_PROJECTED") throw new Error("projection failed");
  return result;
}

describe("outer execution status gate", () => {
  it("projects zero-cost accounting for applied and duplicate entry results", () => {
    const entered = enter();
    const applied = expectProjected(projectEntry(entryLifecycle(entered)));
    const duplicate = expectProjected(projectEntry(entryLifecycle(entered, "DUPLICATE_FILL")));
    expect(applied.accounting).toMatchObject({ grossDebitCostAmount: "0", grossCreditCostAmount: "0", netCostAmount: "0" });
    expect(duplicate.accounting).toEqual(applied.accounting);
    expect(duplicate.upstreamStatus).toBe("DUPLICATE_FILL");
  });

  it.each([
    ["FILL_REJECTED", { status: "FILL_REJECTED", reason: "OVERFILL_DETECTED", preparationCycleId: "cycle-cost" }],
    ["NO_FILL_PROCESSING", { status: "NO_FILL_PROCESSING", preparationCycleId: "cycle-cost", upstreamStatus: "NO_SUBMISSION" }],
  ] as const)("returns no projection for %s", (upstreamStatus, fillLifecycle) => {
    expect(projectEntry(fillLifecycle)).toEqual({
      status: "NO_COST_ACCOUNTING_PROJECTION", sourceKind: "ENTRY_FILL", upstreamStatus,
    });
  });

  it("projects applied and duplicate exit results", () => {
    const entry = enter();
    const protection = protect(entry.attempt);
    const partial = exit(protection.attempt, protection.request, "X1", "1.25", 1_003);
    const fee = cost(partial.attempt);
    const applied = expectProjected(projectExit(exitLifecycle(partial), [fee]));
    const duplicate = expectProjected(projectExit(exitLifecycle(partial, "DUPLICATE_EXIT_FILL"), [fee]));
    expect(duplicate.accounting).toEqual(applied.accounting);
    expect(duplicate.upstreamStatus).toBe("DUPLICATE_EXIT_FILL");
  });

  it.each([
    ["EXIT_FILL_REJECTED", { status: "EXIT_FILL_REJECTED", reason: "OVER_EXIT_DETECTED", preparationCycleId: "cycle-cost" }],
    ["NO_EXIT_FILL_PROCESSING", { status: "NO_EXIT_FILL_PROCESSING", preparationCycleId: "cycle-cost", upstreamStatus: "NO_PROTECTION_LIFECYCLE" }],
  ] as const)("returns no projection for %s", (upstreamStatus, exitFillLifecycle) => {
    expect(projectExit(exitFillLifecycle)).toEqual({
      status: "NO_COST_ACCOUNTING_PROJECTION", sourceKind: "EXIT_FILL", upstreamStatus,
    });
  });

  it("gates rejected entry and exit masquerades before malformed delivery inspection", () => {
    const entry = enter();
    const malformed = { ...cost(entry.attempt), amount: "0" } as unknown as TradeCostEvent;
    const rejectedEntry: RealtimeExecutionFillResult = Object.freeze({
      status: "FILL_REJECTED", reason: "OVERFILL_DETECTED", preparationCycleId: "cycle-cost",
      executionAttempt: entry.attempt,
    });
    const rejectedExit: RealtimeExecutionExitFillResult = Object.freeze({
      status: "EXIT_FILL_REJECTED", reason: "OVER_EXIT_DETECTED", preparationCycleId: "cycle-cost",
      executionAttempt: entry.attempt,
    });
    expect(projectEntry(rejectedEntry, [malformed]).status).toBe("NO_COST_ACCOUNTING_PROJECTION");
    expect(projectExit(rejectedExit, [malformed]).status).toBe("NO_COST_ACCOUNTING_PROJECTION");
  });
});

describe("canonical observed delivery normalization", () => {
  it("projects one commission and updates costs with the same lifecycle and no new fill", () => {
    const lifecycle = entryLifecycle(enter());
    const commission = cost(lifecycle.executionAttempt);
    const funding = cost(lifecycle.executionAttempt, {
      costEventId: "C2", costType: "FUNDING", effect: "CREDIT", amount: "0.50", effectiveAt: 1_002,
    });
    const first = expectProjected(projectEntry(lifecycle, [commission]));
    const second = expectProjected(projectEntry(lifecycle, [commission, funding]));
    expect(first.accounting.netCostAmount).toBe("1.25");
    expect(second.accounting.netCostAmount).toBe("0.75");
    expect(second.accounting.executionAttemptId).toBe(first.accounting.executionAttemptId);
  });

  it("collapses exact canonical duplicate deliveries with correct counts", () => {
    const lifecycle = entryLifecycle(enter());
    const canonical = cost(lifecycle.executionAttempt);
    const exact = expectProjected(projectEntry(lifecycle, [canonical, canonical]));
    expect(exact).toMatchObject({ observedDeliveryCount: 2, uniqueCostEventCount: 1, duplicateDeliveryCount: 1 });
    expect(exact.accounting).toMatchObject({ grossDebitCostAmount: "1.25", netCostAmount: "1.25", costEventCount: 1 });
  });

  it("compares constructor-preserved decimal spellings as distinct canonical payloads", () => {
    const lifecycle = entryLifecycle(enter());
    const canonical = cost(lifecycle.executionAttempt);
    const scalePreserved = { ...canonical, amount: "1.2500" } as unknown as TradeCostEvent;
    expect(projectEntry(lifecycle, [canonical, scalePreserved])).toMatchObject({
      status: "TRADE_COST_ACCOUNTING_REJECTED",
      reason: "CONFLICTING_DUPLICATE_COST_EVENT_ID",
    });
  });

  it.each([
    ["amount", { amount: "1.5" }],
    ["effect", { effect: "CREDIT" }],
    ["cost type", { costType: "FUNDING" }],
    ["currency", { currency: "EUR" }],
    ["time", { effectiveAt: 1_002 }],
    ["source", { source: "OTHER_PROVIDER" }],
    ["attempt", { executionAttemptId: "other-attempt" }],
    ["instrument", { instrumentId: otherInstrument }],
  ] as const)("rejects a same-ID conflicting %s", (_name, override) => {
    const lifecycle = entryLifecycle(enter());
    const original = cost(lifecycle.executionAttempt);
    const conflicting = cost(lifecycle.executionAttempt, override as Partial<TradeCostEventInput>);
    expect(projectEntry(lifecycle, [original, conflicting])).toEqual({
      status: "TRADE_COST_ACCOUNTING_REJECTED",
      sourceKind: "ENTRY_FILL",
      upstreamStatus: "FILL_APPLIED",
      reason: "CONFLICTING_DUPLICATE_COST_EVENT_ID",
    });
  });

  it.each([
    ["malformed amount", { amount: "wat" }],
    ["zero amount", { amount: "0" }],
    ["invalid schema", { schemaVersion: "OTHER" }],
  ] as const)("rejects %s without throwing or fabricating a Task030A result", (_name, override) => {
    const lifecycle = entryLifecycle(enter());
    const malformed = { ...cost(lifecycle.executionAttempt), ...override } as unknown as TradeCostEvent;
    const result = projectEntry(lifecycle, [malformed]);
    expect(result).toEqual({
      status: "TRADE_COST_ACCOUNTING_REJECTED",
      sourceKind: "ENTRY_FILL",
      upstreamStatus: "FILL_APPLIED",
      reason: "COST_EVENT_DELIVERY_INVALID",
    });
    expect(result).not.toHaveProperty("costAccountingProjection");
  });

  it.each([
    ["COST_EVENT_EXECUTION_ATTEMPT_MISMATCH", { executionAttemptId: "other-attempt" }],
    ["COST_EVENT_INSTRUMENT_MISMATCH", { instrumentId: otherInstrument }],
    ["COST_EVENT_CURRENCY_MISMATCH", { currency: "EUR" }],
    ["COST_EVENT_PRECEDES_ATTEMPT", { effectiveAt: 899 }],
  ] as const)("preserves authoritative %s rejection", (reason, override) => {
    const lifecycle = entryLifecycle(enter());
    const result = projectEntry(lifecycle, [cost(lifecycle.executionAttempt, override)]);
    expect(result).toMatchObject({
      status: "TRADE_COST_ACCOUNTING_REJECTED",
      reason: "AUTHORITATIVE_COST_ACCOUNTING_REJECTED",
      costAccountingProjection: { status: "TRADE_COST_ACCOUNTING_REJECTED", reason },
    });
  });

  it("is independent of observed delivery order", () => {
    const lifecycle = entryLifecycle(enter());
    const first = cost(lifecycle.executionAttempt);
    const second = cost(lifecycle.executionAttempt, {
      costEventId: "C2", costType: "FUNDING", effect: "CREDIT", amount: "0.5", effectiveAt: 1_002,
    });
    const forward = projectEntry(lifecycle, [first, second, first]);
    const reverse = projectEntry(lifecycle, [second, first, first]);
    expect(reverse).toEqual(forward);
  });
});

describe("authoritative checkpoints and preservation", () => {
  it("projects partial, closed, and post-close late costs without inferring position state", () => {
    const entry = enter();
    const protection = protect(entry.attempt);
    const partial = exit(protection.attempt, protection.request, "X1", "1.25", 1_003);
    const c1 = cost(partial.attempt);
    const c2 = cost(partial.attempt, {
      costEventId: "C2", costType: "FUNDING", effect: "CREDIT", amount: "0.50", effectiveAt: 1_002,
    });
    const c3 = cost(partial.attempt, {
      costEventId: "C3", costType: "EXCHANGE_FEE", amount: "0.40", effectiveAt: 1_003,
    });
    const partialResult = expectProjected(projectExit(exitLifecycle(partial), [c1, c2, c3]));
    expect(partialResult.accounting).toMatchObject({
      grossDebitCostAmount: "1.65", grossCreditCostAmount: "0.5", netCostAmount: "1.15",
      positionExposure: { exposureState: "PARTIALLY_EXITED" },
    });

    const closed = exit(partial.attempt, protection.request, "X2", "1.5", 1_007);
    const closedLifecycle = exitLifecycle(closed);
    const c4 = cost(closed.attempt, {
      costEventId: "C4", costType: "BROKER_FEE", amount: "0.10", effectiveAt: 1_007,
    });
    const beforeLate = expectProjected(projectExit(closedLifecycle, [c1, c2, c3, c4]));
    expect(beforeLate.accounting).toMatchObject({
      grossDebitCostAmount: "1.75", grossCreditCostAmount: "0.5", netCostAmount: "1.25",
      positionExposure: { exposureState: "CLOSED" },
    });

    const c5 = cost(closed.attempt, {
      costEventId: "C5", costType: "BORROW_COST", amount: "0.25", effectiveAt: 1_010,
    });
    const afterLate = expectProjected(projectExit(closedLifecycle, [c1, c2, c3, c4, c5]));
    expect(afterLate.accounting).toMatchObject({
      grossDebitCostAmount: "2", grossCreditCostAmount: "0.5", netCostAmount: "1.5",
      executionAccountingAsOf: 1_007, costAccountingAsOf: 1_010,
      positionExposure: { exposureState: "CLOSED" },
    });
  });

  it("projects identical cost arithmetic for real LONG and SHORT lifecycles", () => {
    const longLifecycle = entryLifecycle(enter("BUY"));
    const shortLifecycle = entryLifecycle(enter("SELL"));
    const eventsFor = (attempt: ExecutionAttempt) => [
      cost(attempt, { costEventId: "SIDE-C1" }),
      cost(attempt, { costEventId: "SIDE-C2", costType: "FUNDING", effect: "CREDIT", amount: "0.25" }),
    ];
    const long = expectProjected(projectEntry(longLifecycle, eventsFor(longLifecycle.executionAttempt)));
    const short = expectProjected(projectEntry(shortLifecycle, eventsFor(shortLifecycle.executionAttempt)));
    expect(long.accounting.netCostAmount).toBe("1");
    expect(short.accounting.netCostAmount).toBe("1");
    expect(long.accounting.positionExposure.direction).toBe("LONG");
    expect(short.accounting.positionExposure.direction).toBe("SHORT");
  });

  it("preserves Task030A and nested Task027A/PositionExposure rejection objects", () => {
    const entered = enter();
    const malformedAttempt = Object.freeze({ ...entered.attempt, filledEntryQuantity: "1" }) as ExecutionAttempt;
    const lifecycle = Object.freeze({ ...entryLifecycle(entered), executionAttempt: malformedAttempt });
    const result = projectEntry(lifecycle);
    expect(result).toMatchObject({
      status: "TRADE_COST_ACCOUNTING_REJECTED",
      reason: "AUTHORITATIVE_COST_ACCOUNTING_REJECTED",
      costAccountingProjection: {
        status: "TRADE_COST_ACCOUNTING_REJECTED",
        reason: "REALIZED_ACCOUNTING_REJECTED",
        realizedAccountingProjection: {
          status: "REALIZED_ACCOUNTING_REJECTED",
          reason: "POSITION_EXPOSURE_REJECTED",
          positionProjection: { status: "POSITION_EXPOSURE_REJECTED" },
        },
      },
    });
  });

  it("preserves authoritative nested references and freezes every owned result boundary", () => {
    const lifecycle = entryLifecycle(enter());
    const delivery = cost(lifecycle.executionAttempt);
    const result = expectProjected(projectEntry(lifecycle, [delivery]));
    expect(result.accounting.positionExposure).toBe(result.accounting.realizedAccounting.positionExposure);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.accounting)).toBe(true);
    expect(Object.isFrozen(result.accounting.realizedAccounting)).toBe(true);
    expect(Object.isFrozen(result.accounting.positionExposure)).toBe(true);
  });

  it("does not mutate lifecycle, attempt, spec, delivery array, or delivery objects", () => {
    const lifecycle = entryLifecycle(enter());
    const accountingSpec = spec();
    const delivery = cost(lifecycle.executionAttempt);
    const deliveries = Object.freeze([delivery]);
    const before = [lifecycle, lifecycle.executionAttempt, accountingSpec, deliveries, delivery].map(JSON.stringify);
    projectEntry(lifecycle, deliveries, accountingSpec);
    expect([lifecycle, lifecycle.executionAttempt, accountingSpec, deliveries, delivery].map(JSON.stringify)).toEqual(before);
    expect(deliveries[0]).toBe(delivery);
  });

  it("is deterministic across repeats and fresh engine instances", () => {
    const lifecycle = entryLifecycle(enter());
    const deliveries = [cost(lifecycle.executionAttempt)];
    const input = Object.freeze({
      sourceKind: "ENTRY_FILL" as const,
      fillLifecycle: lifecycle,
      accountingSpec: spec(),
      observedCostEvents: Object.freeze(deliveries),
    });
    const first = projectRealtimeTradeCostAccounting(input);
    expect(projectRealtimeTradeCostAccounting(input)).toEqual(first);
    expect(new RealtimeTradeCostAccountingEngine().project(input)).toEqual(first);
  });

  it("exposes no alternate attempt, monetary overrides, rates, PnL, or portfolio inputs", () => {
    const lifecycle = entryLifecycle(enter());
    const input = {
      sourceKind: "ENTRY_FILL" as const,
      fillLifecycle: lifecycle,
      accountingSpec: spec(),
      observedCostEvents: [cost(lifecycle.executionAttempt)],
    };
    for (const field of [
      "executionAttempt", "realizedAccounting", "positionExposure", "grossDebitCostAmount",
      "grossCreditCostAmount", "netCostAmount", "commissionRate", "fundingRate", "notional",
      "netRealizedPnl", "netTotalPnl", "tax", "fx", "slippage", "portfolio", "accountEquity",
    ]) expect(input).not.toHaveProperty(field);
  });

  it("returns the authoritative accounting object unchanged from Task030A semantics", () => {
    const lifecycle = entryLifecycle(enter());
    const delivery = cost(lifecycle.executionAttempt);
    const realtime = expectProjected(projectEntry(lifecycle, [delivery]));
    const authoritative = projectTradeCostAccounting(lifecycle.executionAttempt, spec(), [delivery]);
    expect(authoritative.status).toBe("TRADE_COST_ACCOUNTING_PROJECTED");
    if (authoritative.status !== "TRADE_COST_ACCOUNTING_PROJECTED") throw new Error("authoritative projection failed");
    expect(realtime.accounting).toEqual(authoritative.accounting);
    expect(realtime.accounting.realizedAccounting.positionExposure).toBe(realtime.accounting.positionExposure);
  });
});
