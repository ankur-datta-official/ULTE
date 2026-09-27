import { describe, expect, it, vi } from "vitest";
import { ArrayHistoricalEventSource, HistoricalReplayEngine } from "@ulte/backtest-engine";
import { createInstrumentId, parseTimeframe, unixMs } from "@ulte/instrument-model";
import {
  LiveTradeIngestionEngine,
  createLiveMarketDataSourceDescriptor,
  createLiveTradeEvent,
  sourceEpochId,
} from "@ulte/live-market-data-engine";
import {
  MultiTimeframeCandleEngine,
  createCandle,
  createMarketDataEvent,
  createTradeTick,
  marketDataSource,
  type CandleEngineEvent,
  type CandleSnapshot,
} from "@ulte/market-data";
import { classifyMarketRegime } from "@ulte/regime-engine";
import { evaluatePositionSetups } from "@ulte/setup-engine";
import { analyzeMarketStructure } from "@ulte/structure-engine";
import {
  RealtimeAnalysisEngine,
  LateSameBoundaryFinalizationError,
  createAnalysisCycleId,
  createRealtimeAnalysisConfig,
  type AnalysisCycleResult,
  type RealtimeAnalysisConfig,
  type RealtimeAnalysisEvaluators,
} from "./index.js";

const instrument = createInstrumentId({ venue: "test", venueSymbol: "BTC/USD", instrumentKind: "SPOT" });
const otherInstrument = createInstrumentId({ venue: "test", venueSymbol: "ETH/USD", instrumentKind: "SPOT" });
const source = marketDataSource("primary-feed");
const otherSource = marketDataSource("secondary-feed");
const oneMinute = parseTimeframe("1m");
const fiveMinutes = parseTimeframe("5m");

function config(overrides: Partial<RealtimeAnalysisConfig> = {}): RealtimeAnalysisConfig {
  return {
    profileVersion: "position-v1",
    instrumentId: instrument,
    source,
    timeframes: [{ timeframe: oneMinute, historyLimit: 8 }],
    roles: { regimeTimeframe: oneMinute, structureTimeframe: oneMinute, setupTimeframe: oneMinute },
    regime: {
      trendLookback: 2,
      baselineVolatilityBars: 1,
      recentVolatilityBars: 1,
      trendEfficiencyMinBps: 7_000,
      trendConsistencyMinBps: 7_000,
      rangeEfficiencyMaxBps: 3_000,
      rangeConsistencyMaxBps: 3_000,
      compressionRatioMaxBps: 8_000,
      expansionRatioMinBps: 12_000,
    },
    structure: { lookbackBars: 3, pivotLeftBars: 1, pivotRightBars: 1 },
    setup: {
      continuationAllowedRegimes: [],
      breakoutAllowedRegimes: [],
      reversalAllowedRegimes: [],
    },
    cycleDeduplicationWindowSize: 16,
    ...overrides,
  };
}

function snapshot(
  timeframe: typeof oneMinute | typeof fiveMinutes,
  openTime: number,
  closeTime: number,
  price = "10",
  quality: readonly ("HISTORICAL" | "LIVE" | "GAP_DETECTED")[] = ["HISTORICAL"],
): CandleSnapshot {
  return Object.freeze({
    candle: createCandle({
      instrumentId: instrument,
      timeframe,
      openTime,
      closeTime,
      open: price,
      high: price,
      low: price,
      close: price,
      volume: "1",
      tradeCount: 1,
      isClosed: true,
    }),
    quality: Object.freeze([...quality]),
  });
}

function closed(
  timeframe: typeof oneMinute | typeof fiveMinutes,
  openTime: number,
  closeTime: number,
  price = "10",
  quality?: readonly ("HISTORICAL" | "LIVE" | "GAP_DETECTED")[],
): CandleEngineEvent {
  return Object.freeze({
    type: "CANDLE_CLOSED" as const,
    timeframe,
    snapshot: snapshot(timeframe, openTime, closeTime, price, quality),
  });
}

function canonicalTrade(eventTime: number, price = "10", idSource = source) {
  return createMarketDataEvent({
    instrumentId: instrument,
    source: idSource,
    eventTime,
    receivedAt: eventTime,
    payload: createTradeTick({ price, quantity: "1", side: "UNKNOWN" }),
    quality: ["LIVE"],
  });
}

function liveEngines(analysisConfig = config({
  timeframes: [
    { timeframe: oneMinute, historyLimit: 16 },
    { timeframe: fiveMinutes, historyLimit: 8 },
  ],
})) {
  const live = new LiveTradeIngestionEngine({
    source: createLiveMarketDataSourceDescriptor({
      sourceId: source,
      mode: "LIVE",
      capabilities: ["TRADE"],
      sequenceSemantics: "NONE",
    }),
    instrumentId: instrument,
    initialEpochId: sourceEpochId("epoch-1"),
    initialEpochTime: unixMs(0),
    alignments: [
      { timeframe: oneMinute, anchorTime: unixMs(0) },
      { timeframe: fiveMinutes, anchorTime: unixMs(0) },
    ],
    deduplicationWindowSize: 16,
  });
  return { live, analysis: new RealtimeAnalysisEngine(analysisConfig) };
}

function ingest(live: LiveTradeIngestionEngine, time: number, id: string, price = "10", observed = time) {
  return live.ingest(createLiveTradeEvent({ sourceEventId: id, event: canonicalTrade(time, price) }), unixMs(observed));
}

function cycleAt(result: ReturnType<RealtimeAnalysisEngine["processCandleEvents"]>, closeTime: number): AnalysisCycleResult {
  if (result.status !== "ANALYSIS_CYCLES") throw new Error("Expected analysis cycles");
  const cycle = result.cycles.find((item) => item.triggerCloseTime === closeTime);
  if (cycle === undefined) throw new Error(`Expected cycle at ${closeTime}`);
  return cycle;
}

function feedThree(subject: RealtimeAnalysisEngine): AnalysisCycleResult {
  subject.processCandleEvents([closed(oneMinute, 0, 60_000, "10")]);
  subject.processCandleEvents([closed(oneMinute, 60_000, 120_000, "11")]);
  return cycleAt(subject.processCandleEvents([closed(oneMinute, 120_000, 180_000, "12")]), 180_000);
}

describe("finalized-candle trigger and history", () => {
  it("does not analyze a raw trade without a finalized candle", () => {
    const { live, analysis } = liveEngines();
    expect(analysis.processLiveIngestion(ingest(live, 1_000, "event-1")))
      .toEqual({ status: "NO_ANALYSIS", reason: "NO_FINALIZED_CANDLE" });
  });

  it("creates an eligible boundary from a finalized candle", () => {
    const result = new RealtimeAnalysisEngine(config()).processCandleEvents([closed(oneMinute, 0, 60_000)]);
    expect(cycleAt(result, 60_000).status).toBe("INSUFFICIENT_HISTORY");
  });

  it("stores only CANDLE_CLOSED outputs", () => {
    const subject = new RealtimeAnalysisEngine(config());
    const open = { ...closed(oneMinute, 0, 60_000), type: "CANDLE_OPENED" as const };
    expect(subject.processCandleEvents([open])).toMatchObject({ status: "NO_ANALYSIS" });
    expect(subject.getFinalizedHistories().get(oneMinute)).toEqual([]);
  });

  it("never stores an open snapshot disguised as finalized", () => {
    const subject = new RealtimeAnalysisEngine(config());
    const openSnapshot = { ...snapshot(oneMinute, 0, 60_000), candle: { ...snapshot(oneMinute, 0, 60_000).candle, isClosed: false } };
    expect(() => subject.processCandleEvents([{
      type: "CANDLE_CLOSED", timeframe: oneMinute, snapshot: openSnapshot,
    } as CandleEngineEvent])).toThrow(/finalized/);
    expect(subject.getFinalizedHistories().get(oneMinute)).toEqual([]);
  });

  it("excludes a later candle from an earlier boundary in the same batch", () => {
    const subject = new RealtimeAnalysisEngine(config());
    const result = subject.processCandleEvents([
      closed(oneMinute, 0, 60_000, "10"),
      closed(oneMinute, 60_000, 120_000, "99"),
    ]);
    const first = cycleAt(result, 60_000);
    expect(first.frame.timeframes[0]!.candles.map((item) => item.candle.close)).toEqual(["10"]);
  });

  it("preserves chronological finalized history", () => {
    const subject = new RealtimeAnalysisEngine(config());
    subject.processCandleEvents([closed(oneMinute, 0, 60_000)]);
    subject.processCandleEvents([closed(oneMinute, 60_000, 120_000)]);
    expect(subject.getFinalizedHistories().get(oneMinute)?.map((item) => item.candle.openTime)).toEqual([0, 60_000]);
  });

  it("does not synthesize missing candles", () => {
    const subject = new RealtimeAnalysisEngine(config());
    subject.processCandleEvents([closed(oneMinute, 0, 60_000)]);
    subject.processCandleEvents([closed(oneMinute, 180_000, 240_000, "10", ["HISTORICAL", "GAP_DETECTED"])]);
    expect(subject.getFinalizedHistories().get(oneMinute)?.map((item) => item.candle.openTime)).toEqual([0, 180_000]);
  });

  it("keeps gap continuity observable", () => {
    const subject = new RealtimeAnalysisEngine(config());
    const cycle = cycleAt(subject.processCandleEvents([
      closed(oneMinute, 180_000, 240_000, "10", ["HISTORICAL", "GAP_DETECTED"]),
    ]), 240_000);
    expect(cycle.frame.timeframes[0]).toMatchObject({ continuity: "GAPPED", gapCandleOpenTimes: [180_000] });
  });

  it("evicts the oldest history entry with FIFO behavior", () => {
    const subject = new RealtimeAnalysisEngine(config({ timeframes: [{ timeframe: oneMinute, historyLimit: 2 }] }));
    subject.processCandleEvents([closed(oneMinute, 0, 60_000)]);
    subject.processCandleEvents([closed(oneMinute, 60_000, 120_000)]);
    subject.processCandleEvents([closed(oneMinute, 120_000, 180_000)]);
    expect(subject.getFinalizedHistories().get(oneMinute)?.map((item) => item.candle.openTime)).toEqual([60_000, 120_000]);
  });
});

describe("live rejection, deduplication, and reset", () => {
  it("does not produce a second cycle for a repeated accepted result", () => {
    const { live, analysis } = liveEngines();
    analysis.processLiveIngestion(ingest(live, 0, "event-0"));
    const accepted = ingest(live, 60_000, "event-1");
    expect(analysis.processLiveIngestion(accepted).status).toBe("ANALYSIS_CYCLES");
    expect(analysis.processLiveIngestion(accepted)).toEqual({ status: "NO_ANALYSIS", reason: "DUPLICATE_BOUNDARY" });
  });

  it("does not analyze an exact live duplicate", () => {
    const { live, analysis } = liveEngines();
    const event = createLiveTradeEvent({ sourceEventId: "event-1", event: canonicalTrade(1_000) });
    analysis.processLiveIngestion(live.ingest(event, unixMs(1_000)));
    expect(analysis.processLiveIngestion(live.ingest(event, unixMs(1_000))))
      .toMatchObject({ status: "NO_ANALYSIS", reason: "INPUT_NOT_ACCEPTED", inputStatus: "DUPLICATE" });
  });

  it("does not analyze a conflicting duplicate", () => {
    const { live, analysis } = liveEngines();
    analysis.processLiveIngestion(ingest(live, 1_000, "event-1", "10"));
    expect(analysis.processLiveIngestion(ingest(live, 1_000, "event-1", "11")))
      .toMatchObject({ inputStatus: "CONFLICTING_DUPLICATE" });
  });

  it("does not analyze an out-of-order live input", () => {
    const { live, analysis } = liveEngines();
    analysis.processLiveIngestion(ingest(live, 2_000, "event-2"));
    expect(analysis.processLiveIngestion(ingest(live, 1_000, "event-1", "10", 2_000)))
      .toMatchObject({ inputStatus: "REJECTED_OUT_OF_ORDER" });
  });

  it("does not analyze a future live input", () => {
    const { live, analysis } = liveEngines();
    expect(analysis.processLiveIngestion(ingest(live, 2_000, "event-1", "10", 1_999)))
      .toMatchObject({ inputStatus: "REJECTED_FUTURE" });
  });

  it("treats a source reset as non-analysis", () => {
    const { live, analysis } = liveEngines();
    analysis.processLiveIngestion(ingest(live, 0, "event-0"));
    const before = [...analysis.getFinalizedHistories()];
    const reset = live.beginSourceEpoch({
      epochId: sourceEpochId("epoch-2"), effectiveTime: unixMs(0), observationTime: unixMs(0),
    });
    expect(analysis.processSourceReset(reset)).toEqual({ status: "NO_ANALYSIS", reason: "SOURCE_RESET" });
    expect([...analysis.getFinalizedHistories()]).toEqual(before);
  });

  it("preserves valid finalized history across a source reset", () => {
    const { live, analysis } = liveEngines();
    analysis.processLiveIngestion(ingest(live, 0, "event-0"));
    analysis.processLiveIngestion(ingest(live, 60_000, "event-1"));
    const reset = live.beginSourceEpoch({
      epochId: sourceEpochId("epoch-2"), effectiveTime: unixMs(60_000), observationTime: unixMs(60_000),
    });
    analysis.processSourceReset(reset);
    expect(analysis.getFinalizedHistories().get(oneMinute)).toHaveLength(1);
  });
});

describe("multi-timeframe atomicity and no lookahead", () => {
  it("produces one cycle when two timeframes close at the same boundary", () => {
    const subject = new RealtimeAnalysisEngine(config({
      timeframes: [
        { timeframe: oneMinute, historyLimit: 8 },
        { timeframe: fiveMinutes, historyLimit: 8 },
      ],
    }));
    const result = subject.processCandleEvents([
      closed(oneMinute, 240_000, 300_000), closed(fiveMinutes, 0, 300_000),
    ]);
    expect(result.status === "ANALYSIS_CYCLES" ? result.cycles : []).toHaveLength(1);
  });

  it("shows all same-boundary finalizations in the synchronized frame", () => {
    const subject = new RealtimeAnalysisEngine(config({
      timeframes: [
        { timeframe: oneMinute, historyLimit: 8 },
        { timeframe: fiveMinutes, historyLimit: 8 },
      ],
    }));
    const cycle = cycleAt(subject.processCandleEvents([
      closed(oneMinute, 240_000, 300_000), closed(fiveMinutes, 0, 300_000),
    ]), 300_000);
    expect(cycle.frame.timeframes.map((item) => item.candles.length)).toEqual([1, 1]);
  });

  it("does not expose an unfinished higher-timeframe candle before its close", () => {
    const { live, analysis } = liveEngines(config({
      timeframes: [
        { timeframe: oneMinute, historyLimit: 16 },
        { timeframe: fiveMinutes, historyLimit: 8 },
      ],
      roles: { regimeTimeframe: fiveMinutes, structureTimeframe: oneMinute, setupTimeframe: oneMinute },
    }));
    analysis.processLiveIngestion(ingest(live, 0, "event-0", "10"));
    const atOneMinute = analysis.processLiveIngestion(ingest(live, 60_000, "event-1", "99"));
    const earlyCycle = cycleAt(atOneMinute, 60_000);
    expect(earlyCycle.status).toBe("INSUFFICIENT_HISTORY");
    expect(earlyCycle.frame.timeframes.find((item) => item.timeframe === fiveMinutes))
      .toMatchObject({ status: "NO_FINALIZED_CANDLE", candles: [] });
    expect("setup" in earlyCycle).toBe(false);
    const atFiveMinutes = analysis.processLiveIngestion(ingest(live, 300_000, "event-2", "1"));
    expect(cycleAt(atFiveMinutes, 300_000).frame.timeframes.find((item) => item.timeframe === fiveMinutes)?.candles)
      .toHaveLength(1);
  });

  it("keeps the higher timeframe hidden throughout intervening lower-timeframe updates", () => {
    const { live, analysis } = liveEngines();
    for (const time of [0, 60_000, 120_000, 180_000, 240_000]) {
      const result = analysis.processLiveIngestion(ingest(live, time, `event-${time}`, String(10 + time)));
      if (time > 0) {
        expect(cycleAt(result, time).frame.timeframes.find((item) => item.timeframe === fiveMinutes)?.candles)
          .toEqual([]);
      }
    }
  });

  it("uses one immutable historical view for every downstream evaluator", () => {
    const seen: readonly CandleSnapshot[][] = [];
    const captured = seen as CandleSnapshot[][];
    const evaluators: RealtimeAnalysisEvaluators = {
      classifyRegime(candles, rule) { captured.push(candles); return classifyMarketRegime(candles, rule); },
      analyzeStructure(candles, rule) { captured.push(candles); return analyzeMarketStructure(candles, rule); },
      evaluateSetups(input, rule) { captured.push(input.setupCandles); return evaluatePositionSetups(input, rule); },
    };
    const subject = new RealtimeAnalysisEngine(config(), evaluators);
    feedThree(subject);
    expect(captured).toHaveLength(3);
    expect(captured[0]).toBe(captured[1]);
    expect(captured[1]).toBe(captured[2]);
  });
});

describe("atomic candle-engine batch contract", () => {
  function multiTimeframeSubject() {
    return new RealtimeAnalysisEngine(config({
      timeframes: [
        { timeframe: oneMinute, historyLimit: 8 },
        { timeframe: fiveMinutes, historyLimit: 8 },
      ],
    }));
  }

  it("fails closed when a new timeframe finalizes after the boundary was published", () => {
    const subject = multiTimeframeSubject();
    const first = subject.processCandleEvents([closed(oneMinute, 240_000, 300_000)]);
    expect(first.status === "ANALYSIS_CYCLES" ? first.cycles : []).toHaveLength(1);
    const before = [...subject.getFinalizedHistories()];

    expect(() => subject.processCandleEvents([closed(fiveMinutes, 0, 300_000)]))
      .toThrow(LateSameBoundaryFinalizationError);
    expect([...subject.getFinalizedHistories()]).toEqual(before);
    expect(subject.getFinalizedHistories().get(fiveMinutes)).toEqual([]);
  });

  it("keeps an exact replay of an already-stored finalized candle idempotent", () => {
    const subject = multiTimeframeSubject();
    const candle = closed(oneMinute, 240_000, 300_000);
    subject.processCandleEvents([candle]);
    const before = [...subject.getFinalizedHistories()];

    expect(subject.processCandleEvents([candle]))
      .toEqual({ status: "NO_ANALYSIS", reason: "DUPLICATE_BOUNDARY" });
    expect([...subject.getFinalizedHistories()]).toEqual(before);
  });

  it("accepts both same-boundary timeframe closes in one atomic direct batch", () => {
    const subject = multiTimeframeSubject();
    const result = subject.processCandleEvents([
      closed(oneMinute, 240_000, 300_000),
      closed(fiveMinutes, 0, 300_000),
    ]);
    expect(result.status === "ANALYSIS_CYCLES" ? result.cycles : []).toHaveLength(1);
    expect(cycleAt(result, 300_000).frame.timeframes.map((item) => item.candles.length)).toEqual([1, 1]);
  });

  it("keeps Task 017 same-boundary ingestion valid", () => {
    const { live, analysis } = liveEngines();
    analysis.processLiveIngestion(ingest(live, 0, "event-0"));
    analysis.processLiveIngestion(ingest(live, 240_000, "event-1"));
    const result = analysis.processLiveIngestion(ingest(live, 300_000, "event-2"));
    expect(result.status === "ANALYSIS_CYCLES" ? result.cycles : []).toHaveLength(1);
    expect(cycleAt(result, 300_000).frame.timeframes.map((item) => item.candles.length)).toEqual([2, 1]);
  });

  it("rejects a new old-boundary timeframe candle after recent cycle-ID eviction", () => {
    const subject = new RealtimeAnalysisEngine(config({
      timeframes: [
        { timeframe: oneMinute, historyLimit: 8 },
        { timeframe: fiveMinutes, historyLimit: 8 },
      ],
      cycleDeduplicationWindowSize: 1,
    }));
    subject.processCandleEvents([closed(oneMinute, 240_000, 300_000)]);
    subject.processCandleEvents([closed(oneMinute, 300_000, 360_000)]);
    subject.processCandleEvents([closed(oneMinute, 360_000, 420_000)]);
    const before = [...subject.getFinalizedHistories()];

    expect(() => subject.processCandleEvents([closed(fiveMinutes, 0, 300_000)]))
      .toThrow(LateSameBoundaryFinalizationError);
    expect([...subject.getFinalizedHistories()]).toEqual(before);
    expect(subject.getFinalizedHistories().get(fiveMinutes)).toEqual([]);
  });

  it("keeps an exact stored replay idempotent after its cycle ID is evicted", () => {
    const subject = new RealtimeAnalysisEngine(config({ cycleDeduplicationWindowSize: 1 }));
    const original = closed(oneMinute, 240_000, 300_000);
    subject.processCandleEvents([original]);
    subject.processCandleEvents([closed(oneMinute, 300_000, 360_000)]);
    subject.processCandleEvents([closed(oneMinute, 360_000, 420_000)]);
    const before = [...subject.getFinalizedHistories()];

    expect(subject.processCandleEvents([original]))
      .toEqual({ status: "NO_ANALYSIS", reason: "DUPLICATE_BOUNDARY" });
    expect([...subject.getFinalizedHistories()]).toEqual(before);
  });

  it("keeps a conflicting stored replay a hard error after its cycle ID is evicted", () => {
    const subject = new RealtimeAnalysisEngine(config({ cycleDeduplicationWindowSize: 1 }));
    subject.processCandleEvents([closed(oneMinute, 240_000, 300_000, "10")]);
    subject.processCandleEvents([closed(oneMinute, 300_000, 360_000)]);
    subject.processCandleEvents([closed(oneMinute, 360_000, 420_000)]);
    const before = [...subject.getFinalizedHistories()];

    expect(() => subject.processCandleEvents([closed(oneMinute, 240_000, 300_000, "11")]))
      .toThrow(/Conflicting finalized candle/);
    expect([...subject.getFinalizedHistories()]).toEqual(before);
  });

  it("accepts a genuinely newer boundary after recent cycle-ID eviction", () => {
    const subject = new RealtimeAnalysisEngine(config({
      timeframes: [
        { timeframe: oneMinute, historyLimit: 8 },
        { timeframe: fiveMinutes, historyLimit: 8 },
      ],
      cycleDeduplicationWindowSize: 1,
    }));
    subject.processCandleEvents([closed(oneMinute, 240_000, 300_000)]);
    subject.processCandleEvents([closed(oneMinute, 300_000, 360_000)]);
    subject.processCandleEvents([closed(oneMinute, 360_000, 420_000)]);

    const result = subject.processCandleEvents([closed(fiveMinutes, 300_000, 600_000)]);
    expect(cycleAt(result, 600_000).frame.timeframes.find((item) => item.timeframe === fiveMinutes)?.candles)
      .toHaveLength(1);
  });

  it("does not advance the monotonic boundary when downstream evaluation throws", () => {
    let shouldThrow = false;
    const subject = new RealtimeAnalysisEngine(config(), {
      classifyRegime: classifyMarketRegime,
      analyzeStructure: analyzeMarketStructure,
      evaluateSetups(input, rule) {
        if (shouldThrow) throw new Error("evaluation failure");
        return evaluatePositionSetups(input, rule);
      },
    });
    feedThree(subject);
    shouldThrow = true;
    expect(() => subject.processCandleEvents([closed(oneMinute, 180_000, 240_000, "13")]))
      .toThrow("evaluation failure");
    shouldThrow = false;

    expect(cycleAt(subject.processCandleEvents([
      closed(oneMinute, 180_000, 240_000, "13"),
    ]), 240_000).triggerCloseTime).toBe(240_000);
  });
});

describe("identity, immutability, and downstream reuse", () => {
  it("creates the same deterministic cycle ID for the same fields", () => {
    const subject = new RealtimeAnalysisEngine(config());
    const fields = { instrumentId: instrument, source, triggerCloseTime: 60_000, analysisProfileId: subject.analysisProfileId };
    expect(createAnalysisCycleId(fields)).toBe(createAnalysisCycleId(fields));
  });

  it("creates a different cycle ID for a different instrument", () => {
    const subject = new RealtimeAnalysisEngine(config());
    expect(createAnalysisCycleId({ instrumentId: instrument, source, triggerCloseTime: 60_000, analysisProfileId: subject.analysisProfileId }))
      .not.toBe(createAnalysisCycleId({ instrumentId: otherInstrument, source, triggerCloseTime: 60_000, analysisProfileId: subject.analysisProfileId }));
  });

  it("creates a different cycle ID for a different source", () => {
    const subject = new RealtimeAnalysisEngine(config());
    expect(createAnalysisCycleId({ instrumentId: instrument, source, triggerCloseTime: 60_000, analysisProfileId: subject.analysisProfileId }))
      .not.toBe(createAnalysisCycleId({ instrumentId: instrument, source: otherSource, triggerCloseTime: 60_000, analysisProfileId: subject.analysisProfileId }));
  });

  it("creates a different cycle ID for a different boundary", () => {
    const subject = new RealtimeAnalysisEngine(config());
    expect(createAnalysisCycleId({ instrumentId: instrument, source, triggerCloseTime: 60_000, analysisProfileId: subject.analysisProfileId }))
      .not.toBe(createAnalysisCycleId({ instrumentId: instrument, source, triggerCloseTime: 120_000, analysisProfileId: subject.analysisProfileId }));
  });

  it("canonicalizes set-like setup configuration in profile identity", () => {
    const first = new RealtimeAnalysisEngine(config({
      setup: {
        continuationAllowedRegimes: ["TREND_UP", "TREND_DOWN"],
        breakoutAllowedRegimes: [],
        reversalAllowedRegimes: [],
      },
    }));
    const second = new RealtimeAnalysisEngine(config({
      setup: {
        continuationAllowedRegimes: ["TREND_DOWN", "TREND_UP"],
        breakoutAllowedRegimes: [],
        reversalAllowedRegimes: [],
      },
    }));
    expect(first.analysisProfileId).toBe(second.analysisProfileId);
  });

  it("changes profile identity when behavioral configuration changes", () => {
    const first = new RealtimeAnalysisEngine(config());
    const second = new RealtimeAnalysisEngine(config({
      timeframes: [{ timeframe: oneMinute, historyLimit: 9 }],
    }));
    expect(first.analysisProfileId).not.toBe(second.analysisProfileId);
  });

  it("does not mutate caller-owned candle input", () => {
    const mutable = {
      type: "CANDLE_CLOSED",
      timeframe: oneMinute,
      snapshot: {
        candle: { ...snapshot(oneMinute, 0, 60_000).candle },
        quality: ["HISTORICAL"],
      },
    } as unknown as CandleEngineEvent;
    const before = structuredClone(mutable);
    new RealtimeAnalysisEngine(config()).processCandleEvents([mutable]);
    expect(mutable).toEqual(before);
    expect(Object.isFrozen(mutable)).toBe(false);
  });

  it("freezes public frames, histories, and evaluated outputs", () => {
    const cycle = feedThree(new RealtimeAnalysisEngine(config()));
    expect(Object.isFrozen(cycle)).toBe(true);
    expect(Object.isFrozen(cycle.frame)).toBe(true);
    expect(Object.isFrozen(cycle.frame.timeframes)).toBe(true);
    expect(Object.isFrozen(cycle.frame.timeframes[0]!.candles)).toBe(true);
    if (cycle.status === "INSUFFICIENT_HISTORY") throw new Error("Expected evaluation");
    expect(Object.isFrozen(cycle.regime)).toBe(true);
    expect(Object.isFrozen(cycle.structure)).toBe(true);
    expect(Object.isFrozen(cycle.setup)).toBe(true);
  });

  it("returns explicit insufficient history without invoking downstream engines", () => {
    const evaluators = {
      classifyRegime: vi.fn(() => { throw new Error("must not run"); }),
      analyzeStructure: vi.fn(() => { throw new Error("must not run"); }),
      evaluateSetups: vi.fn(() => { throw new Error("must not run"); }),
    } as unknown as RealtimeAnalysisEvaluators;
    const cycle = cycleAt(new RealtimeAnalysisEngine(config(), evaluators)
      .processCandleEvents([closed(oneMinute, 0, 60_000)]), 60_000);
    expect(cycle.status).toBe("INSUFFICIENT_HISTORY");
    expect(evaluators.classifyRegime).not.toHaveBeenCalled();
    expect(evaluators.analyzeStructure).not.toHaveBeenCalled();
    expect(evaluators.evaluateSetups).not.toHaveBeenCalled();
  });

  it("invokes the existing regime engine only after a valid frame exists", () => {
    const regime = vi.fn(classifyMarketRegime);
    const subject = new RealtimeAnalysisEngine(config(), {
      classifyRegime: regime,
      analyzeStructure: analyzeMarketStructure,
      evaluateSetups: evaluatePositionSetups,
    });
    feedThree(subject);
    expect(regime).toHaveBeenCalledOnce();
    expect(regime.mock.calls[0]![0].every((item) => item.candle.isClosed)).toBe(true);
  });

  it("passes no future candle to structure analysis", () => {
    const structure = vi.fn(analyzeMarketStructure);
    const subject = new RealtimeAnalysisEngine(config(), {
      classifyRegime: classifyMarketRegime,
      analyzeStructure: structure,
      evaluateSetups: evaluatePositionSetups,
    });
    feedThree(subject);
    subject.processCandleEvents([
      closed(oneMinute, 180_000, 240_000, "13"), closed(oneMinute, 240_000, 300_000, "14"),
    ]);
    const at240 = structure.mock.calls.find((call) => call[0].at(-1)?.candle.closeTime === 240_000);
    expect(at240?.[0].every((item) => item.candle.closeTime <= 240_000)).toBe(true);
  });

  it("passes no future candle to setup evaluation", () => {
    const setup = vi.fn(evaluatePositionSetups);
    const subject = new RealtimeAnalysisEngine(config(), {
      classifyRegime: classifyMarketRegime,
      analyzeStructure: analyzeMarketStructure,
      evaluateSetups: setup,
    });
    feedThree(subject);
    subject.processCandleEvents([
      closed(oneMinute, 180_000, 240_000, "13"), closed(oneMinute, 240_000, 300_000, "14"),
    ]);
    const at240 = setup.mock.calls.find((call) => call[0].asOf === 240_000);
    expect(at240?.[0].setupCandles.every((item) => item.candle.closeTime <= 240_000)).toBe(true);
  });

  it("rolls back staged history if downstream evaluation throws", () => {
    const subject = new RealtimeAnalysisEngine(config(), {
      classifyRegime: classifyMarketRegime,
      analyzeStructure: analyzeMarketStructure,
      evaluateSetups() { throw new Error("failure"); },
    });
    subject.processCandleEvents([closed(oneMinute, 0, 60_000)]);
    subject.processCandleEvents([closed(oneMinute, 60_000, 120_000)]);
    expect(() => subject.processCandleEvents([closed(oneMinute, 120_000, 180_000)])).toThrow("failure");
    expect(subject.getFinalizedHistories().get(oneMinute)).toHaveLength(2);
  });

  it("rejects invalid role configuration and unsafe history limits", () => {
    expect(() => createRealtimeAnalysisConfig(config({
      timeframes: [{ timeframe: oneMinute, historyLimit: 0 }],
    }))).toThrow(/positive safe integer/);
    expect(() => createRealtimeAnalysisConfig(config({
      roles: { regimeTimeframe: fiveMinutes, structureTimeframe: oneMinute, setupTimeframe: oneMinute },
    }))).toThrow(/configured/);
  });
});

describe("determinism and live/replay equivalence", () => {
  it("returns identical outputs for repeated identical runs", () => {
    function run() {
      const subject = new RealtimeAnalysisEngine(config());
      return [
        subject.processCandleEvents([closed(oneMinute, 0, 60_000, "10")]),
        subject.processCandleEvents([closed(oneMinute, 60_000, 120_000, "11")]),
        subject.processCandleEvents([closed(oneMinute, 120_000, 180_000, "12")]),
      ];
    }
    expect(run()).toEqual(run());
  });

  function equivalentRuns() {
    const analysisConfig = config({
      timeframes: [
        { timeframe: oneMinute, historyLimit: 16 },
        { timeframe: fiveMinutes, historyLimit: 8 },
      ],
    });
    const trades = [0, 60_000, 120_000, 180_000, 240_000, 300_000, 360_000]
      .map((time, index) => canonicalTrade(time, String(10 + index)));
    const replayCandles = new MultiTimeframeCandleEngine({
      instrumentId: instrument,
      source,
      alignments: [
        { timeframe: oneMinute, anchorTime: unixMs(0) },
        { timeframe: fiveMinutes, anchorTime: unixMs(0) },
      ],
    });
    const replayAnalysis = new RealtimeAnalysisEngine(analysisConfig);
    const replayResults: ReturnType<RealtimeAnalysisEngine["processCandleEvents"]>[] = [];
    new HistoricalReplayEngine(new ArrayHistoricalEventSource(trades)).run({
      onEvent(trade) {
        replayResults.push(replayAnalysis.processCandleEvents(replayCandles.process(trade)));
      },
    });

    const { live, analysis: liveAnalysis } = liveEngines(analysisConfig);
    const liveResults = trades.map((trade, index) => liveAnalysis.processLiveIngestion(live.ingest(
      createLiveTradeEvent({ sourceEventId: `event-${index}`, event: trade }), trade.eventTime,
    )));
    return { replayResults, liveResults, replayAnalysis, liveAnalysis };
  }

  it("matches live and replay analysis-cycle boundaries", () => {
    const { replayResults, liveResults } = equivalentRuns();
    const boundaries = (results: typeof replayResults) => results.flatMap((result) =>
      result.status === "ANALYSIS_CYCLES" ? result.cycles.map((cycle) => cycle.triggerCloseTime) : []);
    expect(boundaries(liveResults)).toEqual(boundaries(replayResults));
  });

  it("matches live and replay finalized histories", () => {
    const { replayAnalysis, liveAnalysis } = equivalentRuns();
    expect([...liveAnalysis.getFinalizedHistories()]).toEqual([...replayAnalysis.getFinalizedHistories()]);
  });

  it("matches live and replay regime outputs", () => {
    const { replayResults, liveResults } = equivalentRuns();
    const regimes = (results: typeof replayResults) => results.flatMap((result) => result.status === "ANALYSIS_CYCLES"
      ? result.cycles.flatMap((cycle) => cycle.status === "INSUFFICIENT_HISTORY" ? [] : [cycle.regime]) : []);
    expect(regimes(liveResults)).toEqual(regimes(replayResults));
  });

  it("matches live and replay structure outputs", () => {
    const { replayResults, liveResults } = equivalentRuns();
    const structures = (results: typeof replayResults) => results.flatMap((result) => result.status === "ANALYSIS_CYCLES"
      ? result.cycles.flatMap((cycle) => cycle.status === "INSUFFICIENT_HISTORY" ? [] : [cycle.structure]) : []);
    expect(structures(liveResults)).toEqual(structures(replayResults));
  });

  it("matches live and replay setup outputs", () => {
    const { replayResults, liveResults } = equivalentRuns();
    const setups = (results: typeof replayResults) => results.flatMap((result) => result.status === "ANALYSIS_CYCLES"
      ? result.cycles.flatMap((cycle) => cycle.status === "INSUFFICIENT_HISTORY" ? [] : [cycle.setup]) : []);
    expect(setups(liveResults)).toEqual(setups(replayResults));
  });
});
