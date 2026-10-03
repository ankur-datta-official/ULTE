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
import { RealtimeExecutionProtectionLifecycleEngine } from "./index.js";

const instrument = createInstrumentId({ venue: "TEST", venueSymbol: "ABC", instrumentKind: "CFD" });
const source = marketDataSource("task-024-integration-feed");
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
      adapterId: "task-024-adapter",
      environment: "SANDBOX",
      credentialProfileRef: "task-024-credentials",
      capabilities,
    }),
    capabilities,
    submitEntry: vi.fn(async (request: EntrySubmissionRequest) => createEntryAcknowledgement({
      executionAttemptId: request.executionAttemptId,
      idempotencyKey: request.idempotencyKey,
      adapterOrderId: "task-024-order",
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
    profileVersion: "task-024-analysis-v1",
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
      baseCurrency: currencyCode("USD"),
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
  const decisionEngine = new RealtimeDecisionEngine({ profileVersion: "task-024-decision-v1", recentDecisionWindowSize: 16 });
  const preparationEngine = new RealtimeExecutionPreparationEngine({
    profileVersion: "task-024-preparation-v1",
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
    initialEpochId: sourceEpochId("task-024-integration-epoch"),
    initialEpochTime: unixMs(0),
    alignments: [{ timeframe: oneMinute, anchorTime: unixMs(0) }],
    deduplicationWindowSize: 64,
  });
  trades().forEach((event, index) => {
    collect(
      analysisEngine.processLiveIngestion(ingestion.ingest(createLiveTradeEvent({
        sourceEventId: `task-024-integration-${index}`,
        event,
      }), event.eventTime)),
      decisionEngine,
      preparationEngine,
      results,
    );
  });
  return Object.freeze(results);
}

async function submission(
  preparation: Extract<RealtimeExecutionPreparationResult, { readonly status: "EXECUTION_PREPARED" }>,
  repository: MemoryRepository,
  broker: BrokerAdapter,
): Promise<SubmissionConfirmedResult> {
  const result = await new RealtimeExecutionSubmissionEngine(
    { maxPreparedPlanAgeMs: 100 },
    { adapterRegistry: createBrokerAdapterRegistry([broker]), idempotencyRepository: repository },
  ).submit({
    preparation,
    context: {
      executionEnvironment: "SANDBOX",
      adapterId: brokerAdapterId("task-024-adapter"),
      credentialProfileRef: credentialProfileRef("task-024-credentials"),
      submissionAsOf: preparation.preparationAsOf + 10,
    },
  });
  if (result.status !== "SUBMISSION_CONFIRMED") throw new Error("submission was not confirmed");
  return result;
}

function fill(submitted: SubmissionConfirmedResult) {
  const initialized = initializeRealtimeExecutionFillLifecycle(submitted);
  if (initialized.status !== "FILL_LIFECYCLE_INITIALIZED") throw new Error("fill lifecycle did not initialize");
  return applyRealtimeExecutionFill({
    submission: submitted,
    executionAttempt: initialized.executionAttempt,
    fill: createFillEvent({
      executionAttemptId: initialized.executionAttempt.executionAttemptId,
      adapterOrderId: "task-024-order",
      fillId: "task-024-fill-1",
      filledQuantity: initialized.executionAttempt.quantity,
      fillPrice: "16.5",
      filledAt: 400_001,
    }),
    observationAsOf: 400_001,
  });
}

async function protection(
  fillLifecycle: ReturnType<typeof fill>,
  repository: MemoryRepository,
  broker: BrokerAdapter,
): Promise<ProtectionConfirmedResult> {
  const result = await new RealtimeExecutionProtectionEngine({
    adapterRegistry: createBrokerAdapterRegistry([broker]),
    idempotencyRepository: repository,
  }).submit({
    fillLifecycle,
    context: {
      executionEnvironment: "SANDBOX",
      adapterId: brokerAdapterId("task-024-adapter"),
      credentialProfileRef: credentialProfileRef("task-024-credentials"),
      protectionAsOf: 400_002,
    },
  });
  if (result.status !== "PROTECTION_CONFIRMED") throw new Error("protection was not confirmed");
  return result;
}

describe("actual historical/live path through Task 024", () => {
  it("projects the same confirmed protection acknowledgement with isolated branches", async () => {
    const historical = upstreamPath("HISTORICAL");
    const live = upstreamPath("LIVE");
    expect(historical).toHaveLength(6);
    expect(live).toHaveLength(6);
    const historicalFinal = historical[5]!;
    const liveFinal = live[5]!;
    if (historicalFinal.preparation.status !== "EXECUTION_PREPARED"
      || liveFinal.preparation.status !== "EXECUTION_PREPARED") throw new Error("expected prepared paths");

    const historicalRepository = new MemoryRepository();
    const liveRepository = new MemoryRepository();
    const historicalAdapter = adapter();
    const liveAdapter = adapter();
    const historicalSubmission = await submission(historicalFinal.preparation, historicalRepository, historicalAdapter);
    const liveSubmission = await submission(liveFinal.preparation, liveRepository, liveAdapter);
    const historicalFill = fill(historicalSubmission);
    const liveFill = fill(liveSubmission);
    const historicalProtection = await protection(historicalFill, historicalRepository, historicalAdapter);
    const liveProtection = await protection(liveFill, liveRepository, liveAdapter);
    const historicalLifecycle = new RealtimeExecutionProtectionLifecycleEngine().apply({
      protectionResult: historicalProtection,
      executionAttempt: historicalProtection.executionAttempt,
      observationAsOf: 400_002,
    });
    const liveLifecycle = new RealtimeExecutionProtectionLifecycleEngine().apply({
      protectionResult: liveProtection,
      executionAttempt: liveProtection.executionAttempt,
      observationAsOf: 400_002,
    });

    expect(historicalFinal.analysisCycleId).toBe(liveFinal.analysisCycleId);
    expect(historicalFinal.decision.decisionCycleId).toBe(liveFinal.decision.decisionCycleId);
    expect(historicalFinal.preparation.preparationCycleId).toBe(liveFinal.preparation.preparationCycleId);
    expect(historicalSubmission.executionAttempt.executionPlanId).toBe(liveSubmission.executionAttempt.executionPlanId);
    expect(historicalSubmission.executionAttempt.executionAttemptId).toBe(liveSubmission.executionAttempt.executionAttemptId);
    expect(historicalSubmission.durableResult.acknowledgement).toEqual(liveSubmission.durableResult.acknowledgement);
    expect(historicalFill).toEqual(liveFill);
    expect(historicalProtection.protectionRequest.protectionRequestId)
      .toBe(liveProtection.protectionRequest.protectionRequestId);
    expect(historicalProtection.protectionRequest.idempotencyKey)
      .toBe(liveProtection.protectionRequest.idempotencyKey);
    expect(historicalProtection.durableResult.acknowledgement)
      .toEqual(liveProtection.durableResult.acknowledgement);
    expect(historicalLifecycle).toMatchObject({
      status: "PROTECTION_ACKNOWLEDGEMENT_APPLIED",
      acknowledgement: { kind: "PROTECTION_ACCEPTED" },
      executionAttempt: {
        state: "PROTECTED",
        protectedQuantity: historicalSubmission.executionAttempt.quantity,
        unprotectedFilledQuantity: "0",
        lastExecutionEventAt: 400_002,
      },
    });
    expect(liveLifecycle).toEqual(historicalLifecycle);
    expect(historicalRepository).not.toBe(liveRepository);
    expect(historicalAdapter).not.toBe(liveAdapter);
    expect(historicalAdapter.submitEntry).toHaveBeenCalledTimes(1);
    expect(liveAdapter.submitEntry).toHaveBeenCalledTimes(1);
    expect(historicalAdapter.submitProtection).toHaveBeenCalledTimes(1);
    expect(liveAdapter.submitProtection).toHaveBeenCalledTimes(1);
    expect(historicalAdapter.cancelEntry).not.toHaveBeenCalled();
    expect(liveAdapter.cancelEntry).not.toHaveBeenCalled();
  });
});
