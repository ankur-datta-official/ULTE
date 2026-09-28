import { describe, expect, it, vi } from "vitest";
import { ArrayHistoricalEventSource, HistoricalReplayEngine } from "@ulte/backtest-engine";
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
import { createInstrumentId, parseTimeframe, positiveDecimalString, unixMs } from "@ulte/instrument-model";
import {
  createLiveMarketDataSourceDescriptor,
  createLiveTradeEvent,
  LiveTradeIngestionEngine,
  sourceEpochId,
} from "@ulte/live-market-data-engine";
import {
  createMarketDataEvent,
  createTradeTick,
  marketDataSource,
  type MarketDataEvent,
  type TradeTick,
} from "@ulte/market-data";
import { createLinearInstrumentSizingSpec } from "@ulte/position-sizing-engine";
import type { ExitFillAppliedResult } from "@ulte/realtime-execution-exit-fill-engine";
import type { FillAppliedResult } from "@ulte/realtime-execution-fill-engine";
import { projectRealtimeTradeValuation } from "@ulte/realtime-trade-valuation-engine";
import {
  projectRealtimeTradePerformance,
  type RealtimeTradePerformanceResult,
} from "./index.js";

const instrument = createInstrumentId({ venue: "TEST", venueSymbol: "ABC", instrumentKind: "CFD" });
const source = marketDataSource("task-029b-integration-feed");
const capabilities = createAdapterCapabilities({
  supportsClientIdempotency: false,
  supportsCloseOnlyExit: true,
  supportsNativeBracketProtection: false,
  supportsProtectionModification: true,
  supportsOrderCancellation: true,
  supportsPartialFillReporting: true,
});
const accountingSpec = createLinearInstrumentSizingSpec({
  valuationModel: "LINEAR_PRICE_PNL",
  instrumentId: instrument,
  pnlCurrency: "USD",
  quantityUnit: "contracts",
  quantityStep: "0.01",
  minimumQuantity: "0.01",
  maximumQuantity: "100",
  pnlValuePerPriceUnitPerQuantity: "1",
});

function plan(): ReadyExecutionPlan {
  const quantity = positiveDecimalString("2.75");
  return Object.freeze({
    status: "EXECUTION_PLAN_READY",
    schemaVersion: "EXECUTION_PLAN_V1",
    executionPlanId: "task-029b-plan",
    tradeIntentId: "task-029b-intent",
    candidateId: "task-029b-candidate",
    instrumentId: instrument,
    intentAsOf: unixMs(800),
    marketSnapshotAsOf: unixMs(850),
    preparedAsOf: unixMs(900),
    direction: "UP",
    entrySide: "BUY",
    exitSide: "SELL",
    quantity,
    quantityUnit: "contracts",
    entryInstruction: Object.freeze({
      kind: "ENTRY_LIMIT", side: "BUY", price: positiveDecimalString("100"), quantity, positionEffect: "OPEN",
    }),
    protectiveStopInstruction: Object.freeze({
      kind: "PROTECTIVE_STOP_TRIGGER", side: "SELL", triggerPrice: positiveDecimalString("90"), quantity,
      positionEffect: "CLOSE",
    }),
    profitTargetInstruction: Object.freeze({
      kind: "PROFIT_TARGET_LIMIT", side: "SELL", price: positiveDecimalString("130"), quantity,
      positionEffect: "CLOSE",
    }),
    priceTick: positiveDecimalString("0.01"),
    quantityStep: positiveDecimalString("0.01"),
    bidAtPreparation: positiveDecimalString("99.99"),
    askAtPreparation: positiveDecimalString("100"),
    intentAgeMs: 100,
    quoteAgeMs: 50,
    entryDeviationBps: "0",
    approvedRiskAmount: positiveDecimalString("27.5"),
    actualRiskAmount: positiveDecimalString("27.5"),
    netRewardRiskBps: "30000",
  });
}

function working(): ExecutionAttempt {
  const created = createExecutionAttempt(plan());
  if (created.status !== "EXECUTION_ATTEMPT_READY") throw new Error("attempt creation failed");
  const submitted = requestEntrySubmission(created, capabilities);
  if (submitted.status !== "ENTRY_SUBMISSION_READY") throw new Error("entry request failed");
  const acknowledged = acknowledgeEntrySubmission(submitted.attempt, {
    executionAttemptId: created.executionAttemptId,
    idempotencyKey: submitted.request.idempotencyKey,
    adapterOrderId: "task-029b-order",
    acknowledgedAt: 1_000,
  });
  if (acknowledged.status !== "EXECUTION_ATTEMPT_UPDATED") throw new Error("acknowledgement failed");
  return acknowledged.attempt;
}

function applyEntry(attempt: ExecutionAttempt) {
  const fill = createFillEvent({
    executionAttemptId: attempt.executionAttemptId,
    adapterOrderId: "task-029b-order",
    fillId: "task-029b-entry",
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
    exitSide: "SELL",
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
): FillAppliedResult {
  return Object.freeze({
    status: "FILL_APPLIED",
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
): ExitFillAppliedResult {
  return Object.freeze({
    status: "EXIT_FILL_APPLIED",
    preparationCycleId: "cycle-1",
    protectionAsOf: unixMs(1_002),
    observationAsOf: exitFill.filledAt,
    exitFill,
    executionAttempt: attempt,
    transitionResult: transition,
  });
}

interface LifecycleCheckpoints {
  readonly entry: FillAppliedResult;
  readonly partial: ExitFillAppliedResult;
  readonly closed: ExitFillAppliedResult;
}

function lifecycleCheckpoints(): LifecycleCheckpoints {
  const entry = applyEntry(working());
  const protectedEntry = protect(entry.attempt);
  const partial = applyExit(protectedEntry.attempt, protectedEntry.request, "exit-1", "1.25", "105", 1_003);
  const closed = applyExit(partial.attempt, protectedEntry.request, "exit-2", "1.5", "120", 1_004);
  return Object.freeze({
    entry: entryResult(entry.attempt, entry.fill, entry.transition),
    partial: exitResult(partial.attempt, partial.exitFill, partial.transition),
    closed: exitResult(closed.attempt, closed.exitFill, closed.transition),
  });
}

function marks(): readonly MarketDataEvent<TradeTick>[] {
  return Object.freeze([
    ["105", 2_000],
    ["110", 2_010],
    ["110", 2_020],
    ["130", 2_030],
  ].map(([price, eventTime]) => createMarketDataEvent({
    instrumentId: instrument,
    source,
    eventTime: Number(eventTime),
    receivedAt: Number(eventTime) + 1,
    payload: createTradeTick({ price: String(price), quantity: "1", side: "UNKNOWN" }),
    quality: ["LIVE"],
  })));
}

const effects = {
  submitEntry: vi.fn(),
  submitProtection: vi.fn(),
  cancelEntry: vi.fn(),
  repository: new Map<string, unknown>(),
};

function effectCounts() {
  return {
    submitEntry: effects.submitEntry.mock.calls.length,
    submitProtection: effects.submitProtection.mock.calls.length,
    cancelEntry: effects.cancelEntry.mock.calls.length,
    repositoryRecords: effects.repository.size,
  };
}

function projectCheckpoint(
  lifecycle: LifecycleCheckpoints,
  markSource: MarketDataEvent<TradeTick>,
  index: number,
): RealtimeTradePerformanceResult {
  const realtimeValuation = index < 2
    ? projectRealtimeTradeValuation({
        sourceKind: "ENTRY_FILL", fillLifecycle: lifecycle.entry, accountingSpec, markSource,
      })
    : projectRealtimeTradeValuation({
        sourceKind: "EXIT_FILL",
        exitFillLifecycle: index === 2 ? lifecycle.partial : lifecycle.closed,
        accountingSpec,
        markSource,
      });
  const before = effectCounts();
  const result = projectRealtimeTradePerformance(realtimeValuation);
  expect(effectCounts()).toEqual(before);
  return result;
}

function historicalProjection(lifecycle: LifecycleCheckpoints, events: readonly MarketDataEvent<TradeTick>[]) {
  const outputs: RealtimeTradePerformanceResult[] = [];
  const observed: MarketDataEvent<TradeTick>[] = [];
  const replay = new HistoricalReplayEngine(new ArrayHistoricalEventSource(events));
  const run = replay.run({
    onEvent(event, context): void {
      expect(observed).toHaveLength(context.eventIndex);
      observed.push(event);
      outputs.push(projectCheckpoint(lifecycle, event, context.eventIndex));
    },
  });
  expect(run.processedEventCount).toBe(events.length);
  return Object.freeze(outputs);
}

function liveProjection(lifecycle: LifecycleCheckpoints, events: readonly MarketDataEvent<TradeTick>[]) {
  const outputs: RealtimeTradePerformanceResult[] = [];
  const ingestion = new LiveTradeIngestionEngine({
    source: createLiveMarketDataSourceDescriptor({
      sourceId: source,
      mode: "LIVE",
      capabilities: ["TRADE"],
      sequenceSemantics: "NONE",
    }),
    instrumentId: instrument,
    initialEpochId: sourceEpochId("task-029b-epoch"),
    initialEpochTime: unixMs(0),
    alignments: [{ timeframe: parseTimeframe("1m"), anchorTime: unixMs(0) }],
    deduplicationWindowSize: 16,
  });
  events.forEach((event, index) => {
    const liveEvent = createLiveTradeEvent({ sourceEventId: `task-029b-mark-${index}`, event });
    const accepted = ingestion.ingest(
      liveEvent,
      unixMs(event.receivedAt),
    );
    expect(accepted.status).toBe("ACCEPTED");
    if (accepted.status !== "ACCEPTED") throw new Error("live event rejected");
    outputs.push(projectCheckpoint(lifecycle, liveEvent.event, index));
  });
  return Object.freeze(outputs);
}

describe("historical/live equivalence through Task028B and Task029B", () => {
  it("projects equal open, no-fill revaluation, partial, and closed performance without lookahead or side effects", () => {
    const events = marks();
    const historical = historicalProjection(lifecycleCheckpoints(), events);
    const live = liveProjection(lifecycleCheckpoints(), events);
    expect(historical).toEqual(live);
    expect(historical).toHaveLength(4);
    expect(historical[0]).toMatchObject({
      status: "TRADE_PERFORMANCE_PROJECTED",
      snapshot: { grossTotalPnl: "13.75", positionExposure: { exposureState: "OPEN" } },
    });
    expect(historical[1]).toMatchObject({
      status: "TRADE_PERFORMANCE_PROJECTED",
      snapshot: { grossTotalPnl: "27.5", positionExposure: { exposureState: "OPEN" } },
    });
    expect(historical[2]).toMatchObject({
      status: "TRADE_PERFORMANCE_PROJECTED",
      snapshot: { grossTotalPnl: "21.25", positionExposure: { exposureState: "PARTIALLY_EXITED" } },
    });
    expect(historical[3]).toMatchObject({
      status: "TRADE_PERFORMANCE_PROJECTED",
      snapshot: { grossTotalPnl: "36.25", positionExposure: { exposureState: "CLOSED" } },
    });
    expect(effectCounts()).toEqual({
      submitEntry: 0,
      submitProtection: 0,
      cancelEntry: 0,
      repositoryRecords: 0,
    });
  });
});
