import { describe, expect, it, vi } from "vitest";
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
import { createMarketDataEvent, createTradeTick, marketDataSource } from "@ulte/market-data";
import { createLinearInstrumentSizingSpec } from "@ulte/position-sizing-engine";
import type { ExitFillAppliedResult } from "@ulte/realtime-execution-exit-fill-engine";
import type { FillAppliedResult } from "@ulte/realtime-execution-fill-engine";
import { projectRealtimeTradeCostAccounting } from "@ulte/realtime-trade-cost-accounting-engine";
import { projectRealtimeTradePerformance } from "@ulte/realtime-trade-performance-engine";
import { projectRealtimeTradeValuation } from "@ulte/realtime-trade-valuation-engine";
import { createTradeCostEvent, type TradeCostEvent } from "@ulte/trade-cost-accounting-engine";
import { projectRealtimeNetTradePerformance } from "./index.js";

const instrument = createInstrumentId({ venue: "TEST", venueSymbol: "TASK-031B", instrumentKind: "CFD" });
const marketSource = marketDataSource("task-031b-observed-feed");
const capabilities = createAdapterCapabilities({
  supportsClientIdempotency: false, supportsCloseOnlyExit: true,
  supportsNativeBracketProtection: false, supportsProtectionModification: true,
  supportsOrderCancellation: true, supportsPartialFillReporting: true,
});
const accountingSpec = createLinearInstrumentSizingSpec({
  valuationModel: "LINEAR_PRICE_PNL", instrumentId: instrument, pnlCurrency: "USD",
  quantityUnit: "contracts", quantityStep: "0.01", minimumQuantity: "0.01",
  maximumQuantity: "100", pnlValuePerPriceUnitPerQuantity: "1",
});

function plan(): ReadyExecutionPlan {
  const quantity = positiveDecimalString("2.75");
  return Object.freeze({
    status: "EXECUTION_PLAN_READY", schemaVersion: "EXECUTION_PLAN_V2",
    executionPlanId: "task-031b-plan", tradeIntentId: "task-031b-intent",
    candidateId: "task-031b-candidate", instrumentId: instrument,
    intentAsOf: unixMs(800), marketSnapshotAsOf: unixMs(850), preparedAsOf: unixMs(900),
    direction: "UP", entrySide: "BUY", exitSide: "SELL", quantity, quantityUnit: "contracts", accountCurrency: currencyCode("USD"),
    entryInstruction: Object.freeze({ kind: "ENTRY_LIMIT", side: "BUY", price: positiveDecimalString("100"), quantity, positionEffect: "OPEN" }),
    protectiveStopInstruction: Object.freeze({ kind: "PROTECTIVE_STOP_TRIGGER", side: "SELL", triggerPrice: positiveDecimalString("90"), quantity, positionEffect: "CLOSE" }),
    profitTargetInstruction: Object.freeze({ kind: "PROFIT_TARGET_LIMIT", side: "SELL", price: positiveDecimalString("130"), quantity, positionEffect: "CLOSE" }),
    priceTick: positiveDecimalString("0.01"), quantityStep: positiveDecimalString("0.01"),
    bidAtPreparation: positiveDecimalString("99.99"), askAtPreparation: positiveDecimalString("100"),
    intentAgeMs: 100, quoteAgeMs: 50, entryDeviationBps: "0",
    approvedRiskAmount: positiveDecimalString("27.5"), actualRiskAmount: positiveDecimalString("27.5"),
    netRewardRiskBps: "30000",
  });
}

function working(): ExecutionAttempt {
  const created = createExecutionAttempt(plan());
  if (created.status !== "EXECUTION_ATTEMPT_READY") throw new Error("attempt creation failed");
  const submitted = requestEntrySubmission(created, capabilities);
  if (submitted.status !== "ENTRY_SUBMISSION_READY") throw new Error("entry request failed");
  const acknowledged = acknowledgeEntrySubmission(submitted.attempt, {
    executionAttemptId: created.executionAttemptId, idempotencyKey: submitted.request.idempotencyKey,
    adapterOrderId: "task-031b-order", acknowledgedAt: 1_000,
  });
  if (acknowledged.status !== "EXECUTION_ATTEMPT_UPDATED") throw new Error("acknowledgement failed");
  return acknowledged.attempt;
}

function entryLifecycle(): FillAppliedResult {
  const current = working();
  const fill = createFillEvent({ executionAttemptId: current.executionAttemptId,
    adapterOrderId: "task-031b-order", fillId: "entry-1", filledQuantity: "2.75",
    fillPrice: "100", filledAt: 1_001 });
  const transition = applyEntryFill(current, fill);
  if (transition.status !== "EXECUTION_ATTEMPT_UPDATED") throw new Error("entry failed");
  return Object.freeze({
    status: "FILL_APPLIED", preparationCycleId: "cycle-1", submissionAsOf: unixMs(999),
    observationAsOf: fill.filledAt, fill, executionAttempt: transition.attempt, transitionResult: transition,
  });
}

function protectLifecycle(attempt: ExecutionAttempt): { readonly attempt: ExecutionAttempt; readonly request: ProtectionRequest } {
  const requested = requestProtection(attempt);
  if (requested.status !== "PROTECTION_REQUEST_READY") throw new Error("protection request failed");
  const acknowledged = acknowledgeProtection(requested.attempt, {
    executionAttemptId: attempt.executionAttemptId, protectionRequestId: requested.request.protectionRequestId,
    idempotencyKey: requested.request.idempotencyKey,
    protectedQuantity: requested.request.targetCumulativeProtectedQuantity, acknowledgedAt: 1_002,
  });
  if (acknowledged.status !== "EXECUTION_ATTEMPT_UPDATED") throw new Error("protection failed");
  return { attempt: acknowledged.attempt, request: requested.request };
}

function exitLifecycle(
  attempt: ExecutionAttempt,
  request: ProtectionRequest,
  fillId: string,
  quantity: string,
  at: number,
): ExitFillAppliedResult {
  const exitFill = createExitFillEvent({
    executionAttemptId: attempt.executionAttemptId, protectionRequestId: request.protectionRequestId,
    exitSide: "SELL", exitLeg: "PROFIT_TARGET", fillId, filledQuantity: quantity,
    fillPrice: "105", filledAt: at,
  });
  const transition: ExecutionUpdateResult = applyExitFill(attempt, exitFill);
  if (transition.status !== "EXECUTION_ATTEMPT_UPDATED") throw new Error("exit failed");
  return Object.freeze({
    status: "EXIT_FILL_APPLIED", preparationCycleId: "cycle-1", protectionAsOf: unixMs(1_002),
    observationAsOf: exitFill.filledAt, exitFill, executionAttempt: transition.attempt, transitionResult: transition,
  });
}

function mark(price: string, at: number) {
  return createMarketDataEvent({
    instrumentId: instrument, source: marketSource, eventTime: at, receivedAt: at,
    payload: createTradeTick({ price, quantity: "1", side: "UNKNOWN" }), quality: ["LIVE"],
  });
}

function cost(
  attemptId: string,
  id: string,
  effect: "DEBIT" | "CREDIT",
  amount: string,
  effectiveAt: number,
): TradeCostEvent {
  return createTradeCostEvent({
    costEventId: id, executionAttemptId: attemptId, instrumentId: instrument,
    costType: effect === "CREDIT" ? "FUNDING" : "COMMISSION", effect, amount,
    currency: "USD", effectiveAt, source: "OBSERVED_PROVIDER",
  });
}

const sideEffects = { broker: vi.fn(), repository: vi.fn(), network: vi.fn(), audit: vi.fn() };
function counts() { return Object.fromEntries(Object.entries(sideEffects).map(([key, fn]) => [key, fn.mock.calls.length])); }

describe("real Task029B + Task030B outputs through Task031B", () => {
  it("supports independent evidence updates, partial/closed lifecycle, and late settlement without lookahead", () => {
    const entry = entryLifecycle();
    const protectedEntry = protectLifecycle(entry.executionAttempt);
    const partial = exitLifecycle(protectedEntry.attempt, protectedEntry.request, "exit-1", "1.25", 1_003);
    const closed = exitLifecycle(partial.executionAttempt, protectedEntry.request, "exit-2", "1.5", 1_007);
    const attemptId = entry.executionAttempt.executionAttemptId;
    const c1 = cost(attemptId, "C1", "DEBIT", "1.25", 1_001);
    const c2 = cost(attemptId, "C2", "CREDIT", "0.50", 1_002);
    const c3 = cost(attemptId, "C3", "DEBIT", "0.40", 1_003);
    const c4 = cost(attemptId, "C4", "DEBIT", "0.10", 1_007);
    const c5 = cost(attemptId, "C5", "DEBIT", "0.25", 1_010);

    const gross105 = projectRealtimeTradePerformance(projectRealtimeTradeValuation({
      sourceKind: "ENTRY_FILL", fillLifecycle: entry, accountingSpec, markSource: mark("105", 2_000),
    }));
    const gross110 = projectRealtimeTradePerformance(projectRealtimeTradeValuation({
      sourceKind: "ENTRY_FILL", fillLifecycle: entry, accountingSpec, markSource: mark("110", 2_010),
    }));
    const cost125 = projectRealtimeTradeCostAccounting({
      sourceKind: "ENTRY_FILL", fillLifecycle: entry, accountingSpec, observedCostEvents: [c1],
    });
    const cost075 = projectRealtimeTradeCostAccounting({
      sourceKind: "ENTRY_FILL", fillLifecycle: entry, accountingSpec, observedCostEvents: [c1, c2],
    });
    expect(gross105).toMatchObject({ status: "TRADE_PERFORMANCE_PROJECTED", snapshot: { grossTotalPnl: "13.75" } });
    expect(cost125).toMatchObject({ status: "TRADE_COST_ACCOUNTING_PROJECTED", accounting: { netCostAmount: "1.25" } });

    const beforeOpen = counts();
    const open = projectRealtimeNetTradePerformance(gross105, cost125);
    const marketOnly = projectRealtimeNetTradePerformance(gross110, cost125);
    const costOnly = projectRealtimeNetTradePerformance(gross105, cost075);
    const both = projectRealtimeNetTradePerformance(gross110, cost075);
    expect(counts()).toEqual(beforeOpen);
    expect(open).toMatchObject({ snapshot: { netTotalPnl: "12.5" } });
    expect(marketOnly).toMatchObject({ snapshot: { netTotalPnl: "26.25" } });
    expect(costOnly).toMatchObject({ snapshot: { netTotalPnl: "13" } });
    expect(both).toMatchObject({ snapshot: { netTotalPnl: "26.75" } });

    const partialGross = projectRealtimeTradePerformance(projectRealtimeTradeValuation({
      sourceKind: "EXIT_FILL", exitFillLifecycle: partial, accountingSpec, markSource: mark("110", 1_004),
    }));
    const partialCost = projectRealtimeTradeCostAccounting({
      sourceKind: "EXIT_FILL", exitFillLifecycle: partial, accountingSpec, observedCostEvents: [c1, c2, c3],
    });
    expect(projectRealtimeNetTradePerformance(partialGross, partialCost)).toMatchObject({
      snapshot: { netTotalPnl: "20.1", positionExposure: { exposureState: "PARTIALLY_EXITED" } },
    });

    const closedGross = projectRealtimeTradePerformance(projectRealtimeTradeValuation({
      sourceKind: "EXIT_FILL", exitFillLifecycle: closed, accountingSpec, markSource: mark("130", 1_007),
    }));
    const closedCost = projectRealtimeTradeCostAccounting({
      sourceKind: "EXIT_FILL", exitFillLifecycle: closed, accountingSpec, observedCostEvents: [c1, c2, c3, c4],
    });
    const lateCost = projectRealtimeTradeCostAccounting({
      sourceKind: "EXIT_FILL", exitFillLifecycle: closed, accountingSpec, observedCostEvents: [c1, c2, c3, c4, c5],
    });
    const beforeLate = projectRealtimeNetTradePerformance(closedGross, closedCost);
    const afterLate = projectRealtimeNetTradePerformance(closedGross, lateCost);
    expect(beforeLate).toMatchObject({ snapshot: { grossTotalPnl: "13.75", netTotalPnl: "12.5" } });
    expect(afterLate).toMatchObject({
      snapshot: { netTotalPnl: "12.25", valuationAsOf: 1_007, costAccountingAsOf: 1_010,
        positionExposure: { exposureState: "CLOSED" } },
    });
    if (open.status !== "NET_TRADE_PERFORMANCE_PROJECTED") throw new Error("open projection failed");
    expect(open.snapshot.grossPerformance).toBe(gross105.status === "TRADE_PERFORMANCE_PROJECTED" ? gross105.snapshot : undefined);
    expect(open.snapshot.costAccounting).toBe(cost125.status === "TRADE_COST_ACCOUNTING_PROJECTED" ? cost125.accounting : undefined);
    expect(open.snapshot.positionExposure).toBe(open.snapshot.grossPerformance.positionExposure);
    expect(counts()).toEqual(beforeOpen);
  });
});
