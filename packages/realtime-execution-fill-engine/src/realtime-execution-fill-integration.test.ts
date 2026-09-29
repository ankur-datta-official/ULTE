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
  type IdempotencyOutcomeInput,
  type IdempotencyRecord,
  type IdempotencyRepository,
} from "@ulte/broker-adapters";
import {
  createAdapterCapabilities,
  createEntryAcknowledgement,
  createFillEvent,
  type EntryCancellationRequest,
  type EntrySubmissionRequest,
  type ProtectionRequest,
} from "@ulte/execution-engine";
import {
  createInstrumentId,
  currencyCode,
  parseTimeframe,
  unixMs,
} from "@ulte/instrument-model";
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
import { createFxConversionSnapshot, createLinearInstrumentSizingSpec } from "@ulte/position-sizing-engine";
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
} from "./index.js";

const instrument = createInstrumentId({ venue: "TEST", venueSymbol: "ABC", instrumentKind: "CFD" });
const source = marketDataSource("task-022-integration-feed");
const oneMinute = parseTimeframe("1m");
const capabilities = createAdapterCapabilities({
  supportsClientIdempotency: true,
  supportsCloseOnlyExit: true,
  supportsNativeBracketProtection: false,
  supportsProtectionModification: false,
  supportsOrderCancellation: true,
  supportsPartialFillReporting: true,
});

function storageKey(adapterId: string, idempotencyKey: string): string {
  return `${adapterId}\u0000${idempotencyKey}`;
}

class MemoryRepository implements IdempotencyRepository {
  readonly records = new Map<string, IdempotencyRecord>();

  async claim(input: IdempotencyClaimInput): Promise<IdempotencyClaimResult> {
    const key = storageKey(input.adapterId, input.idempotencyKey);
    const existing = this.records.get(key);
    const comparison = compareIdempotencyClaim(existing, input);
    if (comparison.status === "CONFLICT") {
      return { status: "CONFLICT", reason: comparison.reason, record: existing! };
    }
    if (comparison.status === "EXISTING_SAME_REQUEST") {
      return { status: "EXISTING_SAME_REQUEST", record: existing! };
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
    return this.records.get(storageKey(adapterId, idempotencyKey));
  }

  async recordOutcome(input: IdempotencyOutcomeInput): Promise<IdempotencyRecord> {
    const key = storageKey(input.adapterId, input.idempotencyKey);
    const current = this.records.get(key);
    if (current === undefined) throw new Error("outcome without claim");
    const next = createIdempotencyRecord({
      ...current,
      status: input.status,
      updatedAt: input.updatedAt,
      ...(input.adapterOrderId === undefined ? {} : { adapterOrderId: input.adapterOrderId }),
    });
    this.records.set(key, next);
    return next;
  }
}

function adapter(): BrokerAdapter {
  return {
    descriptor: createBrokerAdapterDescriptor({
      adapterId: "task-022-adapter",
      environment: "SANDBOX",
      credentialProfileRef: "task-022-credentials",
      capabilities,
    }),
    capabilities,
    submitEntry: vi.fn(async (request: EntrySubmissionRequest) => createEntryAcknowledgement({
      executionAttemptId: request.executionAttemptId,
      idempotencyKey: request.idempotencyKey,
      adapterOrderId: "task-022-order",
      acknowledgedAt: 400_000,
    })),
    submitProtection: vi.fn(async (_request: ProtectionRequest) => { throw new Error("forbidden"); }),
    cancelEntry: vi.fn(async (_request: EntryCancellationRequest) => { throw new Error("forbidden"); }),
  };
}

function analysisConfig(): RealtimeAnalysisConfig {
  return {
    profileVersion: "task-022-analysis-v1",
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
    { open: "9", low: "8", high: "10", close: "9" },
    { open: "10", low: "9", high: "12", close: "11" },
    { open: "10", low: "9.5", high: "11", close: "10" },
    { open: "11", low: "10", high: "13", close: "12.5" },
    { open: "15", low: "12", high: "30", close: "15" },
    { open: "15", low: "13", high: "20", close: "16" },
  ] as const;
  const events: MarketDataEvent<TradeTick>[] = [];
  prices.forEach((values, index) => {
    const bucketStart = index * 60_000;
    for (const [offset, price] of [
      [1_000, values.open], [2_000, values.low], [3_000, values.high], [59_000, values.close],
    ] as const) {
      const eventTime = bucketStart + offset;
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
      baseCurrency: currencyCode("BDT"),
      currentEquity: "10000",
      dayStartEquity: "10000",
      openPositions: [],
    }),
    requestedRiskAmount: "100",
    proposedRiskGroupIds: ["GROUP_A", "GROUP_B"],
    portfolioRiskConfig: createPortfolioRiskConfig({
      maxRiskPerTradeBps: 100,
      maxTotalOpenRiskBps: 300,
      maxConcurrentPositions: 3,
      maxDailyLossBps: 500,
      riskGroupLimits: [
        { groupId: "GROUP_A", maxRiskBps: 200 },
        { groupId: "GROUP_B", maxRiskBps: 200 },
      ],
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
    fxConversion: createFxConversionSnapshot({
      asOf,
      fromCurrency: "USD",
      toCurrency: "BDT",
      rate: "1",
    }),
  };
}

function preparationContext(decision: TradeIntentCreatedResult): ExecutionPreparationContext {
  const entry = decision.tradeIntentResult.entryReferencePrice;
  return {
    preparationAsOf: decision.analysisAsOf + 10,
    marketSnapshot: {
      instrumentId: decision.tradeIntentResult.instrumentId,
      asOf: decision.analysisAsOf + 10,
      bid: entry,
      ask: entry,
    },
    instrumentExecutionSpec: {
      instrumentId: decision.tradeIntentResult.instrumentId,
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
  const analysisEngine = new RealtimeAnalysisEngine(analysisConfig());
  const decisionEngine = new RealtimeDecisionEngine({ profileVersion: "task-022-decision-v1", recentDecisionWindowSize: 16 });
  const preparationEngine = new RealtimeExecutionPreparationEngine({
    profileVersion: "task-022-preparation-v1",
    recentPreparationWindowSize: 16,
  });
  const results: UpstreamResult[] = [];
  if (mode === "HISTORICAL") {
    const candleEngine = new MultiTimeframeCandleEngine({
      instrumentId: instrument,
      source,
      alignments: [{ timeframe: oneMinute, anchorTime: unixMs(0) }],
    });
    new HistoricalReplayEngine(new ArrayHistoricalEventSource(trades())).run({
      onEvent(event): void {
        collect(analysisEngine.processCandleEvents(candleEngine.process(event)), decisionEngine, preparationEngine, results);
      },
    });
    return Object.freeze(results);
  }
  const ingestion = new LiveTradeIngestionEngine({
    source: createLiveMarketDataSourceDescriptor({
      sourceId: source,
      mode: "LIVE",
      capabilities: ["TRADE"],
      sequenceSemantics: "NONE",
    }),
    instrumentId: instrument,
    initialEpochId: sourceEpochId("task-022-integration-epoch"),
    initialEpochTime: unixMs(0),
    alignments: [{ timeframe: oneMinute, anchorTime: unixMs(0) }],
    deduplicationWindowSize: 64,
  });
  trades().forEach((event, index) => {
    collect(
      analysisEngine.processLiveIngestion(ingestion.ingest(createLiveTradeEvent({
        sourceEventId: `task-022-integration-${index}`,
        event,
      }), event.eventTime)),
      decisionEngine,
      preparationEngine,
      results,
    );
  });
  return Object.freeze(results);
}

async function submit(
  preparation: Extract<RealtimeExecutionPreparationResult, { readonly status: "EXECUTION_PREPARED" }>,
  repository: MemoryRepository,
  broker: BrokerAdapter,
): Promise<SubmissionConfirmedResult> {
  const engine = new RealtimeExecutionSubmissionEngine(
    { maxPreparedPlanAgeMs: 100 },
    { adapterRegistry: createBrokerAdapterRegistry([broker]), idempotencyRepository: repository },
  );
  const result = await engine.submit({
    preparation,
    context: {
      executionEnvironment: "SANDBOX",
      adapterId: brokerAdapterId("task-022-adapter"),
      credentialProfileRef: credentialProfileRef("task-022-credentials"),
      submissionAsOf: preparation.preparationAsOf + 10,
    },
  });
  if (result.status !== "SUBMISSION_CONFIRMED") throw new Error("submission was not confirmed");
  return result;
}

function projectFill(submission: SubmissionConfirmedResult) {
  const initialized = initializeRealtimeExecutionFillLifecycle(submission);
  if (initialized.status !== "FILL_LIFECYCLE_INITIALIZED") throw new Error("fill lifecycle did not initialize");
  return applyRealtimeExecutionFill({
    submission,
    executionAttempt: initialized.executionAttempt,
    fill: createFillEvent({
      executionAttemptId: initialized.executionAttempt.executionAttemptId,
      adapterOrderId: "task-022-order",
      fillId: "task-022-fill-1",
      filledQuantity: initialized.executionAttempt.quantity,
      fillPrice: "16.5",
      filledAt: 400_001,
    }),
    observationAsOf: 400_001,
  });
}

describe("actual historical/live path through Task 021 and Task 022", () => {
  it("projects equivalent normalized fills with isolated submission infrastructure", async () => {
    const historical = upstreamPath("HISTORICAL");
    const live = upstreamPath("LIVE");
    expect(historical).toHaveLength(6);
    expect(live).toHaveLength(6);
    const historicalFinal = historical[5]!;
    const liveFinal = live[5]!;
    expect(historicalFinal.analysisCycleId).toBe(liveFinal.analysisCycleId);
    expect(historicalFinal.decision.decisionCycleId).toBe(liveFinal.decision.decisionCycleId);
    expect(historicalFinal.preparation.preparationCycleId).toBe(liveFinal.preparation.preparationCycleId);
    if (historicalFinal.preparation.status !== "EXECUTION_PREPARED"
      || liveFinal.preparation.status !== "EXECUTION_PREPARED") throw new Error("expected prepared paths");
    if (historicalFinal.decision.status !== "TRADE_INTENT_CREATED") throw new Error("expected ready trade intent");

    const sourceIntent = historicalFinal.decision.tradeIntentResult;
    const sourcePlan = historicalFinal.preparation.executionPreparationResult;
    expect(sourceIntent).toMatchObject({ accountCurrency: "BDT", pnlCurrency: "USD" });
    expect(sourceIntent.approvedRiskAmount).not.toBe(sourceIntent.actualRiskAmount);
    expect(sourcePlan).toMatchObject({
      schemaVersion: "EXECUTION_PLAN_V2",
      accountCurrency: "BDT",
      approvedRiskAmount: sourceIntent.approvedRiskAmount,
      actualRiskAmount: sourceIntent.actualRiskAmount,
    });

    const historicalRepository = new MemoryRepository();
    const liveRepository = new MemoryRepository();
    const historicalAdapter = adapter();
    const liveAdapter = adapter();
    const historicalSubmission = await submit(historicalFinal.preparation, historicalRepository, historicalAdapter);
    const liveSubmission = await submit(liveFinal.preparation, liveRepository, liveAdapter);
    expect(historicalSubmission.executionAttempt).toMatchObject({
      schemaVersion: "EXECUTION_ATTEMPT_V3",
      accountCurrency: "BDT",
      approvedRiskAmount: sourceIntent.approvedRiskAmount,
      actualRiskAmount: sourceIntent.actualRiskAmount,
    });
    const historicalFill = projectFill(historicalSubmission);
    const liveFill = projectFill(liveSubmission);
    expect(historicalSubmission.executionAttempt.executionPlanId).toBe(liveSubmission.executionAttempt.executionPlanId);
    expect(historicalSubmission.executionAttempt.executionAttemptId).toBe(liveSubmission.executionAttempt.executionAttemptId);
    expect(historicalSubmission.durableResult.idempotencyKey).toBe(liveSubmission.durableResult.idempotencyKey);
    expect(historicalSubmission.durableResult.acknowledgement).toEqual(liveSubmission.durableResult.acknowledgement);
    expect(historicalFill).toMatchObject({
      status: "FILL_APPLIED",
      executionAttempt: {
        state: "ENTRY_FILLED",
        filledEntryQuantity: historicalSubmission.executionAttempt.quantity,
        lastFillPrice: "16.5",
        processedFills: [{ fillId: "task-022-fill-1" }],
      },
    });
    expect(liveFill).toEqual(historicalFill);
    expect(historicalRepository).not.toBe(liveRepository);
    expect(historicalAdapter).not.toBe(liveAdapter);
    expect(historicalAdapter.submitEntry).toHaveBeenCalledTimes(1);
    expect(liveAdapter.submitEntry).toHaveBeenCalledTimes(1);
    expect(historicalAdapter.submitProtection).not.toHaveBeenCalled();
    expect(liveAdapter.submitProtection).not.toHaveBeenCalled();
    expect(historicalAdapter.cancelEntry).not.toHaveBeenCalled();
    expect(liveAdapter.cancelEntry).not.toHaveBeenCalled();
  });
});
