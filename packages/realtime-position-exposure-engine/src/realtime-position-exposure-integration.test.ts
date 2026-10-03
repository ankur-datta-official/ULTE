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
import { createInstrumentId, currencyCode, parseTimeframe, unixMs } from "@ulte/instrument-model";
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
  MultiTimeframeCandleEngine,
  type MarketDataEvent,
  type TradeTick,
} from "@ulte/market-data";
import { createAccountRiskSnapshot, createPortfolioRiskConfig } from "@ulte/portfolio-risk-engine";
import { createLinearInstrumentSizingSpec } from "@ulte/position-sizing-engine";
import {
  RealtimeAnalysisEngine,
  type RealtimeAnalysisConfig,
  type RealtimeAnalysisProcessResult,
} from "@ulte/realtime-analysis-engine";
import {
  RealtimeDecisionEngine,
  type DecisionContext,
  type RealtimeDecisionResult,
  type TradeIntentCreatedResult,
} from "@ulte/realtime-decision-engine";
import {
  RealtimeExecutionPreparationEngine,
  type ExecutionPreparationContext,
  type RealtimeExecutionPreparationResult,
} from "@ulte/realtime-execution-preparation-engine";
import {
  RealtimeExecutionSubmissionEngine,
  type SubmissionConfirmedResult,
} from "@ulte/realtime-execution-submission-engine";
import { createRiskCostAssumptions, createRiskQualificationConfig } from "@ulte/risk-engine";
import {
  applyRealtimeExecutionFill,
  initializeRealtimeExecutionFillLifecycle,
} from "@ulte/realtime-execution-fill-engine";
import {
  RealtimeExecutionProtectionEngine,
  type ProtectionConfirmedResult,
} from "@ulte/realtime-execution-protection-engine";
import { RealtimeExecutionProtectionLifecycleEngine } from "@ulte/realtime-execution-protection-lifecycle-engine";
import { RealtimeExecutionExitFillEngine } from "@ulte/realtime-execution-exit-fill-engine";
import { RealtimePositionExposureEngine } from "./index.js";

const instrument = createInstrumentId({ venue: "TEST", venueSymbol: "ABC", instrumentKind: "CFD" });
const source = marketDataSource("task-026b-integration-feed");
const oneMinute = parseTimeframe("1m");
const capabilities = createAdapterCapabilities({
  supportsClientIdempotency: true,
  supportsCloseOnlyExit: true,
  supportsNativeBracketProtection: false,
  supportsProtectionModification: false,
  supportsOrderCancellation: true,
  supportsPartialFillReporting: true,
});

class MemoryRepository implements IdempotencyRepository {
  readonly records = new Map<string, IdempotencyRecord>();

  async claim(input: IdempotencyClaimInput): Promise<IdempotencyClaimResult> {
    const key = `${input.adapterId}\u0000${input.idempotencyKey}`;
    const existing = this.records.get(key);
    const comparison = compareIdempotencyClaim(existing, input);
    if (comparison.status === "CONFLICT") return { status: "CONFLICT", reason: comparison.reason, record: existing! };
    if (comparison.status === "EXISTING_SAME_REQUEST") return { status: "EXISTING_SAME_REQUEST", record: existing! };
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
      adapterId: "task-026b-adapter",
      environment: "SANDBOX",
      credentialProfileRef: "task-026b-credentials",
      capabilities,
    }),
    capabilities,
    submitEntry: vi.fn(async (request: EntrySubmissionRequest) => createEntryAcknowledgement({
      executionAttemptId: request.executionAttemptId,
      idempotencyKey: request.idempotencyKey,
      adapterOrderId: "task-026b-order",
      acknowledgedAt: 400_000,
    })),
    submitProtection: vi.fn(async (request: ProtectionRequest) => createProtectionAcknowledgement({
      executionAttemptId: request.executionAttemptId,
      protectionRequestId: request.protectionRequestId,
      idempotencyKey: request.idempotencyKey,
      protectedQuantity: request.targetCumulativeProtectedQuantity,
      acknowledgedAt: 400_002,
    })),
    cancelEntry: vi.fn(async (_request: EntryCancellationRequest) => { throw new Error("forbidden"); }),
  };
}

function analysisConfig(): RealtimeAnalysisConfig {
  return {
    profileVersion: "task-026b-analysis-v1",
    instrumentId: instrument,
    source,
    timeframes: [{ timeframe: oneMinute, historyLimit: 16 }],
    roles: { regimeTimeframe: oneMinute, structureTimeframe: oneMinute, setupTimeframe: oneMinute },
    regime: {
      trendLookback: 2,
      baselineVolatilityBars: 1,
      recentVolatilityBars: 1,
      trendEfficiencyMinBps: 7_000,
      trendConsistencyMinBps: 7_000,
      rangeEfficiencyMaxBps: 3_000,
      rangeConsistencyMaxBps: 3_000,
      compressionRatioMaxBps: 1_000,
      expansionRatioMinBps: 20_000,
    },
    structure: { lookbackBars: 6, pivotLeftBars: 1, pivotRightBars: 1 },
    setup: {
      continuationAllowedRegimes: [],
      breakoutAllowedRegimes: ["TREND_UP", "TREND_DOWN", "RANGE", "COMPRESSION", "EXPANSION", "TRANSITION"],
      reversalAllowedRegimes: [],
    },
    cycleDeduplicationWindowSize: 16,
  };
}

function trades(): readonly MarketDataEvent<TradeTick>[] {
  const prices = [
    ["9", "8", "10", "9"],
    ["10", "9", "12", "11"],
    ["10", "9.5", "11", "10"],
    ["11", "10", "13", "12.5"],
    ["15", "12", "30", "15"],
    ["15", "13", "20", "16"],
  ] as const;
  const events: MarketDataEvent<TradeTick>[] = [];
  prices.forEach(([open, low, high, close], index) => {
    const start = index * 60_000;
    for (const [offset, price] of [[1_000, open], [2_000, low], [3_000, high], [59_000, close]] as const) {
      const eventTime = start + offset;
      events.push(createMarketDataEvent({
        instrumentId: instrument,
        source,
        eventTime,
        receivedAt: eventTime,
        payload: createTradeTick({ price, quantity: "1", side: "UNKNOWN" }),
        quality: ["LIVE"],
      }));
    }
  });
  events.push(createMarketDataEvent({
    instrumentId: instrument,
    source,
    eventTime: 361_000,
    receivedAt: 361_000,
    payload: createTradeTick({ price: "16", quantity: "1", side: "UNKNOWN" }),
    quality: ["LIVE"],
  }));
  return Object.freeze(events);
}

function decisionContext(asOf: number): DecisionContext {
  return {
    riskCosts: createRiskCostAssumptions({ entryCostBps: 0, targetExitCostBps: 0, stopExitCostBps: 0 }),
    riskConfig: createRiskQualificationConfig({ minimumNetRewardRiskBps: 30_000 }),
    account: createAccountRiskSnapshot({
      asOf,
      baseCurrency: currencyCode("USD"),
      currentEquity: "10000",
      dayStartEquity: "10000",
      openPositions: [],
    }),
    requestedRiskAmount: "100",
    proposedRiskGroupIds: ["GROUP_A"],
    portfolioRiskConfig: createPortfolioRiskConfig({
      maxRiskPerTradeBps: 100,
      maxTotalOpenRiskBps: 300,
      maxConcurrentPositions: 3,
      maxDailyLossBps: 500,
      riskGroupLimits: [{ groupId: "GROUP_A", maxRiskBps: 200 }],
    }),
    instrumentSizingSpec: createLinearInstrumentSizingSpec({
      valuationModel: "LINEAR_PRICE_PNL",
      instrumentId: instrument,
      pnlCurrency: currencyCode("USD"),
      quantityUnit: "contract",
      quantityStep: "1",
      minimumQuantity: "1",
      maximumQuantity: "1000",
      pnlValuePerPriceUnitPerQuantity: "1",
    }),
  };
}

function preparationContext(decision: TradeIntentCreatedResult): ExecutionPreparationContext {
  const entry = decision.tradeIntentResult.entryReferencePrice;
  return {
    preparationAsOf: decision.analysisAsOf + 10,
    marketSnapshot: { instrumentId: instrument, asOf: decision.analysisAsOf + 10, bid: entry, ask: entry },
    instrumentExecutionSpec: {
      instrumentId: instrument,
      priceTick: "0.5",
      quantityStep: "1",
      minimumQuantity: "1",
      maximumQuantity: "1000",
    },
    config: { maxIntentAgeMs: 100, maxQuoteAgeMs: 100, maxEntryDeviationBps: 1_000 },
  };
}

interface UpstreamResult {
  readonly analysisCycleId: string;
  readonly decision: RealtimeDecisionResult;
  readonly preparation: RealtimeExecutionPreparationResult;
}

function collect(
  analyzed: RealtimeAnalysisProcessResult,
  decisionEngine: RealtimeDecisionEngine,
  preparationEngine: RealtimeExecutionPreparationEngine,
  results: UpstreamResult[],
): void {
  if (analyzed.status !== "ANALYSIS_CYCLES") return;
  for (const analysis of analyzed.cycles) {
    const decision = decisionEngine.process({ analysis, context: decisionContext(analysis.analysisAsOf) });
    const preparation = decision.status === "TRADE_INTENT_CREATED"
      ? preparationEngine.process({ decision, context: preparationContext(decision) })
      : preparationEngine.process({ decision });
    results.push(Object.freeze({ analysisCycleId: analysis.analysisCycleId, decision, preparation }));
  }
}

function upstreamPath(mode: "HISTORICAL" | "LIVE"): readonly UpstreamResult[] {
  const analysis = new RealtimeAnalysisEngine(analysisConfig());
  const decision = new RealtimeDecisionEngine({ profileVersion: "task-026b-decision-v1", recentDecisionWindowSize: 16 });
  const preparation = new RealtimeExecutionPreparationEngine({
    profileVersion: "task-026b-preparation-v1",
    recentPreparationWindowSize: 16,
  });
  const results: UpstreamResult[] = [];
  if (mode === "HISTORICAL") {
    const candles = new MultiTimeframeCandleEngine({
      instrumentId: instrument,
      source,
      alignments: [{ timeframe: oneMinute, anchorTime: unixMs(0) }],
    });
    new HistoricalReplayEngine(new ArrayHistoricalEventSource(trades())).run({
      onEvent(event): void {
        collect(analysis.processCandleEvents(candles.process(event)), decision, preparation, results);
      },
    });
  } else {
    const ingestion = new LiveTradeIngestionEngine({
      source: createLiveMarketDataSourceDescriptor({
        sourceId: source,
        mode: "LIVE",
        capabilities: ["TRADE"],
        sequenceSemantics: "NONE",
      }),
      instrumentId: instrument,
      initialEpochId: sourceEpochId("task-026b-epoch"),
      initialEpochTime: unixMs(0),
      alignments: [{ timeframe: oneMinute, anchorTime: unixMs(0) }],
      deduplicationWindowSize: 64,
    });
    trades().forEach((event, index) => collect(
      analysis.processLiveIngestion(ingestion.ingest(createLiveTradeEvent({
        sourceEventId: `task-026b-${index}`,
        event,
      }), event.eventTime)),
      decision,
      preparation,
      results,
    ));
  }
  return Object.freeze(results);
}

function externalCounts(broker: BrokerAdapter, repository: MemoryRepository) {
  return {
    submitEntry: vi.mocked(broker.submitEntry).mock.calls.length,
    submitProtection: vi.mocked(broker.submitProtection).mock.calls.length,
    cancelEntry: vi.mocked(broker.cancelEntry).mock.calls.length,
    repositoryRecords: repository.records.size,
  };
}

async function project(mode: "HISTORICAL" | "LIVE") {
  const upstream = upstreamPath(mode);
  const final = upstream[5]!;
  if (final.preparation.status !== "EXECUTION_PREPARED") throw new Error("path did not prepare execution");
  const repository = new MemoryRepository();
  const broker = adapter();
  const positionProjector = new RealtimePositionExposureEngine();
  const submission = await new RealtimeExecutionSubmissionEngine(
    { maxPreparedPlanAgeMs: 100 },
    { adapterRegistry: createBrokerAdapterRegistry([broker]), idempotencyRepository: repository },
  ).submit({
    preparation: final.preparation,
    context: {
      executionEnvironment: "SANDBOX",
      adapterId: brokerAdapterId("task-026b-adapter"),
      credentialProfileRef: credentialProfileRef("task-026b-credentials"),
      submissionAsOf: final.preparation.preparationAsOf + 10,
    },
  });
  if (submission.status !== "SUBMISSION_CONFIRMED") throw new Error("submission not confirmed");
  const initialized = initializeRealtimeExecutionFillLifecycle(submission);
  if (initialized.status !== "FILL_LIFECYCLE_INITIALIZED") throw new Error("fill lifecycle not initialized");
  const fill = applyRealtimeExecutionFill({
    submission,
    executionAttempt: initialized.executionAttempt,
    fill: createFillEvent({
      executionAttemptId: initialized.executionAttempt.executionAttemptId,
      adapterOrderId: "task-026b-order",
      fillId: "task-026b-entry-fill",
      filledQuantity: initialized.executionAttempt.quantity,
      fillPrice: "16.5",
      filledAt: 400_001,
    }),
    observationAsOf: 400_001,
  });
  const entryPositionCallsBefore = externalCounts(broker, repository);
  const entryPosition = positionProjector.project({ sourceKind: "ENTRY_FILL", fillLifecycle: fill });
  const entryPositionCallsAfter = externalCounts(broker, repository);
  const protection = await new RealtimeExecutionProtectionEngine({
    adapterRegistry: createBrokerAdapterRegistry([broker]),
    idempotencyRepository: repository,
  }).submit({
    fillLifecycle: fill,
    context: {
      executionEnvironment: "SANDBOX",
      adapterId: brokerAdapterId("task-026b-adapter"),
      credentialProfileRef: credentialProfileRef("task-026b-credentials"),
      protectionAsOf: 400_002,
    },
  });
  if (protection.status !== "PROTECTION_CONFIRMED") throw new Error("protection not confirmed");
  const lifecycle = new RealtimeExecutionProtectionLifecycleEngine().apply({
    protectionResult: protection,
    executionAttempt: protection.executionAttempt,
    observationAsOf: 400_002,
  });
  if (lifecycle.status !== "PROTECTION_ACKNOWLEDGEMENT_APPLIED") throw new Error("protection lifecycle failed");
  const callsBeforeExit = {
    submitEntry: vi.mocked(broker.submitEntry).mock.calls.length,
    submitProtection: vi.mocked(broker.submitProtection).mock.calls.length,
    cancelEntry: vi.mocked(broker.cancelEntry).mock.calls.length,
    repositoryRecords: repository.records.size,
  };
  const firstExitFill = createExitFillEvent({
    executionAttemptId: lifecycle.executionAttempt.executionAttemptId,
    protectionRequestId: lifecycle.executionAttempt.acknowledgedProtections[0]!.request.protectionRequestId,
    exitSide: lifecycle.executionAttempt.exitSide,
    exitLeg: "PROTECTIVE_STOP",
    fillId: "task-026b-exit-fill-1",
    filledQuantity: "1",
    fillPrice: "14",
    filledAt: 400_003,
  });
  const projector = new RealtimeExecutionExitFillEngine();
  const firstExit = projector.apply({
    protectionLifecycle: lifecycle,
    executionAttempt: lifecycle.executionAttempt,
    exitFill: firstExitFill,
    observationAsOf: 400_003,
  });
  if (firstExit.status !== "EXIT_FILL_APPLIED") throw new Error("first exit projection failed");
  const partialExitPositionCallsBefore = externalCounts(broker, repository);
  const partialExitPosition = positionProjector.project({ sourceKind: "EXIT_FILL", exitFillLifecycle: firstExit });
  const partialExitPositionCallsAfter = externalCounts(broker, repository);
  const remainingQuantity = (BigInt(lifecycle.executionAttempt.quantity) - 1n).toString();
  const finalExitFill = createExitFillEvent({
    executionAttemptId: lifecycle.executionAttempt.executionAttemptId,
    protectionRequestId: lifecycle.executionAttempt.acknowledgedProtections[0]!.request.protectionRequestId,
    exitSide: lifecycle.executionAttempt.exitSide,
    exitLeg: "PROFIT_TARGET",
    fillId: "task-026b-exit-fill-2",
    filledQuantity: remainingQuantity,
    fillPrice: "20",
    filledAt: 400_004,
  });
  const exit = projector.apply({
    protectionLifecycle: lifecycle,
    executionAttempt: firstExit.executionAttempt,
    exitFill: finalExitFill,
    observationAsOf: 400_004,
  });
  const finalExitPositionCallsBefore = externalCounts(broker, repository);
  const finalExitPosition = positionProjector.project({ sourceKind: "EXIT_FILL", exitFillLifecycle: exit });
  const finalExitPositionCallsAfter = externalCounts(broker, repository);
  return {
    upstream,
    final,
    submission,
    fill,
    entryPosition,
    entryPositionCallsBefore,
    entryPositionCallsAfter,
    protection,
    lifecycle,
    firstExitFill,
    firstExit,
    partialExitPosition,
    partialExitPositionCallsBefore,
    partialExitPositionCallsAfter,
    finalExitFill,
    exit,
    finalExitPosition,
    finalExitPositionCallsBefore,
    finalExitPositionCallsAfter,
    broker,
    repository,
    callsBeforeExit,
  };
}

describe("historical/live equivalence through Task 026B", () => {
  it("projects equal entry, partial-exit, and closed snapshots with no new external calls", async () => {
    const historical = await project("HISTORICAL");
    const live = await project("LIVE");
    expect(historical.final.analysisCycleId).toBe(live.final.analysisCycleId);
    expect(historical.final.decision.decisionCycleId).toBe(live.final.decision.decisionCycleId);
    expect(historical.final.preparation.preparationCycleId).toBe(live.final.preparation.preparationCycleId);
    expect(historical.submission.executionAttempt.executionPlanId).toBe(live.submission.executionAttempt.executionPlanId);
    expect(historical.submission.executionAttempt.executionAttemptId).toBe(live.submission.executionAttempt.executionAttemptId);
    expect(historical.submission.durableResult.acknowledgement).toEqual(live.submission.durableResult.acknowledgement);
    expect(historical.fill).toEqual(live.fill);
    expect(historical.entryPosition).toEqual(live.entryPosition);
    expect(historical.entryPosition).toMatchObject({
      status: "POSITION_EXPOSURE_PROJECTED",
      positionExposure: { exposureState: "OPEN" },
    });
    expect(historical.entryPositionCallsAfter).toEqual(historical.entryPositionCallsBefore);
    expect(live.entryPositionCallsAfter).toEqual(live.entryPositionCallsBefore);
    expect(historical.protection.protectionRequest.protectionRequestId)
      .toBe(live.protection.protectionRequest.protectionRequestId);
    expect(historical.protection.durableResult.acknowledgement)
      .toEqual(live.protection.durableResult.acknowledgement);
    expect(historical.lifecycle.executionAttempt).toEqual(live.lifecycle.executionAttempt);
    expect(historical.firstExitFill).toEqual(live.firstExitFill);
    expect(historical.firstExit).toEqual(live.firstExit);
    expect(historical.firstExit).toMatchObject({
      status: "EXIT_FILL_APPLIED",
      exitFill: { exitLeg: "PROTECTIVE_STOP", filledQuantity: "1", filledAt: 400_003 },
      executionAttempt: { exitedQuantity: "1", state: "EXIT_PARTIALLY_FILLED" },
    });
    expect(historical.partialExitPosition).toEqual(live.partialExitPosition);
    expect(historical.partialExitPosition).toMatchObject({
      status: "POSITION_EXPOSURE_PROJECTED",
      positionExposure: { exposureState: "PARTIALLY_EXITED" },
    });
    expect(historical.partialExitPositionCallsAfter).toEqual(historical.partialExitPositionCallsBefore);
    expect(live.partialExitPositionCallsAfter).toEqual(live.partialExitPositionCallsBefore);
    expect(historical.finalExitFill).toEqual(live.finalExitFill);
    expect(historical.exit).toEqual(live.exit);
    expect(historical.exit).toMatchObject({
      status: "EXIT_FILL_APPLIED",
      exitFill: { kind: "EXIT_FILL", exitLeg: "PROFIT_TARGET", filledAt: 400_004 },
      executionAttempt: { exitedQuantity: historical.submission.executionAttempt.quantity, state: "EXIT_FILLED" },
    });
    expect(historical.finalExitPosition).toEqual(live.finalExitPosition);
    expect(historical.finalExitPosition).toMatchObject({
      status: "POSITION_EXPOSURE_PROJECTED",
      positionExposure: { openQuantity: "0", entryCanIncreaseExposure: false, exposureState: "CLOSED" },
    });
    expect(historical.finalExitPositionCallsAfter).toEqual(historical.finalExitPositionCallsBefore);
    expect(live.finalExitPositionCallsAfter).toEqual(live.finalExitPositionCallsBefore);
    for (const branch of [historical, live]) {
      expect(branch.broker.submitEntry).toHaveBeenCalledTimes(1);
      expect(branch.broker.submitProtection).toHaveBeenCalledTimes(1);
      expect(branch.broker.cancelEntry).not.toHaveBeenCalled();
      expect({
        submitEntry: vi.mocked(branch.broker.submitEntry).mock.calls.length,
        submitProtection: vi.mocked(branch.broker.submitProtection).mock.calls.length,
        cancelEntry: vi.mocked(branch.broker.cancelEntry).mock.calls.length,
        repositoryRecords: branch.repository.records.size,
      }).toEqual(branch.callsBeforeExit);
    }
    expect(historical.repository).not.toBe(live.repository);
    expect(historical.broker).not.toBe(live.broker);
  });
});
