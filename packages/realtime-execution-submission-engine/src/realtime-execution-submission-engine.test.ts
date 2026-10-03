import { describe, expect, it, vi } from "vitest";
import { ArrayHistoricalEventSource, HistoricalReplayEngine } from "@ulte/backtest-engine";
import {
  brokerAdapterId,
  compareIdempotencyClaim,
  credentialProfileRef,
  createBrokerAdapterDescriptor,
  createBrokerAdapterRegistry,
  createBrokerFailure,
  createIdempotencyRecord,
  type BrokerAdapter,
  type ExecutionEnvironment,
  type IdempotencyClaimInput,
  type IdempotencyClaimResult,
  classifyIdempotencyOutcome,
  type IdempotencyOutcomeInput,
  type IdempotencyOutcomeResult,
  type IdempotencyRecord,
  type IdempotencyRecordStatus,
  type IdempotencyRepository,
} from "@ulte/broker-adapters";
import {
  createAdapterCapabilities,
  createEntryAcknowledgement,
  createEntryRejection,
  type EntryCancellationRequest,
  type EntrySubmissionRequest,
  type ProtectionRequest,
} from "@ulte/execution-engine";
import {
  createAccountRiskSnapshot,
  createPortfolioRiskConfig,
} from "@ulte/portfolio-risk-engine";
import { createLinearInstrumentSizingSpec } from "@ulte/position-sizing-engine";
import {
  createInstrumentId,
  currencyCode,
  parseTimeframe,
  positiveDecimalString,
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
import type {
  RealtimeExecutionPreparationResult,
} from "@ulte/realtime-execution-preparation-engine";
import { RealtimeExecutionPreparationEngine } from "@ulte/realtime-execution-preparation-engine";
import type { ExecutionPreparationContext } from "@ulte/realtime-execution-preparation-engine";
import {
  createRiskCostAssumptions,
  createRiskQualificationConfig,
} from "@ulte/risk-engine";
import {
  RealtimeExecutionSubmissionEngine,
  type RealtimeExecutionSubmissionContext,
} from "./index.js";

const instrument = createInstrumentId({ venue: "TEST", venueSymbol: "ABC", instrumentKind: "CFD" });
const capabilities = createAdapterCapabilities({
  supportsClientIdempotency: true,
  supportsCloseOnlyExit: true,
  supportsNativeBracketProtection: false,
  supportsProtectionModification: false,
  supportsOrderCancellation: true,
  supportsPartialFillReporting: true,
});

function prepared(preparationAsOf = 1_000): RealtimeExecutionPreparationResult {
  const plan = Object.freeze({
    status: "EXECUTION_PLAN_READY",
    schemaVersion: "EXECUTION_PLAN_V2",
    executionPlanId: "plan-1",
    tradeIntentId: "intent-1",
    candidateId: "candidate-1",
    instrumentId: instrument,
    intentAsOf: unixMs(900),
    marketSnapshotAsOf: unixMs(preparationAsOf),
    preparedAsOf: unixMs(preparationAsOf),
    direction: "UP",
    entrySide: "BUY",
    exitSide: "SELL",
    quantity: positiveDecimalString("1"),
    quantityUnit: "contract", accountCurrency: currencyCode("USD"),
    entryInstruction: Object.freeze({
      kind: "ENTRY_LIMIT", side: "BUY", price: positiveDecimalString("100"),
      quantity: positiveDecimalString("1"), positionEffect: "OPEN",
    }),
    protectiveStopInstruction: Object.freeze({
      kind: "PROTECTIVE_STOP_TRIGGER", side: "SELL", triggerPrice: positiveDecimalString("90"),
      quantity: positiveDecimalString("1"), positionEffect: "CLOSE",
    }),
    profitTargetInstruction: Object.freeze({
      kind: "PROFIT_TARGET_LIMIT", side: "SELL", price: positiveDecimalString("130"),
      quantity: positiveDecimalString("1"), positionEffect: "CLOSE",
    }),
    priceTick: positiveDecimalString("1"),
    quantityStep: positiveDecimalString("1"),
    bidAtPreparation: positiveDecimalString("100"),
    askAtPreparation: positiveDecimalString("100"),
    intentAgeMs: 100,
    quoteAgeMs: 0,
    entryDeviationBps: "0",
    approvedRiskAmount: positiveDecimalString("10"),
    actualRiskAmount: positiveDecimalString("10"),
    netRewardRiskBps: "30000",
  } as const);
  return Object.freeze({
    status: "EXECUTION_PREPARED",
    analysisCycleId: "analysis-1",
    decisionCycleId: "decision-1",
    preparationCycleId: "preparation-1",
    preparationProfileId: "preparation-profile-1",
    analysisAsOf: unixMs(900),
    triggerCloseTime: unixMs(900),
    preparationAsOf: unixMs(preparationAsOf),
    tradeIntentResult: Object.freeze({}),
    executionPreparationResult: plan,
  }) as unknown as RealtimeExecutionPreparationResult;
}

function nonActionable(status: "NO_PREPARATION" | "PREPARATION_REJECTED" | "DUPLICATE_PREPARATION") {
  return Object.freeze({
    status,
    preparationCycleId: "preparation-1",
  }) as unknown as RealtimeExecutionPreparationResult;
}

function storageKey(adapterId: string, idempotencyKey: string): string {
  return `${adapterId}\u0000${idempotencyKey}`;
}

class DurableMemoryRepository implements IdempotencyRepository {
  readonly records = new Map<string, IdempotencyRecord>();
  readonly events: string[] = [];

  async claim(input: IdempotencyClaimInput): Promise<IdempotencyClaimResult> {
    this.events.push("claim");
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
      adapterId: input.adapterId,
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
    this.events.push(`record:${input.status}`);
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

  forceOnlyRecordStatus(status: IdempotencyRecordStatus): void {
    const [entry] = [...this.records.entries()];
    if (entry === undefined) throw new Error("record required");
    const [key, current] = entry;
    this.records.set(key, createIdempotencyRecord({ ...current, status }));
  }
}

function adapter(environment: ExecutionEnvironment = "SANDBOX", overrides: Partial<BrokerAdapter> = {}): BrokerAdapter {
  const descriptor = createBrokerAdapterDescriptor({
    adapterId: "adapter-1",
    environment,
    credentialProfileRef: "credential-profile-1",
    capabilities,
  });
  return {
    descriptor,
    capabilities,
    submitEntry: vi.fn(async (request: EntrySubmissionRequest) => createEntryAcknowledgement({
      executionAttemptId: request.executionAttemptId,
      idempotencyKey: request.idempotencyKey,
      adapterOrderId: "order-1",
      acknowledgedAt: 1_100,
    })),
    submitProtection: vi.fn(async (_request: ProtectionRequest) => { throw new Error("forbidden"); }),
    cancelEntry: vi.fn(async (_request: EntryCancellationRequest) => { throw new Error("forbidden"); }),
    ...overrides,
  };
}

function context(environment: ExecutionEnvironment = "SANDBOX", submissionAsOf = 1_100): RealtimeExecutionSubmissionContext {
  return Object.freeze({
    executionEnvironment: environment,
    adapterId: brokerAdapterId("adapter-1"),
    credentialProfileRef: credentialProfileRef("credential-profile-1"),
    submissionAsOf,
  });
}

function engine(repository: DurableMemoryRepository, broker = adapter()) {
  return {
    broker,
    subject: new RealtimeExecutionSubmissionEngine(
      { maxPreparedPlanAgeMs: 100 },
      { adapterRegistry: createBrokerAdapterRegistry([broker]), idempotencyRepository: repository },
    ),
  };
}

describe("Task 020 gating and pre-claim controls", () => {
  it("validates and freezes the freshness configuration", () => {
    const repository = new DurableMemoryRepository();
    const subject = engine(repository).subject;
    expect(subject).toBeInstanceOf(RealtimeExecutionSubmissionEngine);
    expect(() => new RealtimeExecutionSubmissionEngine(
      { maxPreparedPlanAgeMs: -1 },
      { adapterRegistry: createBrokerAdapterRegistry([]), idempotencyRepository: repository },
    )).toThrow("non-negative safe integer");
  });

  it.each(["NO_PREPARATION", "PREPARATION_REJECTED", "DUPLICATE_PREPARATION"] as const)(
    "%s needs no context and has no durable or adapter side effects",
    async (status) => {
      const repository = new DurableMemoryRepository();
      const { subject, broker } = engine(repository);
      await expect(subject.submit({ preparation: nonActionable(status) })).resolves.toMatchObject({
        status: "NO_SUBMISSION", upstreamStatus: status,
      });
      expect(repository.events).toEqual([]);
      expect(broker.submitEntry).not.toHaveBeenCalled();
    },
  );

  it("requires valid actionable context and permits a corrected retry", async () => {
    const repository = new DurableMemoryRepository();
    const { subject, broker } = engine(repository);
    await expect(subject.submit({ preparation: prepared() })).rejects.toThrow("context is required");
    await expect(subject.submit({ preparation: prepared(), context: context("SANDBOX", 999) }))
      .rejects.toThrow("cannot precede");
    expect(repository.events).toEqual([]);
    expect(broker.submitEntry).not.toHaveBeenCalled();
    await expect(subject.submit({ preparation: prepared(), context: context() }))
      .resolves.toMatchObject({ status: "SUBMISSION_CONFIRMED" });
  });

  it("hard-blocks LIVE before registry resolution, durable claim, or adapter calls", async () => {
    const repository = new DurableMemoryRepository();
    const live = adapter("LIVE");
    const registry = createBrokerAdapterRegistry([]);
    const subject = new RealtimeExecutionSubmissionEngine(
      { maxPreparedPlanAgeMs: 100 },
      { adapterRegistry: registry, idempotencyRepository: repository },
    );
    await expect(subject.submit({ preparation: prepared(), context: context("LIVE") })).resolves.toMatchObject({
      status: "SUBMISSION_BLOCKED", reason: "LIVE_EXECUTION_DEFERRED",
    });
    expect(repository.events).toEqual([]);
    expect(live.submitEntry).not.toHaveBeenCalled();
    expect(live.submitProtection).not.toHaveBeenCalled();
    expect(live.cancelEntry).not.toHaveBeenCalled();
  });

  it("accepts the inclusive age boundary and blocks one millisecond beyond it", async () => {
    const acceptedRepository = new DurableMemoryRepository();
    const accepted = engine(acceptedRepository);
    await expect(accepted.subject.submit({ preparation: prepared(), context: context("SANDBOX", 1_100) }))
      .resolves.toMatchObject({ status: "SUBMISSION_CONFIRMED" });
    const staleRepository = new DurableMemoryRepository();
    const stale = engine(staleRepository);
    await expect(stale.subject.submit({ preparation: prepared(), context: context("SANDBOX", 1_101) }))
      .resolves.toMatchObject({ status: "SUBMISSION_BLOCKED", reason: "PREPARED_PLAN_EXPIRED" });
    expect(staleRepository.events).toEqual([]);
    expect(stale.broker.submitEntry).not.toHaveBeenCalled();
  });

  it("fails unknown adapter and descriptor binding mismatches before claim", async () => {
    const repository = new DurableMemoryRepository();
    const { subject, broker } = engine(repository);
    await expect(subject.submit({
      preparation: prepared(),
      context: { ...context(), adapterId: brokerAdapterId("missing") },
    }))
      .rejects.toThrow("Unknown broker adapter");
    await expect(subject.submit({
      preparation: prepared(),
      context: { ...context(), credentialProfileRef: credentialProfileRef("other") },
    }))
      .rejects.toThrow("credential profile");
    expect(repository.events).toEqual([]);
    expect(broker.submitEntry).not.toHaveBeenCalled();
  });
});

describe("entry-only durable orchestration", () => {
  it.each(["DRY_RUN", "SANDBOX"] as const)("submits one entry in %s with claim and SUBMITTED first", async (environment) => {
    const repository = new DurableMemoryRepository();
    let broker!: BrokerAdapter;
    broker = adapter(environment, {
      submitEntry: vi.fn(async (request) => {
        repository.events.push("adapter");
        expect((await repository.read(brokerAdapterId("adapter-1"), request.idempotencyKey))?.status).toBe("SUBMITTED");
        return createEntryAcknowledgement({
          executionAttemptId: request.executionAttemptId,
          idempotencyKey: request.idempotencyKey,
          adapterOrderId: "order-1",
          acknowledgedAt: 1_100,
        });
      }),
    });
    const { subject } = engine(repository, broker);
    const result = await subject.submit({ preparation: prepared(), context: context(environment) });
    expect(result.status).toBe("SUBMISSION_CONFIRMED");
    expect(repository.events).toEqual(["claim", "record:SUBMITTED", "adapter", "record:CONFIRMED"]);
    expect(broker.submitEntry).toHaveBeenCalledTimes(1);
    expect(broker.submitProtection).not.toHaveBeenCalled();
    expect(broker.cancelEntry).not.toHaveBeenCalled();
    if (result.status === "SUBMISSION_CONFIRMED") {
      expect(result.durableResult.acknowledgement?.kind).toBe("SUBMISSION_ACCEPTED");
      expect(result.executionAttempt.processedFills).toEqual([]);
    }
  });

  it("preserves typed adapter rejection without inventing a fill", async () => {
    const repository = new DurableMemoryRepository();
    const broker = adapter("SANDBOX", {
      submitEntry: vi.fn(async (request) => createEntryRejection({
        executionAttemptId: request.executionAttemptId,
        idempotencyKey: request.idempotencyKey,
        adapterReasonCode: "VENUE_REJECTED",
        rejectedAt: 1_100,
      })),
    });
    const result = await engine(repository, broker).subject.submit({ preparation: prepared(), context: context() });
    expect(result.status).toBe("SUBMISSION_REJECTED");
    expect(JSON.stringify(result)).not.toContain("FILLED");
  });

  it("replays a durable confirmation after engine restart with one total adapter call", async () => {
    const repository = new DurableMemoryRepository();
    const broker = adapter();
    const first = await engine(repository, broker).subject.submit({ preparation: prepared(), context: context() });
    const second = await engine(repository, broker).subject.submit({ preparation: prepared(), context: context() });
    expect(first.status).toBe("SUBMISSION_CONFIRMED");
    expect(second.status).toBe("SUBMISSION_CONFIRMED");
    expect(broker.submitEntry).toHaveBeenCalledTimes(1);
  });

  it("replays a durable rejection after engine restart with one total adapter call", async () => {
    const repository = new DurableMemoryRepository();
    const broker = adapter("SANDBOX", {
      submitEntry: vi.fn(async (request) => createEntryRejection({
        executionAttemptId: request.executionAttemptId,
        idempotencyKey: request.idempotencyKey,
        adapterReasonCode: "VENUE_REJECTED",
        rejectedAt: 1_100,
      })),
    });
    const first = await engine(repository, broker).subject.submit({ preparation: prepared(), context: context() });
    const second = await engine(repository, broker).subject.submit({ preparation: prepared(), context: context() });
    expect(first.status).toBe("SUBMISSION_REJECTED");
    expect(second.status).toBe("SUBMISSION_REJECTED");
    expect(broker.submitEntry).toHaveBeenCalledTimes(1);
  });

  it.each(["CLAIMED", "SUBMITTED", "OUTCOME_UNKNOWN"] as const)(
    "does not resubmit an existing %s durable state",
    async (status) => {
      const repository = new DurableMemoryRepository();
      const broker = adapter();
      await engine(repository, broker).subject.submit({ preparation: prepared(), context: context() });
      repository.forceOnlyRecordStatus(status);
      const result = await engine(repository, broker).subject.submit({ preparation: prepared(), context: context() });
      expect(result.status).toBe("RECONCILIATION_REQUIRED");
      expect(broker.submitEntry).toHaveBeenCalledTimes(1);
    },
  );

  it("turns an exposed adapter throw into durable reconciliation and never blindly resubmits", async () => {
    const repository = new DurableMemoryRepository();
    const failure = createBrokerFailure({
      category: "TIMEOUT",
      certainty: "OUTCOME_UNKNOWN",
      submissionExposure: "MAY_HAVE_BEEN_SUBMITTED",
    });
    const broker = adapter("SANDBOX", { submitEntry: vi.fn(async () => { throw failure; }) });
    const first = await engine(repository, broker).subject.submit({ preparation: prepared(), context: context() });
    const second = await engine(repository, broker).subject.submit({ preparation: prepared(), context: context() });
    expect(first.status).toBe("RECONCILIATION_REQUIRED");
    expect(second.status).toBe("RECONCILIATION_REQUIRED");
    expect(broker.submitEntry).toHaveBeenCalledTimes(1);
  });

  it("preserves a cross-environment durable conflict with zero second adapter calls", async () => {
    const repository = new DurableMemoryRepository();
    const sandbox = adapter("SANDBOX");
    await engine(repository, sandbox).subject.submit({ preparation: prepared(), context: context("SANDBOX") });
    const dryRun = adapter("DRY_RUN");
    const result = await engine(repository, dryRun).subject.submit({ preparation: prepared(), context: context("DRY_RUN") });
    expect(result).toMatchObject({
      status: "DURABLE_SUBMISSION_CONTROL",
      durableResult: { status: "IDEMPOTENCY_CONFLICT" },
    });
    expect(sandbox.submitEntry).toHaveBeenCalledTimes(1);
    expect(dryRun.submitEntry).not.toHaveBeenCalled();
  });

  it("uses durable claim arbitration for concurrent identical submissions", async () => {
    const repository = new DurableMemoryRepository();
    const broker = adapter();
    const first = engine(repository, broker).subject;
    const second = engine(repository, broker).subject;
    const results = await Promise.all([
      first.submit({ preparation: prepared(), context: context() }),
      second.submit({ preparation: prepared(), context: context() }),
    ]);
    expect(broker.submitEntry).toHaveBeenCalledTimes(1);
    expect(results.map((result) => result.status).sort()).toEqual([
      "RECONCILIATION_REQUIRED", "SUBMISSION_CONFIRMED",
    ]);
  });

  it("does not mutate inputs and freezes the public result", async () => {
    const repository = new DurableMemoryRepository();
    const preparation = prepared();
    const submissionContext = context();
    const before = JSON.stringify({ preparation, submissionContext });
    const result = await engine(repository).subject.submit({ preparation, context: submissionContext });
    expect(JSON.stringify({ preparation, submissionContext })).toBe(before);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.executionAttempt)).toBe(true);
  });
});

const integrationSource = marketDataSource("task-021-integration-feed");
const oneMinute = parseTimeframe("1m");

function integrationAnalysisConfig(): RealtimeAnalysisConfig {
  return {
    profileVersion: "submission-integration-v1",
    instrumentId: instrument,
    source: integrationSource,
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
      breakoutAllowedRegimes: [
        "TREND_UP", "TREND_DOWN", "RANGE", "COMPRESSION", "EXPANSION", "TRANSITION",
      ],
      reversalAllowedRegimes: [],
    },
    cycleDeduplicationWindowSize: 16,
  };
}

function integrationTrades(): readonly MarketDataEvent<TradeTick>[] {
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
        source: integrationSource,
        eventTime,
        receivedAt: eventTime,
        payload: createTradeTick({ price, quantity: "1", side: "UNKNOWN" }),
        quality: ["LIVE"],
      }));
    }
  });
  events.push(createMarketDataEvent({
    instrumentId: instrument,
    source: integrationSource,
    eventTime: 361_000,
    receivedAt: 361_000,
    payload: createTradeTick({ price: "16", quantity: "1", side: "UNKNOWN" }),
    quality: ["LIVE"],
  }));
  return Object.freeze(events);
}

function integrationDecisionContext(asOf: number): DecisionContext {
  return {
    riskCosts: createRiskCostAssumptions({ entryCostBps: 0, targetExitCostBps: 0, stopExitCostBps: 0 }),
    riskConfig: createRiskQualificationConfig({ minimumNetRewardRiskBps: 30_000 }),
    account: createAccountRiskSnapshot({
      asOf,
      baseCurrency: "USD",
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
      pnlCurrency: "USD",
      quantityUnit: "contract",
      quantityStep: "1",
      minimumQuantity: "1",
      maximumQuantity: "1000",
      pnlValuePerPriceUnitPerQuantity: "1",
    }),
  };
}

function integrationPreparationContext(decision: TradeIntentCreatedResult): ExecutionPreparationContext {
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
  readonly decision: RealtimeDecisionResult;
  readonly preparation: RealtimeExecutionPreparationResult;
}

function collectUpstream(
  analyzed: RealtimeAnalysisProcessResult,
  decisionEngine: RealtimeDecisionEngine,
  preparationEngine: RealtimeExecutionPreparationEngine,
  results: UpstreamResult[],
): void {
  if (analyzed.status !== "ANALYSIS_CYCLES") return;
  for (const analysis of analyzed.cycles) {
    const decision = decisionEngine.process({ analysis, context: integrationDecisionContext(analysis.analysisAsOf) });
    const preparation = decision.status === "TRADE_INTENT_CREATED"
      ? preparationEngine.process({ decision, context: integrationPreparationContext(decision) })
      : preparationEngine.process({ decision });
    results.push(Object.freeze({ decision, preparation }));
  }
}

function upstreamPath(mode: "HISTORICAL" | "LIVE"): readonly UpstreamResult[] {
  const analysisEngine = new RealtimeAnalysisEngine(integrationAnalysisConfig());
  const decisionEngine = new RealtimeDecisionEngine({ profileVersion: "decision-v1", recentDecisionWindowSize: 16 });
  const preparationEngine = new RealtimeExecutionPreparationEngine({
    profileVersion: "preparation-v1",
    recentPreparationWindowSize: 16,
  });
  const results: UpstreamResult[] = [];
  if (mode === "HISTORICAL") {
    const candleEngine = new MultiTimeframeCandleEngine({
      instrumentId: instrument,
      source: integrationSource,
      alignments: [{ timeframe: oneMinute, anchorTime: unixMs(0) }],
    });
    new HistoricalReplayEngine(new ArrayHistoricalEventSource(integrationTrades())).run({
      onEvent(event): void {
        collectUpstream(
          analysisEngine.processCandleEvents(candleEngine.process(event)),
          decisionEngine,
          preparationEngine,
          results,
        );
      },
    });
    return Object.freeze(results);
  }
  const ingestionEngine = new LiveTradeIngestionEngine({
    source: createLiveMarketDataSourceDescriptor({
      sourceId: integrationSource,
      mode: "LIVE",
      capabilities: ["TRADE"],
      sequenceSemantics: "NONE",
    }),
    instrumentId: instrument,
    initialEpochId: sourceEpochId("task-021-integration-epoch"),
    initialEpochTime: unixMs(0),
    alignments: [{ timeframe: oneMinute, anchorTime: unixMs(0) }],
    deduplicationWindowSize: 64,
  });
  integrationTrades().forEach((event, index) => {
    const ingestion = ingestionEngine.ingest(createLiveTradeEvent({
      sourceEventId: `task-021-integration-${index}`,
      event,
    }), event.eventTime);
    collectUpstream(
      analysisEngine.processLiveIngestion(ingestion),
      decisionEngine,
      preparationEngine,
      results,
    );
  });
  return Object.freeze(results);
}

describe("actual live/replay pipeline through Task 021", () => {
  it("produces equivalent isolated durable entry submissions", async () => {
    const historical = upstreamPath("HISTORICAL");
    const live = upstreamPath("LIVE");
    expect(historical).toHaveLength(6);
    expect(live).toHaveLength(6);
    const historicalFinal = historical[5]!;
    const liveFinal = live[5]!;
    expect(historicalFinal.decision.decisionCycleId).toBe(liveFinal.decision.decisionCycleId);
    expect(historicalFinal.preparation.preparationCycleId).toBe(liveFinal.preparation.preparationCycleId);
    expect(historicalFinal.preparation).toEqual(liveFinal.preparation);
    if (historicalFinal.preparation.status !== "EXECUTION_PREPARED"
      || liveFinal.preparation.status !== "EXECUTION_PREPARED") throw new Error("expected prepared paths");

    const historicalRepository = new DurableMemoryRepository();
    const liveRepository = new DurableMemoryRepository();
    const historicalResult = await engine(historicalRepository).subject.submit({
      preparation: historicalFinal.preparation,
      context: context("SANDBOX", historicalFinal.preparation.preparationAsOf + 10),
    });
    const liveResult = await engine(liveRepository).subject.submit({
      preparation: liveFinal.preparation,
      context: context("SANDBOX", liveFinal.preparation.preparationAsOf + 10),
    });
    expect(historicalResult.status).toBe("SUBMISSION_CONFIRMED");
    expect(liveResult.status).toBe("SUBMISSION_CONFIRMED");
    if (historicalResult.status !== "SUBMISSION_CONFIRMED"
      || liveResult.status !== "SUBMISSION_CONFIRMED") throw new Error("expected confirmations");
    expect(historicalResult.executionAttempt.executionPlanId).toBe(liveResult.executionAttempt.executionPlanId);
    expect(historicalResult.durableResult.idempotencyKey).toBe(liveResult.durableResult.idempotencyKey);
    expect(historicalResult.durableResult.acknowledgement).toEqual(liveResult.durableResult.acknowledgement);
    expect(historicalRepository).not.toBe(liveRepository);
  });
});
