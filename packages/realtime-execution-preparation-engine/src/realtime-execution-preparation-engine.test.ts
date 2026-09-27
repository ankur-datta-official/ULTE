import { describe, expect, it, vi } from "vitest";
import { ArrayHistoricalEventSource, HistoricalReplayEngine } from "@ulte/backtest-engine";
import {
  createExecutionMarketSnapshot,
  createExecutionPreparationConfig,
  createInstrumentExecutionSpec,
  prepareExecutionPlan,
  type ExecutionPreparationInput,
} from "@ulte/execution-preparation-engine";
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
  createCandle,
  createMarketDataEvent,
  createTradeTick,
  marketDataSource,
  MultiTimeframeCandleEngine,
  type CandleSnapshot,
  type MarketDataEvent,
  type TradeTick,
} from "@ulte/market-data";
import {
  createAccountRiskSnapshot,
  createPortfolioRiskConfig,
} from "@ulte/portfolio-risk-engine";
import { createLinearInstrumentSizingSpec } from "@ulte/position-sizing-engine";
import {
  RealtimeAnalysisEngine,
  type AnalysisCycleResult,
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
  createRiskCostAssumptions,
  createRiskQualificationConfig,
} from "@ulte/risk-engine";
import type { ReadyTradeIntent } from "@ulte/trade-intent-engine";
import {
  AlreadyPublishedPreparationBoundaryError,
  PreparationContextConflictError,
  RealtimeExecutionPreparationEngine,
  createRealtimeExecutionPreparationConfig,
  encodePreparationFields,
  type ExecutionPreparationContext,
  type RealtimeExecutionPreparationEvaluators,
  type RealtimeExecutionPreparationResult,
} from "./index.js";

const instrument = createInstrumentId({ venue: "TEST", venueSymbol: "ABC", instrumentKind: "CFD" });
const source = marketDataSource("test-feed");

function intent(boundary = 1_000, overrides: Partial<ReadyTradeIntent> = {}): ReadyTradeIntent {
  return Object.freeze({
    status: "INTENT_READY",
    schemaVersion: "TRADE_INTENT_V1",
    intentId: `intent-${boundary}`,
    candidateId: `candidate-${boundary}`,
    instrumentId: instrument,
    asOf: unixMs(boundary),
    family: "TREND_PULLBACK_CONTINUATION",
    direction: "UP",
    contextTimeframe: parseTimeframe("1d"),
    setupTimeframe: parseTimeframe("4h"),
    entryReferencePrice: positiveDecimalString("100.00"),
    invalidationPrice: positiveDecimalString("90.00"),
    primaryTargetPrice: positiveDecimalString("130.00"),
    quantityUnit: "contracts",
    quantity: positiveDecimalString("1.00"),
    quantityStep: positiveDecimalString("0.01"),
    accountCurrency: currencyCode("USD"),
    pnlCurrency: currencyCode("USD"),
    conversionRate: positiveDecimalString("1"),
    approvedRiskAmount: positiveDecimalString("25.123"),
    actualRiskAmount: positiveDecimalString("20.246"),
    unusedRiskAmount: "4.877" as ReadyTradeIntent["unusedRiskAmount"],
    riskUtilizationBps: "8058",
    structuralNetRisk: positiveDecimalString("10.123"),
    netRewardRiskBps: "31234",
    minimumRequiredNetRewardRiskBps: 30_000,
    pnlValuePerPriceUnitPerQuantity: positiveDecimalString("2"),
    riskPerQuantityUnitInAccountCurrency: positiveDecimalString("20.246"),
    riskPerQuantityStep: positiveDecimalString("0.20246"),
    cappedByMaximumQuantity: false,
    ...overrides,
  });
}

function actionable(boundary = 1_000, overrides: Partial<ReadyTradeIntent> = {}): TradeIntentCreatedResult {
  return Object.freeze({
    status: "TRADE_INTENT_CREATED",
    analysisCycleId: `analysis-${boundary}`,
    decisionCycleId: `decision-${boundary}`,
    decisionProfileId: "decision-profile-v1",
    analysisAsOf: unixMs(boundary),
    triggerCloseTime: unixMs(boundary),
    setupCandidate: Object.freeze({}) as TradeIntentCreatedResult["setupCandidate"],
    structuralRiskResult: Object.freeze({}) as TradeIntentCreatedResult["structuralRiskResult"],
    portfolioRiskResult: Object.freeze({}) as TradeIntentCreatedResult["portfolioRiskResult"],
    positionSizingResult: Object.freeze({}) as TradeIntentCreatedResult["positionSizingResult"],
    tradeIntentResult: intent(boundary, overrides),
  }) as TradeIntentCreatedResult;
}

function noDecision(boundary = 1_000): RealtimeDecisionResult {
  return Object.freeze({
    status: "NO_DECISION",
    reason: "NO_SETUP",
    analysisCycleId: `analysis-${boundary}`,
    decisionCycleId: `decision-${boundary}`,
    decisionProfileId: "decision-profile-v1",
    analysisAsOf: unixMs(boundary),
    triggerCloseTime: unixMs(boundary),
  }) as RealtimeDecisionResult;
}

function rejectedDecision(boundary = 1_000): RealtimeDecisionResult {
  return Object.freeze({
    status: "DECISION_REJECTED",
    blockingStage: "MULTIPLE_ACTIONABLE_CANDIDATES",
    reason: "MULTIPLE_ACTIONABLE_CANDIDATES_UNSUPPORTED",
    candidateIds: Object.freeze(["a", "b"]),
    analysisCycleId: `analysis-${boundary}`,
    decisionCycleId: `decision-${boundary}`,
    decisionProfileId: "decision-profile-v1",
    analysisAsOf: unixMs(boundary),
    triggerCloseTime: unixMs(boundary),
  }) as RealtimeDecisionResult;
}

function duplicateDecision(boundary = 1_000): RealtimeDecisionResult {
  return Object.freeze({
    status: "DUPLICATE_DECISION",
    originalStatus: "TRADE_INTENT_CREATED",
    analysisCycleId: `analysis-${boundary}`,
    decisionCycleId: `decision-${boundary}`,
    decisionProfileId: "decision-profile-v1",
    analysisAsOf: unixMs(boundary),
    triggerCloseTime: unixMs(boundary),
  }) as RealtimeDecisionResult;
}

function context(boundary = 1_000, overrides: Partial<ExecutionPreparationContext> = {}): ExecutionPreparationContext {
  return {
    preparationAsOf: boundary + 100,
    marketSnapshot: {
      instrumentId: instrument,
      asOf: boundary + 50,
      bid: "99.99",
      ask: "100.00",
    },
    instrumentExecutionSpec: {
      instrumentId: instrument,
      priceTick: "0.01",
      quantityStep: "0.01",
      minimumQuantity: "0.01",
      maximumQuantity: "10.00",
    },
    config: {
      maxIntentAgeMs: 100,
      maxQuoteAgeMs: 50,
      maxEntryDeviationBps: 1_000,
    },
    ...overrides,
  };
}

function evaluators(
  implementation: RealtimeExecutionPreparationEvaluators["prepareExecutionPlan"] = prepareExecutionPlan,
): RealtimeExecutionPreparationEvaluators {
  return { prepareExecutionPlan: vi.fn(implementation) };
}

function engine(
  injected?: RealtimeExecutionPreparationEvaluators,
  window = 4,
  profileVersion = "preparation-v1",
): RealtimeExecutionPreparationEngine {
  return new RealtimeExecutionPreparationEngine({
    profileVersion,
    recentPreparationWindowSize: window,
  }, injected);
}

describe("configuration and non-actionable Task 019 inputs", () => {
  it("validates and freezes orchestration configuration", () => {
    expect(Object.isFrozen(createRealtimeExecutionPreparationConfig({
      profileVersion: "v1",
      recentPreparationWindowSize: 1,
    }))).toBe(true);
    expect(() => createRealtimeExecutionPreparationConfig({ profileVersion: "", recentPreparationWindowSize: 1 })).toThrow();
    expect(() => createRealtimeExecutionPreparationConfig({ profileVersion: "v1", recentPreparationWindowSize: 0 })).toThrow();
  });

  it("maps NO_DECISION to explicit NO_PREPARATION", () => {
    expect(engine().process({ decision: noDecision() })).toMatchObject({
      status: "NO_PREPARATION",
      reason: "UPSTREAM_NO_DECISION",
      upstreamDecisionStatus: "NO_DECISION",
    });
  });

  it("maps DECISION_REJECTED to explicit NO_PREPARATION", () => {
    expect(engine().process({ decision: rejectedDecision() })).toMatchObject({
      status: "NO_PREPARATION",
      reason: "UPSTREAM_DECISION_REJECTED",
    });
  });

  it("maps DUPLICATE_DECISION to explicit NO_PREPARATION without reconstructing an intent", () => {
    expect(engine().process({ decision: duplicateDecision() })).toMatchObject({
      status: "NO_PREPARATION",
      reason: "DUPLICATE_DECISION_INPUT",
    });
  });

  it.each([noDecision(), rejectedDecision(), duplicateDecision()])(
    "does not invoke preparation for $status",
    (decision) => {
      const spies = evaluators();
      engine(spies).process({ decision });
      expect(spies.prepareExecutionPlan).not.toHaveBeenCalled();
    },
  );

  it("ignores malformed, irrelevant context on a non-actionable branch", () => {
    const bad = { preparationAsOf: -1 } as ExecutionPreparationContext;
    expect(engine().process({ decision: noDecision(), context: bad }).status).toBe("NO_PREPARATION");
  });

  it("deduplicates a repeated non-actionable boundary", () => {
    const subject = engine();
    subject.process({ decision: noDecision() });
    expect(subject.process({ decision: noDecision() })).toMatchObject({
      status: "DUPLICATE_PREPARATION",
      originalStatus: "NO_PREPARATION",
    });
  });

  it("keeps a Task 019 duplicate input a no-op after the original was prepared", () => {
    const spies = evaluators();
    const subject = engine(spies);
    subject.process({ decision: actionable(), context: context() });
    expect(subject.process({ decision: duplicateDecision() })).toMatchObject({
      status: "NO_PREPARATION",
      reason: "DUPLICATE_DECISION_INPUT",
    });
    expect(spies.prepareExecutionPlan).toHaveBeenCalledOnce();
  });
});

describe("context validation, existing preparation integration, and expected rejection", () => {
  it("requires context for an actionable result before publication and permits corrected retry", () => {
    const subject = engine();
    expect(() => subject.process({ decision: actionable() })).toThrow(/context is required/);
    expect(subject.getRecentPreparationCount()).toBe(0);
    expect(subject.getLatestPublishedDecisionBoundaryTime()).toBeUndefined();
    expect(subject.process({ decision: actionable(), context: context() }).status).toBe("EXECUTION_PREPARED");
  });

  it("validates/copies context with existing constructors before delegating", () => {
    const spies = evaluators();
    engine(spies).process({ decision: actionable(), context: context() });
    expect(spies.prepareExecutionPlan).toHaveBeenCalledOnce();
    const delegated = vi.mocked(spies.prepareExecutionPlan).mock.calls[0]![0];
    expect(Object.isFrozen(delegated.marketSnapshot)).toBe(true);
    expect(Object.isFrozen(delegated.instrumentExecutionSpec)).toBe(true);
    expect(Object.isFrozen(delegated.config)).toBe(true);
    expect(delegated.executionAsOf).toBe(1_100);
  });

  it("returns the existing successful plan without fabricating one", () => {
    const result = engine().process({ decision: actionable(), context: context() });
    expect(result).toMatchObject({
      status: "EXECUTION_PREPARED",
      preparationAsOf: 1_100,
      executionPreparationResult: { status: "EXECUTION_PLAN_READY" },
    });
    if (result.status === "EXECUTION_PREPARED") {
      expect(result.executionPreparationResult.tradeIntentId).toBe(result.tradeIntentResult.intentId);
    }
  });

  it("preserves the actual stale-market rejection", () => {
    const stale = context(1_000, { config: { ...context().config, maxQuoteAgeMs: 49 } });
    expect(engine().process({ decision: actionable(), context: stale })).toMatchObject({
      status: "PREPARATION_REJECTED",
      executionPreparationResult: { status: "PLAN_NOT_PREPARABLE", reason: "MARKET_SNAPSHOT_STALE" },
    });
  });

  it("preserves a quote-predates-intent rejection", () => {
    const result = engine().process({
      decision: actionable(),
      context: context(1_000, { marketSnapshot: { ...context().marketSnapshot, asOf: 999 } }),
    });
    expect(result).toMatchObject({
      status: "PREPARATION_REJECTED",
      executionPreparationResult: { reason: "QUOTE_PREDATES_TRADE_INTENT" },
    });
  });

  it("preserves future-quote rejection relative to the explicit preparation boundary", () => {
    const result = engine().process({
      decision: actionable(),
      context: context(1_000, {
        preparationAsOf: 1_050,
        marketSnapshot: { ...context().marketSnapshot, asOf: 1_051 },
      }),
    });
    expect(result).toMatchObject({
      status: "PREPARATION_REJECTED",
      executionPreparationResult: { status: "DATA_REJECTED", reason: "FUTURE_MARKET_SNAPSHOT" },
    });
  });

  it("preserves execution-before-intent rejection", () => {
    const result = engine().process({
      decision: actionable(),
      context: context(1_000, {
        preparationAsOf: 999,
        marketSnapshot: { ...context().marketSnapshot, asOf: 999 },
      }),
    });
    expect(result).toMatchObject({
      status: "PREPARATION_REJECTED",
      executionPreparationResult: { reason: "FUTURE_TRADE_INTENT" },
    });
  });

  it("allows a later caller-observed quote within existing freshness rules", () => {
    expect(engine().process({ decision: actionable(), context: context() })).toMatchObject({
      status: "EXECUTION_PREPARED",
      analysisAsOf: 1_000,
      preparationAsOf: 1_100,
      executionPreparationResult: { marketSnapshotAsOf: 1_050 },
    });
  });

  it("preserves deviation rejection", () => {
    const result = engine().process({
      decision: actionable(),
      context: context(1_000, {
        marketSnapshot: { ...context().marketSnapshot, bid: "119.99", ask: "120" },
        config: { ...context().config, maxEntryDeviationBps: 100 },
      }),
    });
    expect(result).toMatchObject({
      status: "PREPARATION_REJECTED",
      executionPreparationResult: { reason: "ENTRY_DEVIATION_EXCEEDED" },
    });
  });

  it("preserves price tick representability rejection", () => {
    const result = engine().process({
      decision: actionable(1_000, { entryReferencePrice: positiveDecimalString("100.005") }),
      context: context(),
    });
    expect(result).toMatchObject({
      status: "PREPARATION_REJECTED",
      executionPreparationResult: { reason: "PRICE_NOT_TICK_ALIGNED", failedPriceField: "ENTRY" },
    });
  });

  it("preserves quantity step representability rejection", () => {
    const result = engine().process({
      decision: actionable(1_000, { quantity: positiveDecimalString("1.005") }),
      context: context(),
    });
    expect(result).toMatchObject({
      status: "PREPARATION_REJECTED",
      executionPreparationResult: { reason: "QUANTITY_NOT_STEP_ALIGNED" },
    });
  });

  it("fails malformed context before publication and succeeds after correction", () => {
    const spies = evaluators();
    const subject = engine(spies);
    expect(() => subject.process({
      decision: actionable(),
      context: context(1_000, { marketSnapshot: { ...context().marketSnapshot, bid: "101", ask: "100" } }),
    })).toThrow(/bid/);
    expect(spies.prepareExecutionPlan).not.toHaveBeenCalled();
    expect(subject.getLatestPublishedDecisionBoundaryTime()).toBeUndefined();
    expect(subject.process({ decision: actionable(), context: context() }).status).toBe("EXECUTION_PREPARED");
  });
});

describe("identity, idempotency, monotonic safety, atomicity, and immutability", () => {
  it("returns DUPLICATE_PREPARATION and does not rerun evaluation", () => {
    const spies = evaluators();
    const subject = engine(spies);
    const first = subject.process({ decision: actionable(), context: context() });
    const duplicate = subject.process({ decision: actionable(), context: context() });
    expect(duplicate).toMatchObject({
      status: "DUPLICATE_PREPARATION",
      originalStatus: "EXECUTION_PREPARED",
      preparationCycleId: first.preparationCycleId,
    });
    expect(spies.prepareExecutionPlan).toHaveBeenCalledOnce();
  });

  it("conflicts on changed retained execution context", () => {
    const subject = engine();
    subject.process({ decision: actionable(), context: context() });
    expect(() => subject.process({
      decision: actionable(),
      context: context(1_000, { marketSnapshot: { ...context().marketSnapshot, ask: "100.01" } }),
    })).toThrow(PreparationContextConflictError);
  });

  it("creates deterministic, ambiguity-safe preparation identity", () => {
    const first = engine().process({ decision: actionable(), context: context() });
    const repeat = engine().process({ decision: actionable(), context: context() });
    expect(first).toEqual(repeat);
    expect(encodePreparationFields(["ab", "c"])).not.toBe(encodePreparationFields(["a", "bc"]));
  });

  it("changes preparation identity for a different decision cycle", () => {
    const first = engine().process({ decision: actionable(1_000), context: context(1_000) });
    const later = engine().process({ decision: actionable(2_000), context: context(2_000) });
    expect(first.preparationCycleId).not.toBe(later.preparationCycleId);
  });

  it("changes preparation identity for meaningful profile/config changes", () => {
    const first = engine().process({ decision: actionable(), context: context() });
    const policyChange = engine().process({
      decision: actionable(),
      context: context(1_000, { config: { ...context().config, maxEntryDeviationBps: 999 } }),
    });
    const versionChange = engine(undefined, 4, "preparation-v2").process({
      decision: actionable(), context: context(),
    });
    expect(first.preparationCycleId).not.toBe(policyChange.preparationCycleId);
    expect(first.preparationCycleId).not.toBe(versionChange.preparationCycleId);
  });

  it("bounds recent retention and prevents old decision reopening with a newer quote", () => {
    const spies = evaluators();
    const subject = engine(spies, 1);
    subject.process({ decision: actionable(1_000), context: context(1_000) });
    subject.process({ decision: actionable(2_000), context: context(2_000) });
    expect(subject.getRecentPreparationCount()).toBe(1);
    expect(() => subject.process({
      decision: actionable(1_000),
      context: context(1_000, {
        preparationAsOf: 3_000,
        marketSnapshot: { ...context().marketSnapshot, asOf: 3_000 },
        config: { maxIntentAgeMs: 5_000, maxQuoteAgeMs: 5_000, maxEntryDeviationBps: 1_000 },
      }),
    })).toThrow(AlreadyPublishedPreparationBoundaryError);
    expect(spies.prepareExecutionPlan).toHaveBeenCalledTimes(2);
    expect(subject.process({ decision: actionable(4_000), context: context(4_000) }).status)
      .toBe("EXECUTION_PREPARED");
  });

  it("does not publish when the evaluator throws and permits retry", () => {
    let throws = true;
    const spies = evaluators((input: ExecutionPreparationInput) => {
      if (throws) throw new Error("injected preparation failure");
      return prepareExecutionPlan(input);
    });
    const subject = engine(spies);
    expect(() => subject.process({ decision: actionable(), context: context() })).toThrow("injected preparation failure");
    expect(subject.getRecentPreparationCount()).toBe(0);
    expect(subject.getLatestPublishedDecisionBoundaryTime()).toBeUndefined();
    throws = false;
    expect(subject.process({ decision: actionable(), context: context() }).status).toBe("EXECUTION_PREPARED");
  });

  it("does not mutate caller inputs and freezes public results", () => {
    const decision = actionable();
    const executionContext = context();
    const before = JSON.stringify({ decision, executionContext });
    const result = engine().process({ decision, context: executionContext });
    expect(JSON.stringify({ decision, executionContext })).toBe(before);
    expect(Object.isFrozen(result)).toBe(true);
    if (result.status === "EXECUTION_PREPARED") {
      expect(Object.isFrozen(result.executionPreparationResult)).toBe(true);
      expect(Object.isFrozen(result.tradeIntentResult)).toBe(true);
    }
  });

  it("is independent of wall clock and randomness", () => {
    const originalNow = Date.now;
    const originalRandom = Math.random;
    Date.now = () => { throw new Error("clock accessed"); };
    Math.random = () => { throw new Error("random accessed"); };
    try {
      expect(engine().process({ decision: actionable(), context: context() }).status).toBe("EXECUTION_PREPARED");
    } finally {
      Date.now = originalNow;
      Math.random = originalRandom;
    }
  });
});

const oneMinute = parseTimeframe("1m");
const allPrimaryRegimes = [
  "TREND_UP", "TREND_DOWN", "RANGE", "COMPRESSION", "EXPANSION", "TRANSITION",
] as const;

function integrationAnalysisConfig(): RealtimeAnalysisConfig {
  return {
    profileVersion: "preparation-integration-v1",
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
      breakoutAllowedRegimes: allPrimaryRegimes,
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
  for (let index = 0; index < prices.length; index += 1) {
    const bucketStart = index * 60_000;
    const candlePrices = prices[index]!;
    for (const [offset, price] of [
      [1_000, candlePrices.open],
      [2_000, candlePrices.low],
      [3_000, candlePrices.high],
      [59_000, candlePrices.close],
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
  }
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

function integratedPreparationContext(
  decision: TradeIntentCreatedResult,
  reject: boolean,
): ExecutionPreparationContext {
  const entry = decision.tradeIntentResult.entryReferencePrice;
  return {
    preparationAsOf: decision.analysisAsOf + 10,
    marketSnapshot: {
      instrumentId: decision.tradeIntentResult.instrumentId,
      asOf: reject ? decision.analysisAsOf : decision.analysisAsOf + 10,
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
    config: {
      maxIntentAgeMs: 100,
      maxQuoteAgeMs: reject ? 0 : 100,
      maxEntryDeviationBps: 1_000,
    },
  };
}

interface IntegratedResult {
  readonly analysis: AnalysisCycleResult;
  readonly decision: RealtimeDecisionResult;
  readonly preparation: RealtimeExecutionPreparationResult;
}

function collectIntegrated(
  processResult: RealtimeAnalysisProcessResult,
  decisionEngine: RealtimeDecisionEngine,
  preparationEngine: RealtimeExecutionPreparationEngine,
  results: IntegratedResult[],
  reject: boolean,
): void {
  if (processResult.status !== "ANALYSIS_CYCLES") return;
  for (const analysis of processResult.cycles) {
    const decision = decisionEngine.process({ analysis, context: decisionContext(analysis.analysisAsOf) });
    const preparation = decision.status === "TRADE_INTENT_CREATED"
      ? preparationEngine.process({ decision, context: integratedPreparationContext(decision, reject) })
      : preparationEngine.process({ decision });
    results.push(Object.freeze({ analysis, decision, preparation }));
  }
}

function historicalPath(reject: boolean): readonly IntegratedResult[] {
  const candleEngine = new MultiTimeframeCandleEngine({
    instrumentId: instrument,
    source,
    alignments: [{ timeframe: oneMinute, anchorTime: unixMs(0) }],
  });
  const analysisEngine = new RealtimeAnalysisEngine(integrationAnalysisConfig());
  const decisionEngine = new RealtimeDecisionEngine({ profileVersion: "decision-v1", recentDecisionWindowSize: 16 });
  const preparationEngine = engine(undefined, 16);
  const results: IntegratedResult[] = [];
  new HistoricalReplayEngine(new ArrayHistoricalEventSource(integrationTrades())).run({
    onEvent(event): void {
      collectIntegrated(
        analysisEngine.processCandleEvents(candleEngine.process(event)),
        decisionEngine,
        preparationEngine,
        results,
        reject,
      );
    },
  });
  return Object.freeze(results);
}

function livePath(reject: boolean): readonly IntegratedResult[] {
  const ingestionEngine = new LiveTradeIngestionEngine({
    source: createLiveMarketDataSourceDescriptor({
      sourceId: source,
      mode: "LIVE",
      capabilities: ["TRADE"],
      sequenceSemantics: "NONE",
    }),
    instrumentId: instrument,
    initialEpochId: sourceEpochId("integration-epoch"),
    initialEpochTime: unixMs(0),
    alignments: [{ timeframe: oneMinute, anchorTime: unixMs(0) }],
    deduplicationWindowSize: 64,
  });
  const analysisEngine = new RealtimeAnalysisEngine(integrationAnalysisConfig());
  const decisionEngine = new RealtimeDecisionEngine({ profileVersion: "decision-v1", recentDecisionWindowSize: 16 });
  const preparationEngine = engine(undefined, 16);
  const results: IntegratedResult[] = [];
  integrationTrades().forEach((event, index) => {
    const ingestion = ingestionEngine.ingest(createLiveTradeEvent({
      sourceEventId: `integration-${index}`,
      event,
    }), event.eventTime);
    collectIntegrated(
      analysisEngine.processLiveIngestion(ingestion),
      decisionEngine,
      preparationEngine,
      results,
      reject,
    );
  });
  return Object.freeze(results);
}

describe("actual live/replay Task 017 through Task 020 equivalence", () => {
  it("produces equivalent no-op boundaries and successful prepared execution plans", () => {
    const historical = historicalPath(false);
    const live = livePath(false);
    expect(historical).toHaveLength(6);
    expect(live).toHaveLength(historical.length);
    expect(historical.slice(0, 5).map((value) => value.preparation.status))
      .toEqual(["NO_PREPARATION", "NO_PREPARATION", "NO_PREPARATION", "NO_PREPARATION", "NO_PREPARATION"]);
    expect(historical.slice(0, 5).map((value) => value.preparation))
      .toEqual(live.slice(0, 5).map((value) => value.preparation));
    const historicalFinal = historical[5]!;
    const liveFinal = live[5]!;
    expect(historicalFinal.preparation.status).toBe("EXECUTION_PREPARED");
    expect(liveFinal.preparation.status).toBe("EXECUTION_PREPARED");
    expect(historicalFinal.analysis.analysisCycleId).toBe(liveFinal.analysis.analysisCycleId);
    expect(historicalFinal.decision.decisionCycleId).toBe(liveFinal.decision.decisionCycleId);
    expect(historicalFinal.preparation.preparationCycleId).toBe(liveFinal.preparation.preparationCycleId);
    expect(historicalFinal.preparation).toEqual(liveFinal.preparation);
  });

  it("produces equivalent existing-engine preparation rejection", () => {
    const historicalFinal = historicalPath(true)[5]!;
    const liveFinal = livePath(true)[5]!;
    expect(historicalFinal.preparation).toMatchObject({
      status: "PREPARATION_REJECTED",
      executionPreparationResult: { reason: "MARKET_SNAPSHOT_STALE" },
    });
    expect(historicalFinal.preparation).toEqual(liveFinal.preparation);
  });
});
