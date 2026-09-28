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
  applyRealtimeExecutionFill,
  initializeRealtimeExecutionFillLifecycle,
} from "@ulte/realtime-execution-fill-engine";
import { RealtimeExecutionExitFillEngine } from "@ulte/realtime-execution-exit-fill-engine";
import { RealtimeExecutionProtectionEngine } from "@ulte/realtime-execution-protection-engine";
import { RealtimeExecutionProtectionLifecycleEngine } from "@ulte/realtime-execution-protection-lifecycle-engine";
import { RealtimeExecutionSubmissionEngine } from "@ulte/realtime-execution-submission-engine";
import { createRiskCostAssumptions, createRiskQualificationConfig } from "@ulte/risk-engine";
import { RealtimeTradeAccountingEngine } from "./index.js";

const instrument = createInstrumentId({ venue: "TEST", venueSymbol: "ABC", instrumentKind: "CFD" });
const source = marketDataSource("task-027b-integration-feed");
const oneMinute = parseTimeframe("1m");
const capabilities = createAdapterCapabilities({
  supportsClientIdempotency: true,
  supportsCloseOnlyExit: true,
  supportsNativeBracketProtection: false,
  supportsProtectionModification: false,
  supportsOrderCancellation: true,
  supportsPartialFillReporting: true,
});
const accountingSpec = createLinearInstrumentSizingSpec({
  valuationModel: "LINEAR_PRICE_PNL",
  instrumentId: instrument,
  pnlCurrency: currencyCode("USD"),
  quantityUnit: "contract",
  quantityStep: "1",
  minimumQuantity: "1",
  maximumQuantity: "1000",
  pnlValuePerPriceUnitPerQuantity: "1",
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

  async recordOutcome(input: IdempotencyOutcomeInput): Promise<IdempotencyRecord> {
    const key = `${input.adapterId}\u0000${input.idempotencyKey}`;
    const current = this.records.get(key);
    if (current === undefined) throw new Error("outcome without claim");
    const record = createIdempotencyRecord({
      ...current,
      status: input.status,
      updatedAt: input.updatedAt,
      ...(input.adapterOrderId === undefined ? {} : { adapterOrderId: input.adapterOrderId }),
    });
    this.records.set(key, record);
    return record;
  }
}

function adapter(): BrokerAdapter {
  return {
    descriptor: createBrokerAdapterDescriptor({
      adapterId: "task-027b-adapter",
      environment: "SANDBOX",
      credentialProfileRef: "task-027b-credentials",
      capabilities,
    }),
    capabilities,
    submitEntry: vi.fn(async (request: EntrySubmissionRequest) => createEntryAcknowledgement({
      executionAttemptId: request.executionAttemptId,
      idempotencyKey: request.idempotencyKey,
      adapterOrderId: "task-027b-order",
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
    profileVersion: "task-027b-analysis-v1",
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
    instrumentSizingSpec: accountingSpec,
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
  const decision = new RealtimeDecisionEngine({ profileVersion: "task-027b-decision-v1", recentDecisionWindowSize: 16 });
  const preparation = new RealtimeExecutionPreparationEngine({
    profileVersion: "task-027b-preparation-v1",
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
      initialEpochId: sourceEpochId("task-027b-epoch"),
      initialEpochTime: unixMs(0),
      alignments: [{ timeframe: oneMinute, anchorTime: unixMs(0) }],
      deduplicationWindowSize: 64,
    });
    trades().forEach((event, index) => collect(
      analysis.processLiveIngestion(ingestion.ingest(createLiveTradeEvent({
        sourceEventId: `task-027b-${index}`,
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

function assertProjectionHasNoSideEffects<T>(
  broker: BrokerAdapter,
  repository: MemoryRepository,
  projection: () => T,
): T {
  const before = externalCounts(broker, repository);
  const result = projection();
  expect(externalCounts(broker, repository)).toEqual(before);
  return result;
}

async function project(mode: "HISTORICAL" | "LIVE") {
  const upstream = upstreamPath(mode);
  const final = upstream[5]!;
  if (final.preparation.status !== "EXECUTION_PREPARED") throw new Error("path did not prepare execution");
  const repository = new MemoryRepository();
  const broker = adapter();
  const accounting = new RealtimeTradeAccountingEngine();
  const submission = await new RealtimeExecutionSubmissionEngine(
    { maxPreparedPlanAgeMs: 100 },
    { adapterRegistry: createBrokerAdapterRegistry([broker]), idempotencyRepository: repository },
  ).submit({
    preparation: final.preparation,
    context: {
      executionEnvironment: "SANDBOX",
      adapterId: brokerAdapterId("task-027b-adapter"),
      credentialProfileRef: credentialProfileRef("task-027b-credentials"),
      submissionAsOf: final.preparation.preparationAsOf + 10,
    },
  });
  if (submission.status !== "SUBMISSION_CONFIRMED") throw new Error("submission not confirmed");
  const initialized = initializeRealtimeExecutionFillLifecycle(submission);
  if (initialized.status !== "FILL_LIFECYCLE_INITIALIZED") throw new Error("fill lifecycle not initialized");
  const entryEvent = createFillEvent({
    executionAttemptId: initialized.executionAttempt.executionAttemptId,
    adapterOrderId: "task-027b-order",
    fillId: "task-027b-entry-fill",
    filledQuantity: initialized.executionAttempt.quantity,
    fillPrice: "16.5",
    filledAt: 400_001,
  });
  const fill = applyRealtimeExecutionFill({
    submission,
    executionAttempt: initialized.executionAttempt,
    fill: entryEvent,
    observationAsOf: 400_001,
  });
  if (fill.status !== "FILL_APPLIED") throw new Error("entry fill failed");
  const entryAccounting = assertProjectionHasNoSideEffects(broker, repository, () => accounting.project({
    sourceKind: "ENTRY_FILL", fillLifecycle: fill, accountingSpec,
  }));
  const duplicateFill = applyRealtimeExecutionFill({
    submission,
    executionAttempt: fill.executionAttempt,
    fill: entryEvent,
    observationAsOf: 400_001,
  });
  if (duplicateFill.status !== "DUPLICATE_FILL") throw new Error("entry duplicate failed");
  const duplicateEntryAccounting = assertProjectionHasNoSideEffects(broker, repository, () => accounting.project({
    sourceKind: "ENTRY_FILL", fillLifecycle: duplicateFill, accountingSpec,
  }));

  const protection = await new RealtimeExecutionProtectionEngine({
    adapterRegistry: createBrokerAdapterRegistry([broker]),
    idempotencyRepository: repository,
  }).submit({
    fillLifecycle: fill,
    context: {
      executionEnvironment: "SANDBOX",
      adapterId: brokerAdapterId("task-027b-adapter"),
      credentialProfileRef: credentialProfileRef("task-027b-credentials"),
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

  const exitProjector = new RealtimeExecutionExitFillEngine();
  const firstExitEvent = createExitFillEvent({
    executionAttemptId: lifecycle.executionAttempt.executionAttemptId,
    protectionRequestId: lifecycle.executionAttempt.acknowledgedProtections[0]!.request.protectionRequestId,
    exitSide: lifecycle.executionAttempt.exitSide,
    exitLeg: "PROTECTIVE_STOP",
    fillId: "task-027b-exit-fill-1",
    filledQuantity: "1",
    fillPrice: "14",
    filledAt: 400_003,
  });
  const firstExit = exitProjector.apply({
    protectionLifecycle: lifecycle,
    executionAttempt: lifecycle.executionAttempt,
    exitFill: firstExitEvent,
    observationAsOf: 400_003,
  });
  if (firstExit.status !== "EXIT_FILL_APPLIED") throw new Error("partial exit failed");
  const partialAccounting = assertProjectionHasNoSideEffects(broker, repository, () => accounting.project({
    sourceKind: "EXIT_FILL", exitFillLifecycle: firstExit, accountingSpec,
  }));
  const duplicateExit = exitProjector.apply({
    protectionLifecycle: lifecycle,
    executionAttempt: firstExit.executionAttempt,
    exitFill: firstExitEvent,
    observationAsOf: 400_003,
  });
  if (duplicateExit.status !== "DUPLICATE_EXIT_FILL") throw new Error("exit duplicate failed");
  const duplicateExitAccounting = assertProjectionHasNoSideEffects(broker, repository, () => accounting.project({
    sourceKind: "EXIT_FILL", exitFillLifecycle: duplicateExit, accountingSpec,
  }));

  const remainingQuantity = (BigInt(lifecycle.executionAttempt.quantity) - 1n).toString();
  const finalExitEvent = createExitFillEvent({
    executionAttemptId: lifecycle.executionAttempt.executionAttemptId,
    protectionRequestId: lifecycle.executionAttempt.acknowledgedProtections[0]!.request.protectionRequestId,
    exitSide: lifecycle.executionAttempt.exitSide,
    exitLeg: "PROFIT_TARGET",
    fillId: "task-027b-exit-fill-2",
    filledQuantity: remainingQuantity,
    fillPrice: "20",
    filledAt: 400_004,
  });
  const finalExit = exitProjector.apply({
    protectionLifecycle: lifecycle,
    executionAttempt: firstExit.executionAttempt,
    exitFill: finalExitEvent,
    observationAsOf: 400_004,
  });
  if (finalExit.status !== "EXIT_FILL_APPLIED") throw new Error("final exit failed");
  const finalAccounting = assertProjectionHasNoSideEffects(broker, repository, () => accounting.project({
    sourceKind: "EXIT_FILL", exitFillLifecycle: finalExit, accountingSpec,
  }));
  return {
    upstream,
    final,
    submission,
    fill,
    duplicateFill,
    entryAccounting,
    duplicateEntryAccounting,
    protection,
    lifecycle,
    firstExit,
    duplicateExit,
    partialAccounting,
    duplicateExitAccounting,
    finalExit,
    finalAccounting,
    broker,
    repository,
  };
}

describe("historical/live equivalence through Task 027B", () => {
  it("projects equal open, partial, duplicate, and closed accounting with zero projection side effects", async () => {
    const historical = await project("HISTORICAL");
    const live = await project("LIVE");
    expect(historical.final.analysisCycleId).toBe(live.final.analysisCycleId);
    expect(historical.final.decision.decisionCycleId).toBe(live.final.decision.decisionCycleId);
    expect(historical.final.preparation.preparationCycleId).toBe(live.final.preparation.preparationCycleId);
    expect(historical.fill).toEqual(live.fill);
    expect(historical.duplicateFill).toEqual(live.duplicateFill);
    expect(historical.entryAccounting).toEqual(live.entryAccounting);
    expect(historical.entryAccounting).toMatchObject({
      status: "REALIZED_ACCOUNTING_PROJECTED",
      accounting: { grossRealizedPnl: "0", positionExposure: { exposureState: "OPEN" } },
    });
    expect(historical.duplicateEntryAccounting).toMatchObject({
      status: "REALIZED_ACCOUNTING_PROJECTED", upstreamStatus: "DUPLICATE_FILL",
    });
    expect(live.duplicateEntryAccounting).toMatchObject({
      status: "REALIZED_ACCOUNTING_PROJECTED", upstreamStatus: "DUPLICATE_FILL",
    });
    if (historical.entryAccounting.status !== "REALIZED_ACCOUNTING_PROJECTED"
      || historical.duplicateEntryAccounting.status !== "REALIZED_ACCOUNTING_PROJECTED"
      || live.entryAccounting.status !== "REALIZED_ACCOUNTING_PROJECTED"
      || live.duplicateEntryAccounting.status !== "REALIZED_ACCOUNTING_PROJECTED") {
      throw new Error("entry accounting was not projected");
    }
    expect(historical.duplicateEntryAccounting.accounting).toEqual(historical.entryAccounting.accounting);
    expect(live.duplicateEntryAccounting.accounting).toEqual(live.entryAccounting.accounting);
    expect(historical.protection).toEqual(live.protection);
    expect(historical.lifecycle).toEqual(live.lifecycle);
    expect(historical.firstExit).toEqual(live.firstExit);
    expect(historical.partialAccounting).toEqual(live.partialAccounting);
    expect(historical.partialAccounting).toMatchObject({
      status: "REALIZED_ACCOUNTING_PROJECTED",
      accounting: {
        grossRealizedPnl: "-2.5",
        openBasisLots: [{ entryPrice: "16.5" }],
        positionExposure: { exposureState: "PARTIALLY_EXITED" },
      },
    });
    expect(historical.duplicateExit).toEqual(live.duplicateExit);
    expect(historical.duplicateExitAccounting).toMatchObject({
      status: "REALIZED_ACCOUNTING_PROJECTED", upstreamStatus: "DUPLICATE_EXIT_FILL",
    });
    expect(live.duplicateExitAccounting).toMatchObject({
      status: "REALIZED_ACCOUNTING_PROJECTED", upstreamStatus: "DUPLICATE_EXIT_FILL",
    });
    if (historical.partialAccounting.status !== "REALIZED_ACCOUNTING_PROJECTED"
      || historical.duplicateExitAccounting.status !== "REALIZED_ACCOUNTING_PROJECTED"
      || live.partialAccounting.status !== "REALIZED_ACCOUNTING_PROJECTED"
      || live.duplicateExitAccounting.status !== "REALIZED_ACCOUNTING_PROJECTED") {
      throw new Error("exit accounting was not projected");
    }
    expect(historical.duplicateExitAccounting.accounting).toEqual(historical.partialAccounting.accounting);
    expect(live.duplicateExitAccounting.accounting).toEqual(live.partialAccounting.accounting);
    expect(historical.finalExit).toEqual(live.finalExit);
    expect(historical.finalAccounting).toEqual(live.finalAccounting);
    expect(historical.finalAccounting).toMatchObject({
      status: "REALIZED_ACCOUNTING_PROJECTED",
      accounting: {
        openQuantity: "0",
        openBasisLots: [],
        positionExposure: { exposureState: "CLOSED" },
      },
    });
    for (const branch of [historical, live]) {
      expect(branch.broker.submitEntry).toHaveBeenCalledTimes(1);
      expect(branch.broker.submitProtection).toHaveBeenCalledTimes(1);
      expect(branch.broker.cancelEntry).not.toHaveBeenCalled();
      expect(branch.repository.records.size).toBe(2);
    }
    expect(historical.repository).not.toBe(live.repository);
    expect(historical.broker).not.toBe(live.broker);
  });
});
