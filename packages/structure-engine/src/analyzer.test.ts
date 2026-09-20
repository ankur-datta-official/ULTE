import { describe, expect, it } from "vitest";
import { createInstrumentId } from "@ulte/instrument-model";
import { createCandle, type CandleSnapshot, type DataQualityFlag } from "@ulte/market-data";
import { analyzeMarketStructure, createStructureConfig, type ReadyStructureResult } from "./index.js";

const instrument = createInstrumentId({ venue: "TEST", venueSymbol: "ABC", instrumentKind: "SPOT" });
const otherInstrument = createInstrumentId({ venue: "TEST", venueSymbol: "XYZ", instrumentKind: "SPOT" });

function candle(
  index: number,
  high: string,
  low: string,
  options: {
    readonly close?: string; readonly open?: string; readonly isClosed?: boolean;
    readonly instrumentId?: string; readonly timeframe?: string; readonly quality?: readonly DataQualityFlag[];
    readonly openTime?: number; readonly closeTime?: number;
  } = {},
): CandleSnapshot {
  const openTime = options.openTime ?? index * 1_000;
  return Object.freeze({
    candle: createCandle({
      instrumentId: options.instrumentId ?? instrument, timeframe: options.timeframe ?? "1m",
      openTime, closeTime: options.closeTime ?? openTime + 1_000,
      open: options.open ?? low, high, low, close: options.close ?? low, volume: "1",
      isClosed: options.isClosed ?? true,
    }),
    quality: Object.freeze([...(options.quality ?? ["LIVE"])]),
  });
}

function series(highs: readonly string[], lows: readonly string[] = highs.map(() => "1")): CandleSnapshot[] {
  return highs.map((high, index) => candle(index, high, lows[index]!));
}

const config = createStructureConfig({ lookbackBars: 5, pivotLeftBars: 1, pivotRightBars: 1 });

function ready(candles: readonly CandleSnapshot[], selectedConfig = config): ReadyStructureResult {
  const result = analyzeMarketStructure(candles, selectedConfig);
  expect(result.status).toBe("READY");
  return result as ReadyStructureResult;
}

describe("configuration and input validation", () => {
  it("validates positive safe integers and a usable pivot window", () => {
    expect(() => createStructureConfig({ lookbackBars: 2, pivotLeftBars: 1, pivotRightBars: 1 })).toThrow();
    expect(() => createStructureConfig({ lookbackBars: 5, pivotLeftBars: 0, pivotRightBars: 1 })).toThrow();
    expect(() => createStructureConfig({ lookbackBars: 5, pivotLeftBars: 1, pivotRightBars: Number.MAX_SAFE_INTEGER })).toThrow();
    expect(Object.isFrozen(config)).toBe(true);
  });

  it("returns insufficient data", () => {
    expect(analyzeMarketStructure(series(["1", "2"]), config)).toEqual({
      status: "INSUFFICIENT_DATA", reason: "NOT_ENOUGH_CANDLES", requiredCandles: 5, availableCandles: 2,
    });
  });

  it.each([
    ["OPEN_CANDLE", () => series(["1", "2", "3", "4", "5"]).map((value, index) => index === 2 ? candle(2, "3", "1", { isClosed: false }) : value)],
    ["INSTRUMENT_MISMATCH", () => series(["1", "2", "3", "4", "5"]).map((value, index) => index === 2 ? candle(2, "3", "1", { instrumentId: otherInstrument }) : value)],
    ["TIMEFRAME_MISMATCH", () => series(["1", "2", "3", "4", "5"]).map((value, index) => index === 2 ? candle(2, "3", "1", { timeframe: "5m" }) : value)],
    ["DUPLICATE_CANDLE", () => [candle(0, "1", "1"), candle(1, "2", "1"), candle(1, "3", "1"), candle(3, "4", "1"), candle(4, "5", "1")]],
    ["OUT_OF_ORDER", () => [candle(0, "1", "1"), candle(2, "2", "1"), candle(1, "3", "1"), candle(3, "4", "1"), candle(4, "5", "1")]],
    ["DATA_GAP", () => series(["1", "2", "3", "4", "5"]).map((value, index) => index === 2 ? candle(2, "3", "1", { quality: ["GAP_DETECTED"] }) : value)],
  ] as const)("rejects %s", (reason, build) => {
    expect(analyzeMarketStructure(build(), config)).toEqual({ status: "DATA_REJECTED", reason });
  });

  it("validates and analyzes only the most recent configured window without sorting or mutation", () => {
    const ignoredGap = candle(0, "1", "1", { quality: ["GAP_DETECTED"] });
    const input = [ignoredGap, ...series(["2", "3", "2", "4", "2"]).map((value, index) =>
      candle(index + 1, value.candle.high, value.candle.low))];
    const before = [...input];
    const result = ready(input);
    expect(result.windowStart).toBe(1_000);
    expect(input).toEqual(before);
  });
});

describe("confirmed pivots, relationships, and state", () => {
  it("detects strict highs/lows, disqualifies ties, and records confirmation time", () => {
    const highResult = ready(series(["2", "3", "2", "1", "2"], ["1", "2", "1", "0.5", "1"]));
    expect(highResult.confirmedSwings).toContainEqual(expect.objectContaining({
      kind: "HIGH", price: "3", pivotOpenTime: 1_000, pivotCloseTime: 2_000, confirmedAt: 3_000,
    }));
    expect(highResult.confirmedSwings).toContainEqual(expect.objectContaining({ kind: "LOW", price: "0.5" }));
    expect(ready(series(["2", "3", "3", "2", "1"])).confirmedSwings.filter((s) => s.kind === "HIGH")).toHaveLength(0);
    expect(ready(series(["5", "5", "5", "5", "5"], ["2", "1", "1", "2", "3"])).confirmedSwings.filter((s) => s.kind === "LOW")).toHaveLength(0);
  });

  it.each([
    [["1", "3", "1", "4", "1"], ["1", "1", "1", "1", "1"], "HIGHER_HIGH"],
    [["1", "4", "1", "3", "1"], ["1", "1", "1", "1", "1"], "LOWER_HIGH"],
    [["1", "3", "1", "3", "1"], ["1", "1", "1", "1", "1"], "EQUAL_HIGH"],
    [["5", "5", "5", "5", "5"], ["5", "1", "5", "2", "5"], "HIGHER_LOW"],
    [["5", "5", "5", "5", "5"], ["5", "2", "5", "1", "5"], "LOWER_LOW"],
    [["5", "5", "5", "5", "5"], ["5", "1", "5", "1", "5"], "EQUAL_LOW"],
  ] as const)("classifies %s/%s as %s", (highs, lows, expected) => {
    const swings = ready(series(highs, lows)).confirmedSwings;
    expect(swings.at(-1)?.relation).toBe(expected);
    expect(swings[0]?.relation).toBe("UNCLASSIFIED");
  });

  it.each([
    [
      ["5", "7", "6", "8", "7", "9"], ["4", "5", "3", "5", "4", "6"], "UP",
    ],
    [
      ["7", "8", "6", "7", "5", "6"], ["6", "5", "4", "5", "3", "4"], "DOWN",
    ],
    [
      ["5", "7", "6", "8", "7", "9"], ["6", "5", "4", "5", "3", "4"], "MIXED",
    ],
  ] as const)("derives %s state", (highs, lows, expected) => {
    const sixBarConfig = createStructureConfig({ lookbackBars: 6, pivotLeftBars: 1, pivotRightBars: 1 });
    expect(ready(series(highs, lows), sixBarConfig).structureState).toBe(expected);
  });

  it("is undetermined until both kinds have classified evidence", () => {
    expect(ready(series(["1", "3", "1", "2", "1"])).structureState).toBe("UNDETERMINED");
  });

  it("allows one candle to be independently both a high and a low pivot", () => {
    const result = ready(series(["5", "10", "6", "7", "8"], ["4", "1", "5", "6", "7"]));
    expect(result.confirmedSwings.filter((s) => s.pivotOpenTime === 1_000).map((s) => s.kind)).toEqual(["HIGH", "LOW"]);
  });
});

describe("liquidity lifecycle and chronology", () => {
  it("creates side-specific active levels only at confirmation", () => {
    const result = ready(series(["5", "10", "5", "6", "7"], ["4", "3", "1", "4", "5"]));
    expect(result.liquidityLevels).toEqual(expect.arrayContaining([
      expect.objectContaining({ side: "BUY_SIDE", price: "10", confirmedAt: 3_000, status: "ACTIVE" }),
      expect.objectContaining({ side: "SELL_SIDE", price: "1", confirmedAt: 4_000, status: "ACTIVE" }),
    ]));
  });

  it.each([
    ["buy sweep", ["5", "10", "5", "11", "6"], ["4", "3", "2", "3", "4"], "10", "SWEEP_ABOVE_RECLAIM", "SWEPT"],
    ["buy break", ["5", "10", "5", "11", "6"], ["4", "3", "2", "3", "4"], "10.1", "CLOSE_BREAK_ABOVE", "BROKEN"],
    ["sell sweep", ["6", "7", "6", "7", "8"], ["5", "2", "5", "1", "4"], "2", "SWEEP_BELOW_RECLAIM", "SWEPT"],
    ["sell break", ["6", "7", "6", "7", "8"], ["5", "2", "5", "1", "4"], "1.9", "CLOSE_BREAK_BELOW", "BROKEN"],
  ] as const)("handles %s", (_name, highs, lows, eventClose, type, status) => {
    const candles = series(highs, lows);
    candles[3] = candle(3, highs[3]!, lows[3]!, { close: eventClose });
    const result = ready(candles);
    expect(result.structureEvents[0]).toEqual(expect.objectContaining({ type, detectedAt: 4_000, eventCandleOpenTime: 3_000 }));
    const side = type.includes("ABOVE") ? "BUY_SIDE" : "SELL_SIDE";
    expect(result.liquidityLevels.find((level) => level.side === side)).toEqual(
      expect.objectContaining({ status, resolvedAt: 4_000 }),
    );
  });

  it("does not treat an exact touch as a sweep", () => {
    const candles = series(["5", "10", "5", "10", "6"]);
    candles[3] = candle(3, "10", "1", { close: "9" });
    expect(ready(candles).structureEvents).toHaveLength(0);
  });

  it("gives a close break priority and never resolves the same level twice", () => {
    const candles = series(["5", "10", "5", "12", "13"]);
    candles[3] = candle(3, "12", "1", { close: "11" });
    candles[4] = candle(4, "13", "1", { close: "12" });
    const result = ready(candles);
    expect(result.structureEvents.filter((event) => event.referenceSwingId === "HIGH:1000")).toHaveLength(1);
    expect(result.structureEvents[0]?.type).toBe("CLOSE_BREAK_ABOVE");
  });

  it("resolves multiple older levels in source-confirmation order", () => {
    const multipleConfig = createStructureConfig({ lookbackBars: 7, pivotLeftBars: 1, pivotRightBars: 1 });
    const candles = series(["5", "10", "5", "9", "5", "11", "5"]);
    candles[5] = candle(5, "11", "1", { close: "11" });
    const result = ready(candles, multipleConfig);
    expect(result.structureEvents.slice(0, 2).map((event) => event.referenceSwingTime)).toEqual([1_000, 3_000]);
  });

  it("uses exact decimals at very small and very large magnitudes", () => {
    const tiny = series(["0.000000000000000001", "0.000000000000000003", "0.000000000000000002", "0.000000000000000004", "0.000000000000000001"]);
    expect(ready(tiny).confirmedSwings.at(-1)?.relation).toBe("HIGHER_HIGH");
    const huge = series(["999999999999999999999999999999.1", "999999999999999999999999999999.3", "999999999999999999999999999999.2", "999999999999999999999999999999.4", "999999999999999999999999999999.1"]);
    expect(ready(huge).confirmedSwings.at(-1)?.relation).toBe("HIGHER_HIGH");
    expect(ready(series(["0.1", "0.2", "0.10", "0.20", "0.1"])).confirmedSwings.at(-1)?.relation).toBe("EQUAL_HIGH");
  });
});

describe("no-lookahead and determinism", () => {
  it("reveals pivots, levels, and later events only in eligible growing prefixes", () => {
    const all = series(["4", "5", "6", "10", "6", "7", "11", "5"]);
    all[6] = candle(6, "11", "1", { close: "10" });
    const prefixConfig = createStructureConfig({ lookbackBars: 5, pivotLeftBars: 1, pivotRightBars: 2 });
    const observations = [5, 6, 7].map((length) => ready(all.slice(0, length), prefixConfig));
    expect(observations[0]!.confirmedSwings.some((s) => s.pivotOpenTime === 3_000)).toBe(false);
    expect(observations[1]!.confirmedSwings.find((s) => s.pivotOpenTime === 3_000)?.confirmedAt).toBe(6_000);
    expect(observations[1]!.liquidityLevels.some((level) => level.sourcePivotOpenTime === 3_000)).toBe(true);
    expect(observations[1]!.structureEvents.some((event) => event.referenceSwingTime === 3_000)).toBe(false);
    expect(observations[2]!.structureEvents.find((event) => event.referenceSwingTime === 3_000)).toEqual(
      expect.objectContaining({ type: "SWEEP_ABOVE_RECLAIM", detectedAt: 7_000 }),
    );
  });

  it("does not backdate an event and produces deeply equivalent immutable results", () => {
    const candles = series(["5", "10", "5", "11", "6"]);
    candles[3] = candle(3, "11", "1", { close: "10" });
    const first = ready(candles);
    const second = ready(candles);
    expect(first).toEqual(second);
    expect(first.structureEvents[0]?.detectedAt).toBe(4_000);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.confirmedSwings)).toBe(true);
    expect(Object.isFrozen(first.liquidityLevels)).toBe(true);
    expect(Object.isFrozen(first.structureEvents)).toBe(true);
    expect(first.confirmedSwings.every(Object.isFrozen)).toBe(true);
    expect(first.liquidityLevels.every(Object.isFrozen)).toBe(true);
    expect(first.structureEvents.every(Object.isFrozen)).toBe(true);
  });
});
