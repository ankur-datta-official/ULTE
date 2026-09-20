import { describe, expect, it } from "vitest";
import { createCandle, type CandleSnapshot, type DataQualityFlag } from "@ulte/market-data";
import { classifyMarketRegime, createRegimeConfig, requiredCandleCount, type RegimeConfig } from "./index.js";

const ID = "ulte:v1:test:SPOT:ABC";
const OTHER_ID = "ulte:v1:test:SPOT:XYZ";
const CONFIG: RegimeConfig = {
  trendLookback: 5,
  baselineVolatilityBars: 3,
  recentVolatilityBars: 2,
  trendEfficiencyMinBps: 7_000,
  trendConsistencyMinBps: 7_000,
  rangeEfficiencyMaxBps: 2_500,
  rangeConsistencyMaxBps: 6_000,
  compressionRatioMaxBps: 5_000,
  expansionRatioMinBps: 15_000,
};

function snapshots(
  closes: readonly string[],
  options: {
    readonly spreads?: readonly string[];
    readonly instrumentAt?: Readonly<Record<number, string>>;
    readonly timeframeAt?: Readonly<Record<number, string>>;
    readonly openAt?: Readonly<Record<number, boolean>>;
    readonly qualityAt?: Readonly<Record<number, readonly DataQualityFlag[]>>;
    readonly times?: readonly number[];
  } = {},
): readonly CandleSnapshot[] {
  return closes.map((close, index) => {
    const spread = options.spreads?.[index] ?? "1";
    const scale = close.includes(".") ? close.split(".")[1]!.length : 0;
    const coefficient = BigInt(close.replace(".", ""));
    const spreadScale = spread.includes(".") ? spread.split(".")[1]!.length : 0;
    const commonScale = Math.max(scale, spreadScale);
    const center = coefficient * 10n ** BigInt(commonScale - scale);
    const width = BigInt(spread.replace(".", "")) * 10n ** BigInt(commonScale - spreadScale);
    const format = (value: bigint): string => {
      if (commonScale === 0) return value.toString();
      const digits = value.toString().padStart(commonScale + 1, "0");
      return `${digits.slice(0, -commonScale)}.${digits.slice(-commonScale)}`;
    };
    const openTime = options.times?.[index] ?? index * 60_000;
    const candle = createCandle({
      instrumentId: options.instrumentAt?.[index] ?? ID,
      timeframe: options.timeframeAt?.[index] ?? "1m",
      openTime,
      closeTime: openTime + 60_000,
      open: close,
      high: format(center + width),
      low: format(center > width ? center - width : 1n),
      close,
      volume: "1",
      isClosed: !(options.openAt?.[index] ?? false),
    });
    return Object.freeze({ candle, quality: Object.freeze([...(options.qualityAt?.[index] ?? ["LIVE"])]) });
  });
}

function ready(candles: readonly CandleSnapshot[], config: RegimeConfig = CONFIG) {
  const result = classifyMarketRegime(candles, config);
  expect(result.status).toBe("READY");
  if (result.status !== "READY") throw new Error("Expected READY result");
  return result;
}

describe("configuration and readiness", () => {
  it("requires the larger complete lookback", () => {
    expect(requiredCandleCount(CONFIG)).toBe(6);
    expect(classifyMarketRegime(snapshots(["1", "2"]), CONFIG)).toEqual({
      status: "INSUFFICIENT_DATA", reason: "NOT_ENOUGH_CANDLES", requiredCandles: 6, availableCandles: 2,
    });
  });

  it.each([
    [{ ...CONFIG, trendLookback: 1 }, "trendLookback"],
    [{ ...CONFIG, recentVolatilityBars: 0 }, "recentVolatilityBars"],
    [{ ...CONFIG, trendEfficiencyMinBps: 10_001 }, "trendEfficiencyMinBps"],
    [{ ...CONFIG, compressionRatioMaxBps: 20_000, expansionRatioMinBps: 20_000 }, "compressionRatioMaxBps"],
    [{ ...CONFIG, rangeEfficiencyMaxBps: 8_000, rangeConsistencyMaxBps: 8_000 }, "Range thresholds"],
  ])("rejects invalid config %#", (config, message) => {
    expect(() => createRegimeConfig(config as RegimeConfig)).toThrow(message as string);
  });
});

describe("input rejection", () => {
  const values = ["10", "11", "12", "13", "14", "15"];
  it("rejects an open candle", () => expect(classifyMarketRegime(snapshots(values, { openAt: { 5: true } }), CONFIG))
    .toMatchObject({ status: "DATA_REJECTED", reason: "OPEN_CANDLE" }));
  it("rejects instrument mismatch", () => expect(classifyMarketRegime(snapshots(values, { instrumentAt: { 3: OTHER_ID } }), CONFIG))
    .toMatchObject({ status: "DATA_REJECTED", reason: "INSTRUMENT_MISMATCH" }));
  it("rejects timeframe mismatch", () => expect(classifyMarketRegime(snapshots(values, { timeframeAt: { 2: "5m" } }), CONFIG))
    .toMatchObject({ status: "DATA_REJECTED", reason: "TIMEFRAME_MISMATCH" }));
  it("rejects duplicate times distinctly", () => expect(classifyMarketRegime(snapshots(values, { times: [0, 60_000, 120_000, 180_000, 60_000, 300_000] }), CONFIG))
    .toMatchObject({ status: "DATA_REJECTED", reason: "DUPLICATE_CANDLE" }));
  it("rejects out-of-order and overlapping candles", () => expect(classifyMarketRegime(snapshots(values, { times: [0, 60_000, 120_000, 90_000, 240_000, 300_000] }), CONFIG))
    .toMatchObject({ status: "DATA_REJECTED", reason: "OUT_OF_ORDER" }));
  it("rejects explicit gaps", () => expect(classifyMarketRegime(snapshots(values, { qualityAt: { 4: ["LIVE", "GAP_DETECTED"] } }), CONFIG))
    .toMatchObject({ status: "DATA_REJECTED", reason: "DATA_GAP" }));
});

describe("classification", () => {
  it("classifies perfect rises and falls", () => {
    expect(ready(snapshots(["10", "11", "12", "13", "14", "15"]))).toMatchObject({ primaryRegime: "TREND_UP", direction: "UP" });
    expect(ready(snapshots(["15", "14", "13", "12", "11", "10"]))).toMatchObject({ primaryRegime: "TREND_DOWN", direction: "DOWN" });
  });

  it("classifies flat closes as range with neutral direction", () => {
    expect(ready(snapshots(["10", "10", "10", "10", "10", "10"]))).toMatchObject({ primaryRegime: "RANGE", direction: "NEUTRAL" });
  });

  it("classifies alternating closes as range", () => {
    expect(ready(snapshots(["10", "11", "10", "11", "10", "11"]))).toMatchObject({ primaryRegime: "RANGE" });
  });

  it("uses transition for evidence between range and trend", () => {
    expect(ready(snapshots(["10", "12", "11", "13", "12", "14"]))).toMatchObject({ primaryRegime: "TRANSITION" });
  });

  it("prioritizes compression and expansion while preserving direction", () => {
    const compression = snapshots(["10", "11", "12", "13", "14", "15"], { spreads: ["4", "4", "4", "1", "1", "1"] });
    expect(ready(compression)).toMatchObject({ primaryRegime: "COMPRESSION", volatilityState: "COMPRESSION", direction: "UP" });
    const up = snapshots(["10", "11", "12", "13", "16", "20"], { spreads: ["1", "1", "1", "5", "5", "5"] });
    expect(ready(up)).toMatchObject({ primaryRegime: "EXPANSION", volatilityState: "EXPANSION", direction: "UP" });
    const down = snapshots(["20", "19", "18", "17", "13", "10"], { spreads: ["1", "1", "1", "5", "5", "5"] });
    expect(ready(down)).toMatchObject({ primaryRegime: "EXPANSION", direction: "DOWN" });
  });

  it("handles repeated closes and zero baseline volatility explicitly", () => {
    const result = ready(snapshots(["10", "10", "10", "10", "12", "14"], { spreads: ["0", "0", "0", "0", "1", "1"] }));
    expect(result).toMatchObject({ primaryRegime: "EXPANSION", evidence: { volatilityRatioBps: "UNBOUNDED" } });
  });

  it.each([
    [["0.1", "0.2", "0.1", "0.2", "0.1", "0.2"]],
    [["9.9", "10", "9.9", "10", "9.9", "10"]],
    [["0.000000000000000001", "0.000000000000000002", "0.000000000000000001", "0.000000000000000002", "0.000000000000000001", "0.000000000000000002"]],
    [["999999999999999999999999999999", "1000000000000000000000000000000", "999999999999999999999999999999", "1000000000000000000000000000000", "999999999999999999999999999999", "1000000000000000000000000000000"]],
  ])("uses exact decimals without exponent output %#", (values) => {
    const result = ready(snapshots(values, { spreads: values.map(() => "0.000000000000000001") }));
    expect(result.evidence.volatilityRatioBps).not.toMatch(/[eE]/);
  });
});

describe("determinism and immutability", () => {
  it("does not mutate input, freezes output, and repeats deeply equivalently", () => {
    const input = snapshots(["10", "11", "12", "13", "14", "15"]);
    const before = [...input];
    const first = classifyMarketRegime(input, CONFIG);
    const second = classifyMarketRegime(input, CONFIG);
    expect(input).toEqual(before);
    expect(first).toEqual(second);
    expect(Object.isFrozen(first)).toBe(true);
    if (first.status === "READY") expect(Object.isFrozen(first.evidence)).toBe(true);
  });

  it("uses only the most recent required closed candles", () => {
    const input = snapshots(["99", "10", "11", "12", "13", "14", "15"], { openAt: { 0: true } });
    expect(ready(input)).toMatchObject({ primaryRegime: "TREND_UP", windowStart: 60_000, windowEnd: 420_000 });
  });
});
