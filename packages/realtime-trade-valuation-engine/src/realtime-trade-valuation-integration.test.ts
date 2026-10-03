import { describe, expect, it, vi } from "vitest";
import { ArrayHistoricalEventSource, HistoricalReplayEngine } from "@ulte/backtest-engine";
import {
  brokerAdapterId,
  compareIdempotencyClaim,
  credentialProfileRef,
  createBrokerAdapterDescriptor,
  createBrokerAdapterRegistry,
  createIdempotencyRecord,
  type BrokerAdapter,
  type IdempotencyClaimInput,
  type IdempotencyClaimResult,
  classifyIdempotencyOutcome,
  type IdempotencyOutcomeInput,
  type IdempotencyOutcomeResult,
  type IdempotencyRecord,
  type IdempotencyRepository,
} from "@ulte/broker-adapters";
import {
  createAdapterCapabilities,
  createEntryAcknowledgement,
  createExitFillEvent,
  createFillEvent,
  createProtectionAcknowledgement,
  type EntryCancellationRequest,
  type EntrySubmissionRequest,
  type ProtectionRequest,
} from "@ulte/execution-engine";
import type { ReadyExecutionPlan } from "@ulte/execution-preparation-engine";
import {
  currencyCode, createInstrumentId, parseTimeframe, positiveDecimalString, unixMs } from "@ulte/instrument-model";
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
import { RealtimeExecutionExitFillEngine } from "@ulte/realtime-execution-exit-fill-engine";
import {
  applyRealtimeExecutionFill,
  initializeRealtimeExecutionFillLifecycle,
  type FillAppliedResult,
} from "@ulte/realtime-execution-fill-engine";
import {
  createPreparationCycleId,
  createPreparationProfileId,
  type ExecutionPreparedResult,
} from "@ulte/realtime-execution-preparation-engine";
import { RealtimeExecutionProtectionEngine } from "@ulte/realtime-execution-protection-engine";
import { RealtimeExecutionProtectionLifecycleEngine } from "@ulte/realtime-execution-protection-lifecycle-engine";
import { RealtimeExecutionSubmissionEngine } from "@ulte/realtime-execution-submission-engine";
import {
  RealtimeTradeValuationEngine,
  type RealtimeTradeValuationResult,
} from "./index.js";

const instrument = createInstrumentId({ venue: "TEST", venueSymbol: "ABC", instrumentKind: "CFD" });
const source = marketDataSource("task-028b-integration-feed");
const capabilities = createAdapterCapabilities({
  supportsClientIdempotency: true,
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
    schemaVersion: "EXECUTION_PLAN_V2",
    executionPlanId: "task-028b-plan",
    tradeIntentId: "task-028b-intent",
    candidateId: "task-028b-candidate",
    instrumentId: instrument,
    intentAsOf: unixMs(800),
    marketSnapshotAsOf: unixMs(850),
    preparedAsOf: unixMs(900),
    direction: "UP",
    entrySide: "BUY",
    exitSide: "SELL",
    quantity,
    quantityUnit: "contracts", accountCurrency: currencyCode("USD"),
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

class MemoryRepository implements IdempotencyRepository {
  readonly records = new Map<string, IdempotencyRecord>();

  async claim(input: IdempotencyClaimInput): Promise<IdempotencyClaimResult> {
    const key = `${input.adapterId}\u0000${input.idempotencyKey}`;
    const existing = this.records.get(key);
    if (existing !== undefined) {
      const comparison = compareIdempotencyClaim(existing, input);
      if (comparison.status === "CONFLICT") return { status: "CONFLICT", reason: comparison.reason, record: existing };
      return { status: "EXISTING_SAME_REQUEST", record: existing };
    }
    const record = createIdempotencyRecord({
      ...input,
      status: "CLAIMED",
      createdAt: input.claimedAt,
      updatedAt: input.claimedAt,
    });
    this.records.set(key, record);
    return { status: "CLAIMED_NEW", record };
  }

  async read(adapterId: ReturnType<typeof brokerAdapterId>, idempotencyKey: string) {
    return this.records.get(`${adapterId}\u0000${idempotencyKey}`);
  }

  async recordOutcome(input: IdempotencyOutcomeInput): Promise<IdempotencyOutcomeResult> {
    const entry = [...this.records.entries()].find(([, record]) =>
      record.adapterId === input.adapterId && record.idempotencyKey === input.idempotencyKey);
    if (entry === undefined) throw new Error("outcome without claim");
    const [key, current] = entry;
    if (current.environment !== input.environment) throw new Error("environment conflict");
    if (current.requestFingerprint !== input.requestFingerprint) throw new Error("fingerprint conflict");
    const result = classifyIdempotencyOutcome(current, input);
    if (result.status === "APPLIED_TRANSITION" || result.status === "APPLIED_ENRICHMENT") {
      this.records.set(key, result.record);
    }
    return result;
  }
}

function adapter(): BrokerAdapter {
  return {
    descriptor: createBrokerAdapterDescriptor({
      adapterId: "task-028b-adapter",
      environment: "SANDBOX",
      credentialProfileRef: "task-028b-credentials",
      capabilities,
    }),
    capabilities,
    submitEntry: vi.fn(async (request: EntrySubmissionRequest) => createEntryAcknowledgement({
      executionAttemptId: request.executionAttemptId,
      idempotencyKey: request.idempotencyKey,
      adapterOrderId: "task-028b-order",
      acknowledgedAt: 1_000,
    })),
    submitProtection: vi.fn(async (request: ProtectionRequest) => createProtectionAcknowledgement({
      executionAttemptId: request.executionAttemptId,
      protectionRequestId: request.protectionRequestId,
      idempotencyKey: request.idempotencyKey,
      protectedQuantity: request.targetCumulativeProtectedQuantity,
      acknowledgedAt: 1_002,
    })),
    cancelEntry: vi.fn(async (_request: EntryCancellationRequest) => { throw new Error("forbidden"); }),
  };
}

function prepared(): ExecutionPreparedResult {
  const profileId = createPreparationProfileId(["task-028b"]);
  const decisionCycleId = "task-028b-decision" as ExecutionPreparedResult["decisionCycleId"];
  return Object.freeze({
    status: "EXECUTION_PREPARED",
    analysisCycleId: "task-028b-analysis" as ExecutionPreparedResult["analysisCycleId"],
    decisionCycleId,
    preparationCycleId: createPreparationCycleId(decisionCycleId, profileId),
    preparationProfileId: profileId,
    analysisAsOf: unixMs(850),
    triggerCloseTime: unixMs(850),
    preparationAsOf: unixMs(900),
    tradeIntentResult: Object.freeze({}) as ExecutionPreparedResult["tradeIntentResult"],
    executionPreparationResult: plan(),
  });
}

interface LifecycleCheckpoints {
  readonly entry: FillAppliedResult;
  readonly partial: ExitFillAppliedResult;
  readonly closed: ExitFillAppliedResult;
  readonly effects: Effects;
}

async function lifecycleCheckpoints(): Promise<LifecycleCheckpoints> {
  const repository = new MemoryRepository();
  const broker = adapter();
  const registry = createBrokerAdapterRegistry([broker]);
  const submission = await new RealtimeExecutionSubmissionEngine(
    { maxPreparedPlanAgeMs: 100 },
    { adapterRegistry: registry, idempotencyRepository: repository },
  ).submit({
    preparation: prepared(),
    context: {
      executionEnvironment: "SANDBOX",
      adapterId: brokerAdapterId("task-028b-adapter"),
      credentialProfileRef: credentialProfileRef("task-028b-credentials"),
      submissionAsOf: 999,
    },
  });
  if (submission.status !== "SUBMISSION_CONFIRMED") throw new Error("submission failed");
  const initialized = initializeRealtimeExecutionFillLifecycle(submission);
  if (initialized.status !== "FILL_LIFECYCLE_INITIALIZED") throw new Error("fill initialization failed");
  const entryFill = createFillEvent({
    executionAttemptId: initialized.executionAttempt.executionAttemptId,
    adapterOrderId: "task-028b-order",
    fillId: "task-028b-entry",
    filledQuantity: "2.75",
    fillPrice: "100",
    filledAt: 1_001,
  });
  const entry = applyRealtimeExecutionFill({
    submission,
    executionAttempt: initialized.executionAttempt,
    fill: entryFill,
    observationAsOf: 1_001,
  });
  if (entry.status !== "FILL_APPLIED") throw new Error("entry fill failed");

  const protection = await new RealtimeExecutionProtectionEngine({
    adapterRegistry: registry,
    idempotencyRepository: repository,
  }).submit({
    fillLifecycle: entry,
    context: {
      executionEnvironment: "SANDBOX",
      adapterId: brokerAdapterId("task-028b-adapter"),
      credentialProfileRef: credentialProfileRef("task-028b-credentials"),
      protectionAsOf: 1_002,
    },
  });
  if (protection.status !== "PROTECTION_CONFIRMED") throw new Error("protection submission failed");
  const lifecycle = new RealtimeExecutionProtectionLifecycleEngine().apply({
    protectionResult: protection,
    executionAttempt: protection.executionAttempt,
    observationAsOf: 1_002,
  });
  if (lifecycle.status !== "PROTECTION_ACKNOWLEDGEMENT_APPLIED") throw new Error("protection lifecycle failed");

  const partialEvent = createExitFillEvent({
    executionAttemptId: lifecycle.executionAttempt.executionAttemptId,
    protectionRequestId: lifecycle.executionAttempt.acknowledgedProtections[0]!.request.protectionRequestId,
    exitSide: "SELL",
    exitLeg: "PROTECTIVE_STOP",
    fillId: "task-028b-exit-1",
    filledQuantity: "1.25",
    fillPrice: "105",
    filledAt: 1_003,
  });
  const exitEngine = new RealtimeExecutionExitFillEngine();
  const partial = exitEngine.apply({
    protectionLifecycle: lifecycle,
    executionAttempt: lifecycle.executionAttempt,
    exitFill: partialEvent,
    observationAsOf: 1_003,
  });
  if (partial.status !== "EXIT_FILL_APPLIED") throw new Error("partial exit failed");

  const closedEvent = createExitFillEvent({
    executionAttemptId: lifecycle.executionAttempt.executionAttemptId,
    protectionRequestId: lifecycle.executionAttempt.acknowledgedProtections[0]!.request.protectionRequestId,
    exitSide: "SELL",
    exitLeg: "PROFIT_TARGET",
    fillId: "task-028b-exit-2",
    filledQuantity: "1.5",
    fillPrice: "120",
    filledAt: 1_004,
  });
  const closed = exitEngine.apply({
    protectionLifecycle: lifecycle,
    executionAttempt: partial.executionAttempt,
    exitFill: closedEvent,
    observationAsOf: 1_004,
  });
  if (closed.status !== "EXIT_FILL_APPLIED") throw new Error("terminal exit failed");
  return Object.freeze({ entry, partial, closed, effects: { broker, repository } });
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

interface Effects {
  readonly broker: BrokerAdapter;
  readonly repository: MemoryRepository;
}

function counts(state: Effects) {
  return {
    submitEntry: vi.mocked(state.broker.submitEntry).mock.calls.length,
    submitProtection: vi.mocked(state.broker.submitProtection).mock.calls.length,
    cancelEntry: vi.mocked(state.broker.cancelEntry).mock.calls.length,
    repositoryRecords: state.repository.records.size,
  };
}

function projectCheckpoint(
  engine: RealtimeTradeValuationEngine,
  lifecycle: LifecycleCheckpoints,
  markSource: MarketDataEvent<TradeTick>,
  index: number,
  state: Effects,
): RealtimeTradeValuationResult {
  const before = counts(state);
  const result = index < 2
    ? engine.project({ sourceKind: "ENTRY_FILL", fillLifecycle: lifecycle.entry, accountingSpec, markSource })
    : engine.project({
        sourceKind: "EXIT_FILL",
        exitFillLifecycle: index === 2 ? lifecycle.partial : lifecycle.closed,
        accountingSpec,
        markSource,
      });
  expect(counts(state)).toEqual(before);
  return result;
}

function historicalProjection(lifecycle: LifecycleCheckpoints, events: readonly MarketDataEvent<TradeTick>[]) {
  const engine = new RealtimeTradeValuationEngine();
  const state = lifecycle.effects;
  const outputs: RealtimeTradeValuationResult[] = [];
  const observed: MarketDataEvent<TradeTick>[] = [];
  let lastObservedTradeEvent: MarketDataEvent<TradeTick> | undefined;
  const replay = new HistoricalReplayEngine(new ArrayHistoricalEventSource(events));
  const run = replay.run({
    onEvent(event, context): void {
      expect(observed).toHaveLength(context.eventIndex);
      lastObservedTradeEvent = event;
      observed.push(event);
      outputs.push(projectCheckpoint(engine, lifecycle, lastObservedTradeEvent, context.eventIndex, state));
    },
  });
  expect(run.processedEventCount).toBe(events.length);
  expect(observed).toHaveLength(events.length);
  return { outputs: Object.freeze(outputs), state };
}

function liveProjection(lifecycle: LifecycleCheckpoints, events: readonly MarketDataEvent<TradeTick>[]) {
  const engine = new RealtimeTradeValuationEngine();
  const state = lifecycle.effects;
  const outputs: RealtimeTradeValuationResult[] = [];
  let lastObservedTradeEvent: MarketDataEvent<TradeTick> | undefined;
  const ingestion = new LiveTradeIngestionEngine({
    source: createLiveMarketDataSourceDescriptor({
      sourceId: source,
      mode: "LIVE",
      capabilities: ["TRADE"],
      sequenceSemantics: "NONE",
    }),
    instrumentId: instrument,
    initialEpochId: sourceEpochId("task-028b-epoch"),
    initialEpochTime: unixMs(0),
    alignments: [{ timeframe: parseTimeframe("1m"), anchorTime: unixMs(0) }],
    deduplicationWindowSize: 16,
  });
  events.forEach((event, index) => {
    const liveEvent = createLiveTradeEvent({ sourceEventId: `task-028b-mark-${index}`, event });
    const accepted = ingestion.ingest(liveEvent, unixMs(event.receivedAt));
    expect(accepted.status).toBe("ACCEPTED");
    if (accepted.status !== "ACCEPTED") throw new Error("live mark was not accepted");
    lastObservedTradeEvent = liveEvent.event;
    outputs.push(projectCheckpoint(engine, lifecycle, lastObservedTradeEvent, index, state));
  });
  return { outputs: Object.freeze(outputs), state };
}

describe("historical/live equivalence through Task 028B", () => {
  it("projects equal open, no-fill revaluation, partial, and closed snapshots without lookahead or side effects", async () => {
    const events = marks();
    const historical = historicalProjection(await lifecycleCheckpoints(), events);
    const live = liveProjection(await lifecycleCheckpoints(), events);
    expect(historical.outputs).toEqual(live.outputs);
    expect(historical.outputs).toHaveLength(4);
    expect(historical.outputs[0]).toMatchObject({
      status: "UNREALIZED_VALUATION_PROJECTED",
      valuation: {
        markPrice: "105", grossUnrealizedPnl: "13.75",
        realizedAccounting: { positionExposure: { exposureState: "OPEN" } },
      },
    });
    expect(historical.outputs[1]).toMatchObject({
      status: "UNREALIZED_VALUATION_PROJECTED",
      valuation: { markPrice: "110", grossUnrealizedPnl: "27.5" },
    });
    expect(historical.outputs[2]).toMatchObject({
      status: "UNREALIZED_VALUATION_PROJECTED",
      valuation: {
        markPrice: "110", grossUnrealizedPnl: "15", openQuantity: "1.5",
        realizedAccounting: { positionExposure: { exposureState: "PARTIALLY_EXITED" } },
      },
    });
    expect(historical.outputs[3]).toMatchObject({
      status: "UNREALIZED_VALUATION_PROJECTED",
      valuation: {
        markPrice: "130", grossUnrealizedPnl: "0", openQuantity: "0", openLotValuations: [],
        realizedAccounting: { positionExposure: { exposureState: "CLOSED" } },
      },
    });
    if (historical.outputs[0]?.status !== "UNREALIZED_VALUATION_PROJECTED"
      || historical.outputs[1]?.status !== "UNREALIZED_VALUATION_PROJECTED") {
      throw new Error("open checkpoints were not projected");
    }
    expect(historical.outputs[0].valuation.executionAttemptId)
      .toBe(historical.outputs[1].valuation.executionAttemptId);
    expect(counts(historical.state)).toEqual({
      submitEntry: 1, submitProtection: 1, cancelEntry: 0, repositoryRecords: 2,
    });
    expect(counts(live.state)).toEqual({
      submitEntry: 1, submitProtection: 1, cancelEntry: 0, repositoryRecords: 2,
    });
    expect(historical.state).not.toBe(live.state);
  });
});
