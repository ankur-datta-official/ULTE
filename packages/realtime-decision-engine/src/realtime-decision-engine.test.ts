import { describe, expect, it, vi } from "vitest";
import { ArrayHistoricalEventSource, HistoricalReplayEngine } from "@ulte/backtest-engine";
import { createInstrumentId, parseTimeframe, unixMs } from "@ulte/instrument-model";
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
  createLiveMarketDataSourceDescriptor,
  createLiveTradeEvent,
  LiveTradeIngestionEngine,
  sourceEpochId,
} from "@ulte/live-market-data-engine";
import {
  createAccountRiskSnapshot,
  createPortfolioRiskConfig,
  evaluatePortfolioRisk,
} from "@ulte/portfolio-risk-engine";
import { createLinearInstrumentSizingSpec, sizePosition } from "@ulte/position-sizing-engine";
import {
  RealtimeAnalysisEngine,
  type AnalysisCycleResult,
  type RealtimeAnalysisConfig,
  type RealtimeAnalysisProcessResult,
} from "@ulte/realtime-analysis-engine";
import {
  createRiskCostAssumptions,
  createRiskQualificationConfig,
  qualifyStructuralRisk,
} from "@ulte/risk-engine";
import type { EventEvidence, SetupCandidate, SetupEvaluationResult } from "@ulte/setup-engine";
import type { LiquidityLevel, ReadyStructureResult, StructureEvent } from "@ulte/structure-engine";
import { createTradeIntent } from "@ulte/trade-intent-engine";
import {
  AlreadyPublishedDecisionBoundaryError,
  DecisionContextConflictError,
  RealtimeDecisionEngine,
  type DecisionContext,
  type RealtimeDecisionEvaluators,
  type RealtimeDecisionResult,
} from "./index.js";

const instrument = createInstrumentId({ venue: "TEST", venueSymbol: "ABC", instrumentKind: "CFD" });
const timeframe = parseTimeframe("4h");
const contextTimeframe = parseTimeframe("1d");
const source = marketDataSource("test-feed");

function level(id: string, price: string): LiquidityLevel {
  return Object.freeze({
    side: "BUY_SIDE",
    price: price as LiquidityLevel["price"],
    sourceSwingId: id,
    sourcePivotOpenTime: unixMs(1),
    confirmedAt: unixMs(5),
    status: "ACTIVE",
  });
}

function event(type: StructureEvent["type"], openTime: number, closeTime: number, id: string): StructureEvent {
  return Object.freeze({
    type,
    instrumentId: instrument,
    timeframe,
    detectedAt: unixMs(closeTime),
    eventCandleOpenTime: unixMs(openTime),
    referenceSwingId: id,
    referenceSwingTime: unixMs(1),
    referencePrice: "10" as StructureEvent["referencePrice"],
    liquiditySide: type.includes("ABOVE") ? "BUY_SIDE" : "SELL_SIDE",
  });
}

function evidence(value: StructureEvent): EventEvidence {
  return Object.freeze({
    event: value,
    referenceLevel: Object.freeze({ ...level(value.referenceSwingId, value.referencePrice), status: "BROKEN" }),
  });
}

function candle(openTime: number, closeTime: number, low: string, high: string, close: string): CandleSnapshot {
  return Object.freeze({
    candle: createCandle({
      instrumentId: instrument,
      timeframe,
      openTime,
      closeTime,
      open: close,
      high,
      low,
      close,
      volume: "1",
      isClosed: true,
    }),
    quality: Object.freeze(["LIVE"]),
  });
}

function candidate(id = "candidate-1", asOf = 100): SetupCandidate {
  const initiation = event("SWEEP_BELOW_RECLAIM", 10, 20, `init-${id}`);
  const confirmation = event("CLOSE_BREAK_ABOVE", 30, 40, `confirm-${id}`);
  return Object.freeze({
    id,
    family: "TREND_PULLBACK_CONTINUATION",
    direction: "UP",
    stage: "CONFIRMED",
    instrumentId: instrument,
    contextTimeframe,
    setupTimeframe: timeframe,
    asOf: unixMs(asOf),
    initiatedAt: unixMs(20),
    confirmedAt: unixMs(40),
    evidence: Object.freeze({ initiation: evidence(initiation), confirmation: evidence(confirmation) }),
  });
}

function readyStructure(): ReadyStructureResult {
  return Object.freeze({
    status: "READY",
    instrumentId: instrument,
    timeframe,
    windowStart: unixMs(0),
    windowEnd: unixMs(90),
    structureState: "UP",
    confirmedSwings: Object.freeze([]),
    liquidityLevels: Object.freeze([level("target", "17")]),
    structureEvents: Object.freeze([]),
  });
}

function setupResult(candidates: readonly SetupCandidate[]): SetupEvaluationResult {
  return Object.freeze({
    status: "READY",
    instrumentId: instrument,
    asOf: unixMs(candidates[0]?.asOf ?? 100),
    contextTimeframe,
    setupTimeframe: timeframe,
    candidates: Object.freeze([...candidates]),
  });
}

function analysis(
  boundary = 100,
  options: { readonly status?: AnalysisCycleResult["status"]; readonly candidates?: readonly SetupCandidate[] } = {},
): AnalysisCycleResult {
  const status = options.status ?? "ANALYZED";
  const snapshots = Object.freeze([candle(10, 20, "9", "12", "10"), candle(30, 40, "8", "12", "11")]);
  const base = {
    analysisCycleId: `analysis-${boundary}` as AnalysisCycleResult["analysisCycleId"],
    analysisProfileId: "analysis-profile" as AnalysisCycleResult["analysisProfileId"],
    instrumentId: instrument,
    source,
    analysisAsOf: unixMs(boundary),
    triggerCloseTime: unixMs(boundary),
    frame: Object.freeze({
      analysisAsOf: unixMs(boundary),
      triggerCloseTime: unixMs(boundary),
      timeframes: Object.freeze([Object.freeze({
        timeframe,
        status: "READY" as const,
        candles: snapshots,
        continuity: "CONTIGUOUS" as const,
        gapCandleOpenTimes: Object.freeze([]),
      })]),
    }),
  };
  if (status === "INSUFFICIENT_HISTORY") {
    return Object.freeze({ ...base, status, shortfalls: Object.freeze([]) });
  }
  const candidates = options.candidates ?? (status === "NO_SETUP" ? [] : [candidate("candidate-1", boundary)]);
  return Object.freeze({
    ...base,
    status,
    regime: Object.freeze({ status: "READY" }) as AnalysisCycleResult & never,
    structure: readyStructure(),
    setup: setupResult(candidates),
  }) as AnalysisCycleResult;
}

function context(overrides: Partial<DecisionContext> = {}, asOf = 100): DecisionContext {
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
    ...overrides,
  };
}

function evaluatorSpies(overrides: Partial<RealtimeDecisionEvaluators> = {}) {
  return {
    qualifyStructuralRisk: vi.fn(overrides.qualifyStructuralRisk ?? qualifyStructuralRisk),
    evaluatePortfolioRisk: vi.fn(overrides.evaluatePortfolioRisk ?? evaluatePortfolioRisk),
    sizePosition: vi.fn(overrides.sizePosition ?? sizePosition),
    createTradeIntent: vi.fn(overrides.createTradeIntent ?? createTradeIntent),
  } satisfies RealtimeDecisionEvaluators;
}

function engine(evaluators?: RealtimeDecisionEvaluators, window = 4, profileVersion = "decision-v1") {
  return new RealtimeDecisionEngine({ profileVersion, recentDecisionWindowSize: window }, evaluators);
}

describe("non-actionable analysis and multi-candidate safety", () => {
  it.each([
    ["INSUFFICIENT_HISTORY", "INSUFFICIENT_HISTORY"],
    ["NO_SETUP", "NO_SETUP"],
  ] as const)("publishes %s without invoking risk", (status, reason) => {
    const spies = evaluatorSpies();
    const result = engine(spies).process({ analysis: analysis(100, { status }) });
    expect(result).toEqual(expect.objectContaining({ status: "NO_DECISION", reason }));
    expect(spies.qualifyStructuralRisk).not.toHaveBeenCalled();
    expect(spies.evaluatePortfolioRisk).not.toHaveBeenCalled();
    expect(spies.sizePosition).not.toHaveBeenCalled();
    expect(spies.createTradeIntent).not.toHaveBeenCalled();
  });

  it("treats an analyzed zero/armed-only candidate set as no decision", () => {
    const spies = evaluatorSpies();
    const armed = Object.freeze({ ...candidate(), stage: "ARMED" as const });
    const result = engine(spies).process({ analysis: analysis(100, { candidates: [armed] }) });
    expect(result).toEqual(expect.objectContaining({ status: "NO_DECISION", reason: "NO_ACTIONABLE_CANDIDATE" }));
    expect(spies.qualifyStructuralRisk).not.toHaveBeenCalled();
  });

  it("publishes setup-not-ready without risk evaluation", () => {
    const spies = evaluatorSpies();
    const base = analysis() as Exclude<AnalysisCycleResult, { readonly status: "INSUFFICIENT_HISTORY" }>;
    const notReady = Object.freeze({
      ...base,
      setup: Object.freeze({
        status: "UPSTREAM_NOT_READY" as const,
        source: "REGIME" as const,
        upstreamStatus: "INSUFFICIENT_DATA" as const,
        reason: "NOT_ENOUGH_CANDLES",
      }),
    });
    expect(engine(spies).process({ analysis: notReady })).toEqual(expect.objectContaining({
      status: "NO_DECISION",
      reason: "SETUP_NOT_READY",
    }));
    expect(spies.qualifyStructuralRisk).not.toHaveBeenCalled();
  });

  it("fails closed for multiple confirmed candidates without selecting or evaluating either", () => {
    const spies = evaluatorSpies();
    const adversarialContext = context({
      requestedRiskAmount: "200",
      portfolioRiskConfig: createPortfolioRiskConfig({
        maxRiskPerTradeBps: 200,
        maxTotalOpenRiskBps: 300,
        maxConcurrentPositions: 3,
        maxDailyLossBps: 500,
        riskGroupLimits: [
          { groupId: "GROUP_A", maxRiskBps: 300 },
          { groupId: "GROUP_B", maxRiskBps: 300 },
        ],
      }),
    });
    const result = engine(spies).process({
      analysis: analysis(100, { candidates: [candidate("first"), candidate("second")] }),
      // Each 200 request fits the original 300 aggregate cap, while two would require 400.
      context: adversarialContext,
    });
    expect(result).toEqual(expect.objectContaining({
      status: "DECISION_REJECTED",
      blockingStage: "MULTIPLE_ACTIONABLE_CANDIDATES",
      reason: "MULTIPLE_ACTIONABLE_CANDIDATES_UNSUPPORTED",
      candidateIds: ["first", "second"],
    }));
    expect(spies.qualifyStructuralRisk).not.toHaveBeenCalled();
  });
});

describe("strict stage order and existing-engine integration", () => {
  it("reuses every existing engine in fixed order and creates an intent", () => {
    const calls: string[] = [];
    const spies = evaluatorSpies({
      qualifyStructuralRisk: (input) => { calls.push("STRUCTURAL_RISK"); return qualifyStructuralRisk(input); },
      evaluatePortfolioRisk: (input) => { calls.push("PORTFOLIO_RISK"); return evaluatePortfolioRisk(input); },
      sizePosition: (input) => { calls.push("POSITION_SIZING"); return sizePosition(input); },
      createTradeIntent: (input) => { calls.push("TRADE_INTENT"); return createTradeIntent(input); },
    });
    const result = engine(spies).process({ analysis: analysis(), context: context() });
    expect(result).toEqual(expect.objectContaining({ status: "TRADE_INTENT_CREATED", analysisAsOf: 100 }));
    expect(calls).toEqual(["STRUCTURAL_RISK", "PORTFOLIO_RISK", "POSITION_SIZING", "TRADE_INTENT"]);
    if (result.status === "TRADE_INTENT_CREATED") {
      expect(result.structuralRiskResult.status).toBe("QUALIFIED");
      expect(result.portfolioRiskResult.status).toBe("CAPITAL_ELIGIBLE");
      expect(result.positionSizingResult.status).toBe("SIZED");
      expect(result.tradeIntentResult.status).toBe("INTENT_READY");
    }
  });

  it("stops after structural-risk rejection", () => {
    const spies = evaluatorSpies();
    const result = engine(spies).process({
      analysis: analysis(),
      context: context({ riskConfig: createRiskQualificationConfig({ minimumNetRewardRiskBps: 40_000 }) }),
    });
    expect(result).toEqual(expect.objectContaining({ status: "DECISION_REJECTED", blockingStage: "STRUCTURAL_RISK" }));
    expect(spies.qualifyStructuralRisk).toHaveBeenCalledOnce();
    expect(spies.evaluatePortfolioRisk).not.toHaveBeenCalled();
    expect(spies.sizePosition).not.toHaveBeenCalled();
    expect(spies.createTradeIntent).not.toHaveBeenCalled();
  });

  it("stops after portfolio-risk rejection", () => {
    const spies = evaluatorSpies();
    const result = engine(spies).process({ analysis: analysis(), context: context({ requestedRiskAmount: "101" }) });
    expect(result).toEqual(expect.objectContaining({ status: "DECISION_REJECTED", blockingStage: "PORTFOLIO_RISK" }));
    expect(spies.evaluatePortfolioRisk).toHaveBeenCalledOnce();
    expect(spies.sizePosition).not.toHaveBeenCalled();
    expect(spies.createTradeIntent).not.toHaveBeenCalled();
  });

  it("stops after position-sizing rejection", () => {
    const spies = evaluatorSpies();
    const oversizedMinimum = createLinearInstrumentSizingSpec({
      ...context().instrumentSizingSpec,
      minimumQuantity: "100",
    });
    const result = engine(spies).process({
      analysis: analysis(),
      context: context({ instrumentSizingSpec: oversizedMinimum }),
    });
    expect(result).toEqual(expect.objectContaining({ status: "DECISION_REJECTED", blockingStage: "POSITION_SIZING" }));
    expect(spies.sizePosition).toHaveBeenCalledOnce();
    expect(spies.createTradeIntent).not.toHaveBeenCalled();
  });

  it("preserves an unexpected trade-intent coherence rejection as the final stopping stage", () => {
    const spies = evaluatorSpies({
      createTradeIntent: (input) => Object.freeze({
        status: "DATA_REJECTED",
        reason: "AS_OF_MISMATCH",
        candidateId: input.setupCandidate.id,
      }),
    });
    const result = engine(spies).process({ analysis: analysis(), context: context() });
    expect(result).toEqual(expect.objectContaining({
      status: "DECISION_REJECTED",
      blockingStage: "TRADE_INTENT",
      tradeIntentResult: expect.objectContaining({ status: "DATA_REJECTED", reason: "AS_OF_MISMATCH" }),
    }));
    expect(spies.createTradeIntent).toHaveBeenCalledOnce();
  });
});

describe("same-as-of validation, idempotency, and atomicity", () => {
  it("rejects future account and FX context before all evaluators and permits corrected retry", () => {
    const spies = evaluatorSpies();
    const subject = engine(spies);
    expect(() => subject.process({ analysis: analysis(), context: context({}, 101) })).toThrow(/asOf/);
    expect(spies.qualifyStructuralRisk).not.toHaveBeenCalled();
    const futureFx = context({
      fxConversion: Object.freeze({ asOf: unixMs(101), fromCurrency: context().account.baseCurrency, toCurrency: context().account.baseCurrency, rate: context().instrumentSizingSpec.quantityStep }),
    });
    expect(() => subject.process({ analysis: analysis(), context: futureFx })).toThrow(/FX asOf/);
    expect(spies.qualifyStructuralRisk).not.toHaveBeenCalled();
    expect(subject.getLatestPublishedBoundaryTime()).toBeUndefined();
    expect(subject.process({ analysis: analysis(), context: context() }).status).toBe("TRADE_INTENT_CREATED");
  });

  it("returns an explicit duplicate, skips reevaluation, and conflicts on changed context", () => {
    const spies = evaluatorSpies();
    const subject = engine(spies);
    const first = subject.process({ analysis: analysis(), context: context() });
    const duplicate = subject.process({ analysis: analysis(), context: context() });
    expect(duplicate).toEqual(expect.objectContaining({
      status: "DUPLICATE_DECISION",
      decisionCycleId: first.decisionCycleId,
      originalStatus: "TRADE_INTENT_CREATED",
    }));
    expect(spies.qualifyStructuralRisk).toHaveBeenCalledOnce();
    expect(() => subject.process({ analysis: analysis(), context: context({ requestedRiskAmount: "99" }) }))
      .toThrow(DecisionContextConflictError);
    expect(spies.qualifyStructuralRisk).toHaveBeenCalledOnce();
  });

  it("canonicalizes only set-like account ordering in context fingerprints", () => {
    const p1 = { positionId: "p1", instrumentId: instrument, riskAmountAtStop: "1", riskGroupIds: ["GROUP_B", "GROUP_A"] };
    const p2 = { positionId: "p2", instrumentId: instrument, riskAmountAtStop: "2", riskGroupIds: ["GROUP_A"] };
    const firstContext = context({ account: createAccountRiskSnapshot({ asOf: 100, baseCurrency: "USD", currentEquity: "10000", dayStartEquity: "10000", openPositions: [p1, p2] }) });
    const reorderedContext = context({ account: createAccountRiskSnapshot({ asOf: 100, baseCurrency: "USD", currentEquity: "10000", dayStartEquity: "10000", openPositions: [p2, { ...p1, riskGroupIds: ["GROUP_A", "GROUP_B"] }] }) });
    const subject = engine();
    subject.process({ analysis: analysis(), context: firstContext });
    expect(subject.process({ analysis: analysis(), context: reorderedContext }).status).toBe("DUPLICATE_DECISION");
  });

  it("keeps recent retention bounded while the independent watermark prevents reopening eviction", () => {
    const spies = evaluatorSpies();
    const subject = engine(spies, 1);
    subject.process({ analysis: analysis(100), context: context({}, 100) });
    subject.process({ analysis: analysis(200), context: context({}, 200) });
    expect(subject.getRecentDecisionCount()).toBe(1);
    expect(() => subject.process({ analysis: analysis(100), context: context({ requestedRiskAmount: "99" }, 100) }))
      .toThrow(AlreadyPublishedDecisionBoundaryError);
    expect(spies.qualifyStructuralRisk).toHaveBeenCalledTimes(2);
    expect(subject.process({ analysis: analysis(300), context: context({}, 300) }).status).toBe("TRADE_INTENT_CREATED");
  });

  it("does not publish when a downstream evaluator throws and succeeds on retry", () => {
    const broken = evaluatorSpies({
      evaluatePortfolioRisk: () => { throw new Error("injected failure"); },
    });
    const subject = engine(broken);
    expect(() => subject.process({ analysis: analysis(), context: context() })).toThrow("injected failure");
    expect(subject.getLatestPublishedBoundaryTime()).toBeUndefined();
    expect(subject.getRecentDecisionCount()).toBe(0);
    broken.evaluatePortfolioRisk.mockImplementation(evaluatePortfolioRisk);
    expect(subject.process({ analysis: analysis(), context: context() }).status).toBe("TRADE_INTENT_CREATED");
  });
});

describe("identity, immutability, and determinism", () => {
  it("uses analysis and meaningful profile identity deterministically", () => {
    const first = engine().process({ analysis: analysis(100), context: context({}, 100) });
    const repeat = engine().process({ analysis: analysis(100), context: context({}, 100) });
    const later = engine().process({ analysis: analysis(200), context: context({}, 200) });
    const otherProfile = engine(undefined, 4, "decision-v2").process({ analysis: analysis(100), context: context({}, 100) });
    expect(first).toEqual(repeat);
    expect(first.decisionCycleId).not.toBe(later.decisionCycleId);
    expect(first.decisionCycleId).not.toBe(otherProfile.decisionCycleId);
  });

  it("does not mutate caller inputs and returns frozen public records", () => {
    const inputAnalysis = analysis();
    const inputContext = context();
    const before = JSON.stringify({ inputAnalysis, inputContext });
    const result = engine().process({ analysis: inputAnalysis, context: inputContext });
    expect(JSON.stringify({ inputAnalysis, inputContext })).toBe(before);
    expect(Object.isFrozen(result)).toBe(true);
    if (result.status === "TRADE_INTENT_CREATED") {
      expect(Object.isFrozen(result.structuralRiskResult)).toBe(true);
      expect(Object.isFrozen(result.portfolioRiskResult)).toBe(true);
      expect(Object.isFrozen(result.positionSizingResult)).toBe(true);
      expect(Object.isFrozen(result.tradeIntentResult)).toBe(true);
    }
  });

  it("repeats equivalent outputs for identical synthetic analysis inputs", () => {
    const first = engine().process({ analysis: analysis(), context: context() });
    const second = engine().process({ analysis: analysis(), context: context() });
    expect(first).toEqual(second);
    if (first.status === "TRADE_INTENT_CREATED" && second.status === "TRADE_INTENT_CREATED") {
      expect(first.structuralRiskResult).toEqual(second.structuralRiskResult);
      expect(first.portfolioRiskResult).toEqual(second.portfolioRiskResult);
      expect(first.positionSizingResult).toEqual(second.positionSizingResult);
      expect(first.tradeIntentResult).toEqual(second.tradeIntentResult);
    }
  });

  it("has no wall-clock or randomness dependency", () => {
    const originalNow = Date.now;
    const originalRandom = Math.random;
    Date.now = () => { throw new Error("clock accessed"); };
    Math.random = () => { throw new Error("random accessed"); };
    try {
      expect(engine().process({ analysis: analysis(), context: context() }).status).toBe("TRADE_INTENT_CREATED");
    } finally {
      Date.now = originalNow;
      Math.random = originalRandom;
    }
  });
});

const oneMinute = parseTimeframe("1m");
const allPrimaryRegimes = [
  "TREND_UP",
  "TREND_DOWN",
  "RANGE",
  "COMPRESSION",
  "EXPANSION",
  "TRANSITION",
] as const;

function integrationAnalysisConfig(): RealtimeAnalysisConfig {
  return {
    profileVersion: "decision-integration-v1",
    instrumentId: instrument,
    source,
    timeframes: [{ timeframe: oneMinute, historyLimit: 16 }],
    roles: {
      regimeTimeframe: oneMinute,
      structureTimeframe: oneMinute,
      setupTimeframe: oneMinute,
    },
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

function canonicalIntegrationTrades(): readonly MarketDataEvent<TradeTick>[] {
  const candlePrices = [
    { open: "9", low: "8", high: "10", close: "9" },
    { open: "10", low: "9", high: "12", close: "11" },
    { open: "10", low: "9.5", high: "11", close: "10" },
    { open: "11", low: "10", high: "13", close: "12.5" },
    { open: "15", low: "12", high: "30", close: "15" },
    { open: "15", low: "13", high: "20", close: "16" },
  ] as const;
  const events: MarketDataEvent<TradeTick>[] = [];
  for (let index = 0; index < candlePrices.length; index += 1) {
    const bucketStart = index * 60_000;
    const prices = candlePrices[index]!;
    for (const [offset, price] of [
      [1_000, prices.open],
      [2_000, prices.low],
      [3_000, prices.high],
      [59_000, prices.close],
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
  const finalizationTime = 361_000;
  events.push(createMarketDataEvent({
    instrumentId: instrument,
    source,
    eventTime: finalizationTime,
    receivedAt: finalizationTime,
    payload: createTradeTick({ price: "16", quantity: "1", side: "UNKNOWN" }),
    quality: ["LIVE"],
  }));
  return Object.freeze(events);
}

interface IntegratedDecision {
  readonly analysis: AnalysisCycleResult;
  readonly decision: RealtimeDecisionResult;
}

function collectDecisions(
  processResult: RealtimeAnalysisProcessResult,
  decisionEngine: RealtimeDecisionEngine,
  results: IntegratedDecision[],
): void {
  if (processResult.status !== "ANALYSIS_CYCLES") return;
  for (const cycle of processResult.cycles) {
    results.push(Object.freeze({
      analysis: cycle,
      decision: decisionEngine.process({ analysis: cycle, context: context({}, cycle.analysisAsOf) }),
    }));
  }
}

function historicalDecisionPath(events: readonly MarketDataEvent<TradeTick>[]): readonly IntegratedDecision[] {
  const candleEngine = new MultiTimeframeCandleEngine({
    instrumentId: instrument,
    source,
    alignments: [{ timeframe: oneMinute, anchorTime: unixMs(0) }],
  });
  const analysisEngine = new RealtimeAnalysisEngine(integrationAnalysisConfig());
  const decisionEngine = engine();
  const results: IntegratedDecision[] = [];
  new HistoricalReplayEngine(new ArrayHistoricalEventSource(events)).run({
    onEvent(event): void {
      collectDecisions(
        analysisEngine.processCandleEvents(candleEngine.process(event)),
        decisionEngine,
        results,
      );
    },
  });
  return Object.freeze(results);
}

function liveDecisionPath(events: readonly MarketDataEvent<TradeTick>[]): readonly IntegratedDecision[] {
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
  const decisionEngine = engine();
  const results: IntegratedDecision[] = [];
  events.forEach((event, index) => {
    const ingestion = ingestionEngine.ingest(createLiveTradeEvent({
      sourceEventId: `integration-${index}`,
      event,
    }), event.eventTime);
    collectDecisions(analysisEngine.processLiveIngestion(ingestion), decisionEngine, results);
  });
  return Object.freeze(results);
}

describe("actual live and historical replay equivalence", () => {
  it("matches Task 017/018/019 with historical replay through the shared candle engine", () => {
    const trades = canonicalIntegrationTrades();
    const historical = historicalDecisionPath(trades);
    const live = liveDecisionPath(trades);

    expect(historical).toHaveLength(6);
    expect(live).toHaveLength(historical.length);
    expect(historical.slice(0, 5).map(({ analysis, decision }) => ({
      analysisStatus: analysis.status,
      decisionStatus: decision.status,
      analysisCycleId: analysis.analysisCycleId,
      decisionCycleId: decision.decisionCycleId,
      analysisAsOf: analysis.analysisAsOf,
      triggerCloseTime: analysis.triggerCloseTime,
    }))).toEqual(live.slice(0, 5).map(({ analysis, decision }) => ({
      analysisStatus: analysis.status,
      decisionStatus: decision.status,
      analysisCycleId: analysis.analysisCycleId,
      decisionCycleId: decision.decisionCycleId,
      analysisAsOf: analysis.analysisAsOf,
      triggerCloseTime: analysis.triggerCloseTime,
    })));
    expect(historical.slice(0, 5).every(({ analysis, decision }) =>
      analysis.status === "INSUFFICIENT_HISTORY" && decision.status === "NO_DECISION",
    )).toBe(true);

    const historicalFinal = historical[5]!;
    const liveFinal = live[5]!;
    expect(historicalFinal.analysis.status).toBe("ANALYZED");
    expect(liveFinal.analysis.status).toBe("ANALYZED");
    expect(historicalFinal.decision.status).toBe("TRADE_INTENT_CREATED");
    expect(liveFinal.decision.status).toBe("TRADE_INTENT_CREATED");
    expect(historicalFinal.analysis.analysisCycleId).toBe(liveFinal.analysis.analysisCycleId);
    expect(historicalFinal.decision.decisionCycleId).toBe(liveFinal.decision.decisionCycleId);
    expect(historicalFinal.analysis.analysisAsOf).toBe(liveFinal.analysis.analysisAsOf);
    expect(historicalFinal.analysis.triggerCloseTime).toBe(liveFinal.analysis.triggerCloseTime);
    expect(historicalFinal.decision.analysisAsOf).toBe(liveFinal.decision.analysisAsOf);
    expect(historicalFinal.decision.triggerCloseTime).toBe(liveFinal.decision.triggerCloseTime);
    if (historicalFinal.decision.status === "TRADE_INTENT_CREATED" &&
        liveFinal.decision.status === "TRADE_INTENT_CREATED") {
      expect(historicalFinal.decision.structuralRiskResult).toEqual(liveFinal.decision.structuralRiskResult);
      expect(historicalFinal.decision.portfolioRiskResult).toEqual(liveFinal.decision.portfolioRiskResult);
      expect(historicalFinal.decision.positionSizingResult).toEqual(liveFinal.decision.positionSizingResult);
      expect(historicalFinal.decision.tradeIntentResult).toEqual(liveFinal.decision.tradeIntentResult);
    }
  });
});
