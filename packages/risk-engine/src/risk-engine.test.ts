import { describe, expect, it } from "vitest";
import { createInstrumentId, parseTimeframe, unixMs } from "@ulte/instrument-model";
import { createCandle, type CandleSnapshot, type DataQualityFlag } from "@ulte/market-data";
import type { EventEvidence, RetestEvidence, SetupCandidate, SetupDirection, SetupFamily } from "@ulte/setup-engine";
import type { LiquidityLevel, ReadyStructureResult, StructureEvent, StructureEventType } from "@ulte/structure-engine";
import {
  ULTE_MINIMUM_NET_RR_BPS, createRiskCostAssumptions, createRiskQualificationConfig,
  qualifyStructuralRisk, type RiskCostAssumptions, type RiskQualificationInput,
} from "./index.js";

const instrument = createInstrumentId({ venue: "TEST", venueSymbol: "ABC", instrumentKind: "SPOT" });
const otherInstrument = createInstrumentId({ venue: "TEST", venueSymbol: "XYZ", instrumentKind: "SPOT" });
const timeframe = parseTimeframe("4h");
const otherTimeframe = parseTimeframe("1h");
const zeroCosts = createRiskCostAssumptions({ entryCostBps: 0, targetExitCostBps: 0, stopExitCostBps: 0 });
const minimum = createRiskQualificationConfig({ minimumNetRewardRiskBps: 30_000 });

function event(type: StructureEventType, openTime: number, closeTime: number, id: string): StructureEvent {
  return Object.freeze({
    type, instrumentId: instrument, timeframe, detectedAt: unixMs(closeTime), eventCandleOpenTime: unixMs(openTime),
    referenceSwingId: id, referenceSwingTime: unixMs(1), referencePrice: "10" as StructureEvent["referencePrice"],
    liquiditySide: type.includes("ABOVE") ? "BUY_SIDE" : "SELL_SIDE",
  });
}

function eventEvidence(value: StructureEvent): EventEvidence {
  return Object.freeze({
    event: value,
    referenceLevel: level(value.referenceSwingId, value.referencePrice, value.liquiditySide, "BROKEN"),
  });
}

function level(
  id: string, price: string, side: LiquidityLevel["side"], status: LiquidityLevel["status"] = "ACTIVE", confirmedAt = 5,
): LiquidityLevel {
  return Object.freeze({
    side, price: price as LiquidityLevel["price"], sourceSwingId: id,
    sourcePivotOpenTime: unixMs(1), confirmedAt: unixMs(confirmedAt), status,
  });
}

function candle(
  openTime: number, closeTime: number, low: string, high: string, close: string,
  options: {
    readonly instrumentId?: string; readonly timeframe?: string; readonly isClosed?: boolean;
    readonly quality?: readonly DataQualityFlag[];
  } = {},
): CandleSnapshot {
  return Object.freeze({
    candle: createCandle({
      instrumentId: options.instrumentId ?? instrument, timeframe: options.timeframe ?? timeframe,
      openTime, closeTime, open: close, high, low, close, volume: "1", isClosed: options.isClosed ?? true,
    }),
    quality: Object.freeze([...(options.quality ?? ["LIVE"])]),
  });
}

function fixture(options: {
  readonly family?: SetupFamily; readonly direction?: SetupDirection; readonly stage?: SetupCandidate["stage"];
  readonly invalidation?: string; readonly entry?: string; readonly targets?: readonly LiquidityLevel[];
  readonly confirmedAt?: number | undefined; readonly asOf?: number; readonly costs?: RiskCostAssumptions;
} = {}): RiskQualificationInput {
  const family = options.family ?? "TREND_PULLBACK_CONTINUATION";
  const direction = options.direction ?? "UP";
  const asOf = options.asOf ?? 100;
  const invalidation = options.invalidation ?? (direction === "UP" ? "9" : "11");
  const entry = options.entry ?? (direction === "UP" ? "11" : "9");
  const initiationEvent = event(
    direction === "UP" ? "SWEEP_BELOW_RECLAIM" : "SWEEP_ABOVE_RECLAIM", 10, 20, "INIT",
  );
  const confirmationEvent = event(
    direction === "UP" ? "CLOSE_BREAK_ABOVE" : "CLOSE_BREAK_BELOW", 30, 40, "CONFIRM",
  );
  const retest = Object.freeze({
    candleOpenTime: unixMs(30), candleCloseTime: unixMs(40),
    referencePrice: "10" as RetestEvidence["referencePrice"],
  });
  const confirmation = family === "BREAKOUT_RETEST" ? retest : eventEvidence(confirmationEvent);
  const candidate: SetupCandidate = Object.freeze({
    id: `${family}:${direction}:20:INIT`, family, direction, stage: options.stage ?? "CONFIRMED",
    instrumentId: instrument, contextTimeframe: parseTimeframe("1d"), setupTimeframe: timeframe,
    asOf: unixMs(asOf), initiatedAt: unixMs(20),
    ...(options.confirmedAt === undefined && "confirmedAt" in options ? {} : { confirmedAt: unixMs(options.confirmedAt ?? 40) }),
    evidence: Object.freeze({ initiation: eventEvidence(initiationEvent), confirmation }),
  });
  const setupCandles = Object.freeze([
    candle(10, 20, direction === "UP" ? invalidation : "8", direction === "DOWN" ? invalidation : "12", "10"),
    candle(30, 40, direction === "UP" && family === "BREAKOUT_RETEST" ? invalidation : "8",
      direction === "DOWN" && family === "BREAKOUT_RETEST" ? invalidation : "12", entry),
  ]);
  const defaultTarget = direction === "UP"
    ? level("TARGET", "17", "BUY_SIDE")
    : level("TARGET", "3", "SELL_SIDE");
  const structure: ReadyStructureResult = Object.freeze({
    status: "READY", instrumentId: instrument, timeframe, windowStart: unixMs(0), windowEnd: unixMs(90),
    structureState: "UNDETERMINED", confirmedSwings: Object.freeze([]),
    liquidityLevels: Object.freeze([...(options.targets ?? [defaultTarget])]),
    structureEvents: Object.freeze([initiationEvent, confirmationEvent]),
  });
  return Object.freeze({ candidate, structure, setupCandles, costs: options.costs ?? zeroCosts, config: minimum });
}

function run(input: RiskQualificationInput = fixture()) {
  return qualifyStructuralRisk(input);
}

describe("configuration and input consistency", () => {
  it("enforces and freezes the fixed 3R product floor and explicit non-negative costs", () => {
    expect(ULTE_MINIMUM_NET_RR_BPS).toBe(30_000);
    expect(() => createRiskQualificationConfig({ minimumNetRewardRiskBps: 29_999 })).toThrow();
    expect(() => createRiskQualificationConfig({ minimumNetRewardRiskBps: 30_000.5 })).toThrow();
    expect(() => createRiskCostAssumptions({ entryCostBps: -1, targetExitCostBps: 0, stopExitCostBps: 0 })).toThrow();
    expect(Object.isFrozen(minimum)).toBe(true);
    expect(Object.isFrozen(zeroCosts)).toBe(true);
  });

  it("does not fabricate an entry for an armed setup", () => {
    const result = run(fixture({ stage: "ARMED" }));
    expect(result).toEqual(expect.objectContaining({ status: "NOT_QUALIFIED", reason: "SETUP_NOT_CONFIRMED" }));
    expect("entryReferencePrice" in result).toBe(false);
  });

  it("rejects missing, future, or backdated confirmation time", () => {
    expect(run(fixture({ confirmedAt: undefined }))).toEqual(expect.objectContaining({ status: "DATA_REJECTED", reason: "INVALID_CONFIRMED_AT" }));
    expect(run(fixture({ confirmedAt: 101 }))).toEqual(expect.objectContaining({ status: "DATA_REJECTED", reason: "INVALID_CONFIRMED_AT" }));
    expect(run(fixture({ confirmedAt: 39 }))).toEqual(expect.objectContaining({ status: "DATA_REJECTED", reason: "INVALID_CONFIRMED_AT" }));
  });

  it("rejects candidate/structure identity mismatches and a future structure window", () => {
    const base = fixture();
    expect(run({ ...base, structure: { ...base.structure, instrumentId: otherInstrument } })).toEqual(
      expect.objectContaining({ status: "DATA_REJECTED", reason: "INSTRUMENT_MISMATCH" }),
    );
    expect(run({ ...base, structure: { ...base.structure, timeframe: otherTimeframe } })).toEqual(
      expect.objectContaining({ status: "DATA_REJECTED", reason: "SETUP_TIMEFRAME_MISMATCH" }),
    );
    expect(run({ ...base, structure: { ...base.structure, windowEnd: unixMs(101) } })).toEqual(
      expect.objectContaining({ status: "DATA_REJECTED", reason: "FUTURE_STRUCTURE_WINDOW" }),
    );
  });

  it.each([
    ["INSTRUMENT_MISMATCH", (base: RiskQualificationInput) => [candle(10, 20, "9", "12", "10", { instrumentId: otherInstrument }), base.setupCandles[1]!]],
    ["SETUP_TIMEFRAME_MISMATCH", (base: RiskQualificationInput) => [candle(10, 20, "9", "12", "10", { timeframe: otherTimeframe }), base.setupCandles[1]!]],
    ["OPEN_SETUP_CANDLE", (base: RiskQualificationInput) => [candle(10, 20, "9", "12", "10", { isClosed: false }), base.setupCandles[1]!]],
    ["FUTURE_SETUP_CANDLE", () => [candle(101, 102, "9", "12", "10")]],
    ["DATA_GAP", (base: RiskQualificationInput) => [candle(10, 20, "9", "12", "10", { quality: ["LIVE", "GAP_DETECTED"] }), base.setupCandles[1]!]],
    ["DUPLICATE_SETUP_CANDLE", (base: RiskQualificationInput) => [base.setupCandles[0]!, base.setupCandles[0]!]],
    ["OUT_OF_ORDER_SETUP_CANDLES", (base: RiskQualificationInput) => [base.setupCandles[1]!, base.setupCandles[0]!]],
  ] as const)("rejects %s setup candle data", (reason, change) => {
    const base = fixture();
    expect(run({ ...base, setupCandles: change(base) })).toEqual(
      expect.objectContaining({ status: "DATA_REJECTED", reason }),
    );
  });
});

describe("entry and family-specific structural invalidation", () => {
  it.each([
    ["TREND_PULLBACK_CONTINUATION", "UP", "9"],
    ["TREND_PULLBACK_CONTINUATION", "DOWN", "11"],
    ["LIQUIDITY_SWEEP_REVERSAL", "UP", "9"],
    ["LIQUIDITY_SWEEP_REVERSAL", "DOWN", "11"],
    ["BREAKOUT_RETEST", "UP", "9"],
    ["BREAKOUT_RETEST", "DOWN", "11"],
  ] as const)("uses structural invalidation for %s %s", (family, direction, expected) => {
    expect(run(fixture({ family, direction }))).toEqual(expect.objectContaining({
      status: "QUALIFIED", entryReferencePrice: direction === "UP" ? "11" : "9", invalidationPrice: expected,
    }));
  });

  it("requires exact confirmation and initiation candles without substitution", () => {
    const base = fixture();
    expect(run({ ...base, setupCandles: [base.setupCandles[0]!] })).toEqual(
      expect.objectContaining({ status: "NOT_QUALIFIED", reason: "CONFIRMATION_CANDLE_NOT_FOUND" }),
    );
    expect(run({ ...base, setupCandles: [base.setupCandles[1]!] })).toEqual(
      expect.objectContaining({ status: "NOT_QUALIFIED", reason: "INITIATION_CANDLE_NOT_FOUND" }),
    );
  });

  it.each([
    ["UP", "11"], ["UP", "12"], ["DOWN", "9"], ["DOWN", "8"],
  ] as const)("rejects %s invalidation on the wrong side or equal", (direction, invalidation) => {
    expect(run(fixture({ direction, invalidation }))).toEqual(
      expect.objectContaining({ status: "NOT_QUALIFIED", reason: "INVALID_STRUCTURAL_INVALIDATION" }),
    );
  });
});

describe("structural target path", () => {
  it("filters by status, side, direction, price, and as-of then orders nearest first", () => {
    const targets = [
      level("far", "20", "BUY_SIDE"), level("swept", "12", "BUY_SIDE", "SWEPT"),
      level("broken", "13", "BUY_SIDE", "BROKEN"), level("wrong-side", "14", "SELL_SIDE"),
      level("behind", "10", "BUY_SIDE"), level("future", "12", "BUY_SIDE", "ACTIVE", 101),
      level("near", "17", "BUY_SIDE"),
    ];
    const result = run(fixture({ targets }));
    expect(result).toEqual(expect.objectContaining({ primaryTargetPrice: "17" }));
    if ("targetPath" in result && result.targetPath !== undefined) {
      expect(result.targetPath.map((item) => item.sourceSwingId)).toEqual(["near", "far"]);
    }
  });

  it("orders down targets descending and preserves source order at equal prices", () => {
    const targets = [level("far", "1", "SELL_SIDE"), level("equal-a", "3", "SELL_SIDE"), level("equal-b", "3", "SELL_SIDE")];
    const result = run(fixture({ direction: "DOWN", targets }));
    expect(result).toEqual(expect.objectContaining({ primaryTargetPrice: "3" }));
    if ("targetPath" in result && result.targetPath !== undefined) {
      expect(result.targetPath.map((item) => item.sourceSwingId)).toEqual(["equal-a", "equal-b", "far"]);
    }
  });

  it("returns no target instead of fabricating one", () => {
    expect(run(fixture({ targets: [level("behind", "10", "BUY_SIDE")] }))).toEqual(
      expect.objectContaining({ status: "NOT_QUALIFIED", reason: "NO_STRUCTURAL_TARGET" }),
    );
  });

  it("cannot skip a nearer sub-3R obstacle for a farther qualifying target", () => {
    const result = run(fixture({ targets: [level("far-4r", "19", "BUY_SIDE"), level("near-2r", "15", "BUY_SIDE")] }));
    expect(result).toEqual(expect.objectContaining({
      status: "NOT_QUALIFIED", reason: "NET_RR_BELOW_MINIMUM", primaryTargetPrice: "15", netRewardRiskBps: "20000",
    }));
  });
});

describe("exact net reward-to-risk and costs", () => {
  it("qualifies exactly 3.0000R and rejects microscopically below without rounding", () => {
    expect(run(fixture())).toEqual(expect.objectContaining({ status: "QUALIFIED", netRewardRiskBps: "30000" }));
    expect(run(fixture({ targets: [level("target", "16.9998", "BUY_SIDE")] }))).toEqual(expect.objectContaining({
      status: "NOT_QUALIFIED", reason: "NET_RR_BELOW_MINIMUM", netRewardRiskBps: "29999",
    }));
  });

  it("supports a stricter caller threshold", () => {
    const base = fixture({ targets: [level("target", "19", "BUY_SIDE")] });
    expect(run({ ...base, config: createRiskQualificationConfig({ minimumNetRewardRiskBps: 40_001 }) })).toEqual(
      expect.objectContaining({ status: "NOT_QUALIFIED", reason: "NET_RR_BELOW_MINIMUM", netRewardRiskBps: "40000" }),
    );
  });

  it("calculates zero costs and each explicit cost leg exactly", () => {
    const result = run(fixture({
      entry: "100", invalidation: "90", targets: [level("target", "130", "BUY_SIDE")],
      costs: { entryCostBps: 10, targetExitCostBps: 20, stopExitCostBps: 30 },
    }));
    expect(result).toEqual(expect.objectContaining({
      grossRisk: "10", grossReward: "30", entryCost: "0.1", targetExitCost: "0.26",
      stopExitCost: "0.27", netRisk: "10.37", netReward: "29.64",
    }));
    expect(run(fixture())).toEqual(expect.objectContaining({ entryCost: "0", targetExitCost: "0", stopExitCost: "0" }));
  });

  it("rejects gross 3R when configured costs reduce net R:R below 3R", () => {
    const result = run(fixture({
      entry: "100", invalidation: "90", targets: [level("target", "130", "BUY_SIDE")],
      costs: { entryCostBps: 10, targetExitCostBps: 10, stopExitCostBps: 0 },
    }));
    expect(result).toEqual(expect.objectContaining({
      status: "NOT_QUALIFIED", reason: "NET_RR_BELOW_MINIMUM", grossRisk: "10", grossReward: "30",
    }));
  });

  it("reports when costs consume all reward", () => {
    expect(run(fixture({ costs: { entryCostBps: 60_000, targetExitCostBps: 0, stopExitCostBps: 0 } }))).toEqual(
      expect.objectContaining({ status: "NOT_QUALIFIED", reason: "COSTS_CONSUME_REWARD" }),
    );
  });

  it.each([
    ["0.1", "0.2", "0.5"],
    ["0.00000001", "0.00000002", "0.00000005"],
    ["999999999999999999.9", "1000000000000000000", "1000000000000000000.3"],
  ] as const)("handles exact invalidation %s entry %s target %s without exponent notation", (invalidation, entry, target) => {
    const result = run(fixture({ invalidation, entry, targets: [level("target", target, "BUY_SIDE")] }));
    expect(result).toEqual(expect.objectContaining({ status: "QUALIFIED", netRewardRiskBps: "30000" }));
    if ("netRisk" in result) expect(`${result.netRisk}${result.netReward}`).not.toMatch(/[eE]/);
  });
});

describe("no-lookahead, immutability, and determinism", () => {
  it("gives future liquidity zero influence and is deeply equivalent when it is removed", () => {
    const known = level("known", "17", "BUY_SIDE");
    const future = level("future-near", "12", "BUY_SIDE", "ACTIVE", 101);
    expect(run(fixture({ targets: [future, known] }))).toEqual(run(fixture({ targets: [known] })));
  });

  it("rejects rather than filters a future candle", () => {
    const base = fixture();
    const withFuture = { ...base, setupCandles: [...base.setupCandles, candle(101, 102, "10", "12", "11")] };
    expect(run(withFuture)).toEqual(expect.objectContaining({ status: "DATA_REJECTED", reason: "FUTURE_SETUP_CANDLE" }));
  });

  it("does not mutate inputs, deeply freezes output, and repeats identically", () => {
    const input = fixture({ targets: [level("near", "17", "BUY_SIDE"), level("far", "19", "BUY_SIDE")] });
    const candlesBefore = [...input.setupCandles];
    const levelsBefore = [...input.structure.liquidityLevels];
    const first = run(input);
    const second = run(input);
    expect(first).toEqual(second);
    expect(input.setupCandles).toEqual(candlesBefore);
    expect(input.structure.liquidityLevels).toEqual(levelsBefore);
    expect(Object.isFrozen(first)).toBe(true);
    if ("targetPath" in first && first.targetPath !== undefined) {
      expect(Object.isFrozen(first.targetPath)).toBe(true);
      expect(first.targetPath.every(Object.isFrozen)).toBe(true);
    }
  });
});
