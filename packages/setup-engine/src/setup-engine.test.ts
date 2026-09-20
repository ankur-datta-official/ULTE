import { describe, expect, it } from "vitest";
import { createCandle, type CandleSnapshot, type DataQualityFlag } from "@ulte/market-data";
import { createInstrumentId, parseTimeframe, unixMs } from "@ulte/instrument-model";
import type { PrimaryRegime, ReadyRegimeResult, RegimeResult } from "@ulte/regime-engine";
import type {
  LiquidityLevel, ReadyStructureResult, StructureAnalysisResult, StructureEvent, StructureEventType,
} from "@ulte/structure-engine";
import {
  createPositionSetupConfig, evaluatePositionSetups, type PositionSetupConfig,
  type ReadySetupEvaluationResult,
} from "./index.js";

const instrument = createInstrumentId({ venue: "TEST", venueSymbol: "ABC", instrumentKind: "SPOT" });
const otherInstrument = createInstrumentId({ venue: "TEST", venueSymbol: "XYZ", instrumentKind: "SPOT" });
const contextTimeframe = parseTimeframe("1d");
const setupTimeframe = parseTimeframe("4h");

const TEST_CONFIG = createPositionSetupConfig({
  continuationAllowedRegimes: ["TREND_UP", "TREND_DOWN"],
  breakoutAllowedRegimes: ["TREND_UP", "TREND_DOWN", "RANGE"],
  reversalAllowedRegimes: ["RANGE", "TRANSITION"],
});

function regime(
  direction: ReadyRegimeResult["direction"] = "UP",
  primaryRegime: PrimaryRegime = direction === "UP" ? "TREND_UP" : direction === "DOWN" ? "TREND_DOWN" : "RANGE",
  overrides: Partial<ReadyRegimeResult> = {},
): ReadyRegimeResult {
  return Object.freeze({
    status: "READY", primaryRegime, direction, volatilityState: "NORMAL", instrumentId: instrument,
    timeframe: contextTimeframe, windowStart: unixMs(0), windowEnd: unixMs(50),
    evidence: Object.freeze({ efficiencyBps: 1, directionalConsistencyBps: 1, volatilityRatioBps: "1", netMoveSign: "POSITIVE" }),
    ...overrides,
  });
}

function level(id: string, price: string, confirmedAt = 10): LiquidityLevel {
  return Object.freeze({
    side: id.startsWith("H") ? "BUY_SIDE" : "SELL_SIDE", price: price as LiquidityLevel["price"],
    sourceSwingId: id, sourcePivotOpenTime: unixMs(0), confirmedAt: unixMs(confirmedAt), status: "BROKEN",
  });
}

function event(type: StructureEventType, detectedAt: number, id: string, price: string): StructureEvent {
  return Object.freeze({
    type, instrumentId: instrument, timeframe: setupTimeframe, detectedAt: unixMs(detectedAt),
    eventCandleOpenTime: unixMs(detectedAt - 1), referenceSwingId: id, referenceSwingTime: unixMs(0),
    referencePrice: price as StructureEvent["referencePrice"],
    liquiditySide: type.includes("ABOVE") ? "BUY_SIDE" : "SELL_SIDE",
  });
}

function structure(
  events: readonly StructureEvent[] = [], levels?: readonly LiquidityLevel[],
  overrides: Partial<ReadyStructureResult> = {},
): ReadyStructureResult {
  const inferred = levels ?? events.map((item) => level(item.referenceSwingId, item.referencePrice));
  const unique = inferred.filter((item, index) => inferred.findIndex((other) => other.sourceSwingId === item.sourceSwingId) === index);
  return Object.freeze({
    status: "READY", instrumentId: instrument, timeframe: setupTimeframe,
    windowStart: unixMs(0), windowEnd: unixMs(50), structureState: "UNDETERMINED",
    confirmedSwings: Object.freeze([]), liquidityLevels: Object.freeze(unique), structureEvents: Object.freeze([...events]),
    ...overrides,
  });
}

function candle(
  openTime: number, low = "9", high = "11", close = "10",
  options: { readonly instrumentId?: string; readonly timeframe?: string; readonly isClosed?: boolean; readonly quality?: readonly DataQualityFlag[]; readonly closeTime?: number } = {},
): CandleSnapshot {
  return Object.freeze({
    candle: createCandle({
      instrumentId: options.instrumentId ?? instrument, timeframe: options.timeframe ?? setupTimeframe,
      openTime, closeTime: options.closeTime ?? openTime + 1, open: "10", high, low, close, volume: "1",
      isClosed: options.isClosed ?? true,
    }),
    quality: Object.freeze([...(options.quality ?? ["LIVE"])]),
  });
}

function evaluate(options: {
  readonly regime?: RegimeResult; readonly structure?: StructureAnalysisResult;
  readonly candles?: readonly CandleSnapshot[]; readonly asOf?: number; readonly config?: PositionSetupConfig;
} = {}) {
  return evaluatePositionSetups({
    asOf: unixMs(options.asOf ?? 100), contextRegime: options.regime ?? regime(),
    setupStructure: options.structure ?? structure(), setupCandles: options.candles ?? [],
  }, options.config ?? TEST_CONFIG);
}

function ready(options: Parameters<typeof evaluate>[0] = {}): ReadySetupEvaluationResult {
  const result = evaluate(options);
  expect(result.status).toBe("READY");
  return result as ReadySetupEvaluationResult;
}

describe("configuration and upstream readiness", () => {
  it("freezes copied regime allowlists and rejects duplicates and unknown values", () => {
    const source: PrimaryRegime[] = ["RANGE"];
    const config = createPositionSetupConfig({ continuationAllowedRegimes: source, breakoutAllowedRegimes: [], reversalAllowedRegimes: [] });
    source.push("TREND_UP");
    expect(config.continuationAllowedRegimes).toEqual(["RANGE"]);
    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config.continuationAllowedRegimes)).toBe(true);
    expect(() => createPositionSetupConfig({ continuationAllowedRegimes: ["RANGE", "RANGE"], breakoutAllowedRegimes: [], reversalAllowedRegimes: [] })).toThrow();
    expect(() => createPositionSetupConfig({ continuationAllowedRegimes: ["UNKNOWN" as PrimaryRegime], breakoutAllowedRegimes: [], reversalAllowedRegimes: [] })).toThrow();
  });

  it.each([
    ["REGIME", { status: "INSUFFICIENT_DATA", reason: "NOT_ENOUGH_CANDLES", requiredCandles: 5, availableCandles: 2 } as RegimeResult],
    ["REGIME", { status: "DATA_REJECTED", reason: "DATA_GAP" } as RegimeResult],
  ] as const)("preserves %s non-ready results", (source, upstream) => {
    expect(evaluate({ regime: upstream })).toEqual({ status: "UPSTREAM_NOT_READY", source, upstreamStatus: upstream.status, reason: upstream.reason });
  });

  it.each([
    [{ status: "INSUFFICIENT_DATA", reason: "NOT_ENOUGH_CANDLES", requiredCandles: 5, availableCandles: 2 } as StructureAnalysisResult],
    [{ status: "DATA_REJECTED", reason: "OPEN_CANDLE" } as StructureAnalysisResult],
  ])("preserves structure non-ready results", (upstream) => {
    expect(evaluate({ structure: upstream })).toEqual({ status: "UPSTREAM_NOT_READY", source: "STRUCTURE", upstreamStatus: upstream.status, reason: upstream.reason });
  });
});

describe("input consistency and as-of validation", () => {
  it("rejects regime/structure instrument mismatch", () => {
    expect(evaluate({ regime: regime("UP", "TREND_UP", { instrumentId: otherInstrument }) })).toEqual({ status: "DATA_REJECTED", reason: "INSTRUMENT_MISMATCH" });
  });

  it.each([
    ["SETUP_CANDLE_INSTRUMENT_MISMATCH", () => [candle(60, "9", "11", "10", { instrumentId: otherInstrument })]],
    ["SETUP_TIMEFRAME_MISMATCH", () => [candle(60, "9", "11", "10", { timeframe: "1h" })]],
    ["OPEN_SETUP_CANDLE", () => [candle(60, "9", "11", "10", { isClosed: false })]],
    ["FUTURE_SETUP_CANDLE", () => [candle(100, "9", "11", "10", { closeTime: 101 })]],
    ["DATA_GAP", () => [candle(60, "9", "11", "10", { quality: ["LIVE", "GAP_DETECTED"] })]],
    ["DUPLICATE_SETUP_CANDLE", () => [candle(60), candle(60)]],
    ["OUT_OF_ORDER_SETUP_CANDLES", () => [candle(70), candle(60)]],
  ] as const)("rejects %s", (reason, candles) => {
    expect(evaluate({ candles: candles() })).toEqual({ status: "DATA_REJECTED", reason });
  });

  it("rejects future upstream windows", () => {
    expect(evaluate({ regime: regime("UP", "TREND_UP", { windowEnd: unixMs(101) }) })).toEqual({ status: "DATA_REJECTED", reason: "FUTURE_REGIME_WINDOW" });
    expect(evaluate({ structure: structure([], [], { windowEnd: unixMs(101) }) })).toEqual({ status: "DATA_REJECTED", reason: "FUTURE_STRUCTURE_WINDOW" });
  });

  it("rejects decreasing structure event chronology without sorting", () => {
    const events = [event("CLOSE_BREAK_ABOVE", 70, "H1", "10"), event("CLOSE_BREAK_BELOW", 60, "L1", "9")];
    expect(evaluate({ structure: structure(events) })).toEqual({ status: "DATA_REJECTED", reason: "OUT_OF_ORDER_STRUCTURE_EVENTS" });
  });

  it("gives a future out-of-order event zero influence at the current asOf", () => {
    const eligible = event("SWEEP_BELOW_RECLAIM", 60, "L1", "9");
    const future = event("CLOSE_BREAK_ABOVE", 120, "H1", "10");
    const withFuture = evaluate({ structure: structure([future, eligible]), asOf: 70 });
    const withoutFuture = evaluate({ structure: structure([eligible]), asOf: 70 });

    expect(withFuture).toEqual(withoutFuture);
    expect(withFuture).toEqual(expect.objectContaining({ status: "READY" }));
    expect((withFuture as ReadySetupEvaluationResult).candidates).toContainEqual(expect.objectContaining({
      family: "TREND_PULLBACK_CONTINUATION", direction: "UP", stage: "ARMED", initiatedAt: 60,
    }));
  });
});

describe("trend pullback continuation", () => {
  it.each([
    ["UP", "SWEEP_BELOW_RECLAIM", "L1"],
    ["DOWN", "SWEEP_ABOVE_RECLAIM", "H1"],
  ] as const)("arms %s after its initiating sweep", (direction, type, id) => {
    const result = ready({ regime: regime(direction), structure: structure([event(type, 60, id, "10")]) });
    expect(result.candidates).toContainEqual(expect.objectContaining({ family: "TREND_PULLBACK_CONTINUATION", direction, stage: "ARMED", initiatedAt: 60 }));
  });

  it.each([
    ["UP", "SWEEP_BELOW_RECLAIM", "CLOSE_BREAK_ABOVE", "L1", "H1"],
    ["DOWN", "SWEEP_ABOVE_RECLAIM", "CLOSE_BREAK_BELOW", "H1", "L1"],
  ] as const)("confirms %s only on a later eligible break", (direction, sweep, breakType, sweepId, breakId) => {
    const events = [event(sweep, 60, sweepId, "10"), event(breakType, 70, breakId, "11")];
    const result = ready({ regime: regime(direction), structure: structure(events) });
    expect(result.candidates).toContainEqual(expect.objectContaining({ family: "TREND_PULLBACK_CONTINUATION", direction, stage: "CONFIRMED", confirmedAt: 70 }));
  });

  it("requires direction agreement and an allowed regime", () => {
    const sweep = event("SWEEP_BELOW_RECLAIM", 60, "L1", "10");
    expect(ready({ regime: regime("DOWN"), structure: structure([sweep]) }).candidates.some((c) => c.family === "TREND_PULLBACK_CONTINUATION" && c.direction === "UP")).toBe(false);
    expect(ready({ regime: regime("UP", "RANGE"), structure: structure([sweep]) }).candidates.some((c) => c.family === "TREND_PULLBACK_CONTINUATION")).toBe(false);
  });

  it("requires a strictly later break with a pre-existing reference", () => {
    const sameTime = [event("SWEEP_BELOW_RECLAIM", 60, "L1", "9"), event("CLOSE_BREAK_ABOVE", 60, "H1", "10")];
    expect(ready({ structure: structure(sameTime) }).candidates.find((c) => c.family === "TREND_PULLBACK_CONTINUATION")?.stage).toBe("ARMED");
    const futureLevel = [level("L1", "9", 10), level("H1", "10", 65)];
    const later = [event("SWEEP_BELOW_RECLAIM", 60, "L1", "9"), event("CLOSE_BREAK_ABOVE", 70, "H1", "10")];
    expect(ready({ structure: structure(later, futureLevel) }).candidates.find((c) => c.family === "TREND_PULLBACK_CONTINUATION")?.stage).toBe("ARMED");
  });
});

describe("breakout retest", () => {
  it.each([
    ["UP", "CLOSE_BREAK_ABOVE", "H1", "UP"],
    ["DOWN", "CLOSE_BREAK_BELOW", "L1", "DOWN"],
  ] as const)("arms %s on a close break", (direction, type, id, contextDirection) => {
    expect(ready({ regime: regime(contextDirection), structure: structure([event(type, 60, id, "10")]) }).candidates)
      .toContainEqual(expect.objectContaining({ family: "BREAKOUT_RETEST", direction, stage: "ARMED" }));
  });

  it.each([
    ["UP", "CLOSE_BREAK_ABOVE", candle(70, "10", "12", "10")],
    ["DOWN", "CLOSE_BREAK_BELOW", candle(70, "8", "10", "10")],
  ] as const)("confirms %s on the first later retest including exact touch", (direction, type, retest) => {
    const result = ready({ regime: regime(direction), structure: structure([event(type, 60, direction === "UP" ? "H1" : "L1", "10")]), candles: [retest] });
    expect(result.candidates).toContainEqual(expect.objectContaining({ family: "BREAKOUT_RETEST", direction, stage: "CONFIRMED", confirmedAt: 71 }));
  });

  it("does not use the breakout candle itself as a retest", () => {
    const result = ready({ structure: structure([event("CLOSE_BREAK_ABOVE", 60, "H1", "10")]), candles: [candle(59, "10", "12", "10", { closeTime: 60 })] });
    expect(result.candidates.find((c) => c.family === "BREAKOUT_RETEST")?.stage).toBe("ARMED");
  });

  it("blocks the opposite context direction and disallowed regimes", () => {
    const upBreak = structure([event("CLOSE_BREAK_ABOVE", 60, "H1", "10")]);
    expect(ready({ regime: regime("DOWN"), structure: upBreak }).candidates.some((c) => c.family === "BREAKOUT_RETEST" && c.direction === "UP")).toBe(false);
    expect(ready({ regime: regime("NEUTRAL", "COMPRESSION"), structure: upBreak }).candidates.some((c) => c.family === "BREAKOUT_RETEST")).toBe(false);
  });

  it.each([
    ["0.1", "0.1", "0.2"],
    ["0.000000000000000001", "0.000000000000000001", "0.000000000000000002"],
    ["999999999999999999999999999999.1", "999999999999999999999999999999.1", "999999999999999999999999999999.2"],
  ])("uses exact decimal comparison for reference %s", (price, low, close) => {
    const result = ready({ structure: structure([event("CLOSE_BREAK_ABOVE", 60, "H1", price)]), candles: [candle(70, low, close, close)] });
    expect(result.candidates.find((c) => c.family === "BREAKOUT_RETEST")?.stage).toBe("CONFIRMED");
  });
});

describe("liquidity sweep reversal", () => {
  it.each([
    ["DOWN", "SWEEP_ABOVE_RECLAIM", "CLOSE_BREAK_BELOW", "H1", "L1"],
    ["UP", "SWEEP_BELOW_RECLAIM", "CLOSE_BREAK_ABOVE", "L1", "H1"],
  ] as const)("arms then confirms %s reversal", (direction, sweep, breakType, sweepId, breakId) => {
    const armed = ready({ regime: regime("NEUTRAL", "RANGE"), structure: structure([event(sweep, 60, sweepId, "10")]) });
    expect(armed.candidates).toContainEqual(expect.objectContaining({ family: "LIQUIDITY_SWEEP_REVERSAL", direction, stage: "ARMED" }));
    const confirmed = ready({ regime: regime("NEUTRAL", "RANGE"), structure: structure([event(sweep, 60, sweepId, "10"), event(breakType, 70, breakId, "9")]) });
    expect(confirmed.candidates).toContainEqual(expect.objectContaining({ family: "LIQUIDITY_SWEEP_REVERSAL", direction, stage: "CONFIRMED", confirmedAt: 70 }));
  });

  it("requires an allowed regime but not context direction agreement", () => {
    const sweep = structure([event("SWEEP_ABOVE_RECLAIM", 60, "H1", "10")]);
    expect(ready({ regime: regime("UP", "RANGE"), structure: sweep }).candidates).toContainEqual(expect.objectContaining({ family: "LIQUIDITY_SWEEP_REVERSAL", direction: "DOWN" }));
    expect(ready({ regime: regime("UP", "TREND_UP"), structure: sweep }).candidates.some((c) => c.family === "LIQUIDITY_SWEEP_REVERSAL")).toBe(false);
  });

  it("does not confirm from a future-created break reference", () => {
    const events = [event("SWEEP_ABOVE_RECLAIM", 60, "H1", "10"), event("CLOSE_BREAK_BELOW", 70, "L1", "9")];
    const result = ready({ regime: regime("UP", "RANGE"), structure: structure(events, [level("H1", "10"), level("L1", "9", 65)]) });
    expect(result.candidates.find((c) => c.family === "LIQUIDITY_SWEEP_REVERSAL")?.stage).toBe("ARMED");
  });
});

describe("recency, no-lookahead, and determinism", () => {
  it("chooses the latest initiation even when an older setup is confirmed", () => {
    const events = [
      event("SWEEP_BELOW_RECLAIM", 55, "L1", "8"), event("CLOSE_BREAK_ABOVE", 60, "H1", "10"),
      event("SWEEP_BELOW_RECLAIM", 70, "L2", "9"),
    ];
    const candidates = ready({ structure: structure(events) }).candidates.filter((c) => c.family === "TREND_PULLBACK_CONTINUATION");
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toEqual(expect.objectContaining({ initiatedAt: 70, stage: "ARMED" }));
  });

  it("returns at most one candidate per family/direction and allows zero candidates", () => {
    const events = [event("SWEEP_BELOW_RECLAIM", 55, "L1", "8"), event("SWEEP_BELOW_RECLAIM", 60, "L2", "9")];
    expect(ready({ structure: structure(events) }).candidates.filter((c) => c.family === "TREND_PULLBACK_CONTINUATION" && c.direction === "UP")).toHaveLength(1);
    expect(ready().candidates).toEqual([]);
  });

  it("ignores events after asOf and does not expose future confirmation in growing prefixes", () => {
    const allEvents = [event("SWEEP_BELOW_RECLAIM", 60, "L1", "9"), event("CLOSE_BREAK_ABOVE", 80, "H1", "10")];
    const fullStructure = structure(allEvents, undefined, { windowEnd: unixMs(50) });
    expect(ready({ structure: fullStructure, asOf: 55 }).candidates).toEqual([]);
    expect(ready({ structure: fullStructure, asOf: 70 }).candidates.find((c) => c.family === "TREND_PULLBACK_CONTINUATION")?.stage).toBe("ARMED");
    const confirmed = ready({ structure: fullStructure, asOf: 90 }).candidates.find((c) => c.family === "TREND_PULLBACK_CONTINUATION");
    expect(confirmed).toEqual(expect.objectContaining({ stage: "CONFIRMED", initiatedAt: 60, confirmedAt: 80 }));
  });

  it("applies the same prefix protection to breakout retests", () => {
    const breakout = structure([event("CLOSE_BREAK_ABOVE", 60, "H1", "10")]);
    expect(ready({ structure: breakout, asOf: 55 }).candidates).toEqual([]);
    expect(ready({ structure: breakout, asOf: 70 }).candidates.find((c) => c.family === "BREAKOUT_RETEST")?.stage).toBe("ARMED");
    expect(ready({ structure: breakout, candles: [candle(79, "10", "11", "10", { closeTime: 80 })], asOf: 80 }).candidates.find((c) => c.family === "BREAKOUT_RETEST"))
      .toEqual(expect.objectContaining({ stage: "CONFIRMED", initiatedAt: 60, confirmedAt: 80 }));
  });

  it("does not mutate inputs and returns deeply immutable deterministic candidates and IDs", () => {
    const events = Object.freeze([event("SWEEP_BELOW_RECLAIM", 60, "L1", "9"), event("CLOSE_BREAK_ABOVE", 70, "H1", "10")]);
    const candles = Object.freeze([candle(80, "10", "11", "10")]);
    const inputStructure = structure(events);
    const first = ready({ structure: inputStructure, candles });
    const second = ready({ structure: inputStructure, candles });
    expect(first).toEqual(second);
    expect(inputStructure.structureEvents).toEqual(events);
    expect(candles).toHaveLength(1);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.candidates)).toBe(true);
    for (const value of first.candidates) {
      expect(Object.isFrozen(value)).toBe(true);
      expect(Object.isFrozen(value.evidence)).toBe(true);
      expect(Object.isFrozen(value.evidence.initiation)).toBe(true);
      expect(Object.isFrozen(value.evidence.initiation.event)).toBe(true);
      expect(Object.isFrozen(value.evidence.initiation.referenceLevel)).toBe(true);
    }
    expect(first.candidates[0]?.id).toBe(second.candidates[0]?.id);
  });

  it("rejects an initiating event whose reference cannot be found", () => {
    const result = ready({ structure: structure([event("SWEEP_BELOW_RECLAIM", 60, "MISSING", "9")], []) });
    expect(result.candidates).toEqual([]);
  });
});
