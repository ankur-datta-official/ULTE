import { describe, expect, it } from "vitest";
import {
  createInstrumentId,
  parseTimeframe,
  unixMs,
} from "@ulte/instrument-model";
import {
  MultiTimeframeCandleEngine,
  TradeToCandleBuilder,
  createMarketDataEvent,
  createTradeTick,
  marketDataSource,
  type CandleEngineEvent,
} from "./index.js";

const instrument = createInstrumentId({ venue: "test", venueSymbol: "BTC/USD", instrumentKind: "SPOT" });
const otherInstrument = createInstrumentId({ venue: "test", venueSymbol: "ETH/USD", instrumentKind: "SPOT" });
const source = marketDataSource("test-feed");

function trade(
  eventTime: number,
  price = "10",
  quantity = "1",
  overrides: { instrumentId?: string; source?: string; quality?: readonly ("LIVE" | "DELAYED" | "STALE" | "GAP_DETECTED" | "SNAPSHOT")[] } = {},
) {
  return createMarketDataEvent({
    instrumentId: overrides.instrumentId ?? instrument,
    source: overrides.source ?? source,
    eventTime,
    receivedAt: eventTime,
    payload: createTradeTick({ price, quantity, side: "UNKNOWN" }),
    quality: overrides.quality ?? ["DELAYED"],
  });
}

function builder(timeframe = "1m", anchorTime = 0) {
  return new TradeToCandleBuilder({
    instrumentId: instrument,
    source,
    timeframe: parseTimeframe(timeframe),
    anchorTime: unixMs(anchorTime),
  });
}

function eventOfType<T extends CandleEngineEvent["type"]>(
  events: readonly CandleEngineEvent[],
  type: T,
): Extract<CandleEngineEvent, { type: T }> {
  const event = events.find((candidate): candidate is Extract<CandleEngineEvent, { type: T }> => candidate.type === type);
  if (event === undefined) throw new Error(`Missing ${type} event`);
  return event;
}

describe("TradeToCandleBuilder", () => {
  it("opens a candle from the first trade", () => {
    const engine = builder();
    const events = engine.process(trade(1_000, "10.5", "2"));

    expect(events.map((event) => event.type)).toEqual(["TRADE_ACCEPTED", "CANDLE_OPENED"]);
    expect(eventOfType(events, "CANDLE_OPENED").snapshot.candle).toMatchObject({
      openTime: 0, closeTime: 60_000, open: "10.5", high: "10.5", low: "10.5", close: "10.5",
      volume: "2", tradeCount: 1, isClosed: false,
    });
  });

  it("derives OHLC and exact decimal volume sequentially", () => {
    const engine = builder();
    engine.process(trade(1_000, "9.9", "0.1"));
    engine.process(trade(2_000, "10", "0.2"));
    expect(engine.getCurrent()?.candle.volume).toBe("0.3");
    engine.process(trade(3_000, "9.95", "0.30"));

    expect(engine.getCurrent()?.candle).toMatchObject({
      open: "9.9", high: "10", low: "9.9", close: "9.95", volume: "0.6", tradeCount: 3,
    });
  });

  it("puts a boundary trade in the next half-open bucket and closes at the exact boundary", () => {
    const engine = builder();
    engine.process(trade(59_999, "10"));
    const events = engine.process(trade(60_000, "11"));

    expect(eventOfType(events, "CANDLE_CLOSED").snapshot.candle).toMatchObject({
      openTime: 0, closeTime: 60_000, close: "10", isClosed: true,
    });
    expect(eventOfType(events, "CANDLE_OPENED").snapshot.candle).toMatchObject({
      openTime: 60_000, closeTime: 120_000, open: "11", isClosed: false,
    });
  });

  it("reports skipped buckets without synthesizing candles", () => {
    const engine = builder();
    engine.process(trade(1_000));
    const events = engine.process(trade(180_000, "12"));

    expect(events.map((event) => event.type)).toEqual([
      "TRADE_ACCEPTED", "CANDLE_CLOSED", "GAP_DETECTED", "CANDLE_OPENED",
    ]);
    expect(eventOfType(events, "GAP_DETECTED")).toMatchObject({
      previousCloseTime: 60_000, nextOpenTime: 180_000, missingBucketCount: 2,
    });
    expect(eventOfType(events, "CANDLE_OPENED").snapshot.quality).toEqual(["DELAYED", "GAP_DETECTED"]);
  });

  it("rejects out-of-order trades without mutating state or finalized candles", () => {
    const engine = builder();
    engine.process(trade(1_000, "10"));
    const transition = engine.process(trade(60_000, "11"));
    const finalized = eventOfType(transition, "CANDLE_CLOSED").snapshot;
    const before = engine.getCurrent();
    const rejection = engine.process(trade(30_000, "100", "100"));

    expect(rejection).toEqual([expect.objectContaining({
      type: "OUT_OF_ORDER_REJECTED", eventTime: 30_000, latestAcceptedEventTime: 60_000,
    })]);
    expect(engine.getCurrent()).toEqual(before);
    expect(finalized.candle).toMatchObject({ high: "10", close: "10", volume: "1", isClosed: true });
  });

  it("accepts equal timestamps deterministically in input order", () => {
    const engine = builder();
    engine.process(trade(1_000, "10", "1"));
    engine.process(trade(1_000, "9", "2"));

    expect(engine.getCurrent()?.candle).toMatchObject({
      open: "10", high: "10", low: "9", close: "9", volume: "3", tradeCount: 2,
    });
  });

  it("uses a custom anchor deterministically", () => {
    const engine = builder("1m", 10_000);
    engine.process(trade(69_999));
    expect(engine.getCurrent()?.candle).toMatchObject({ openTime: 10_000, closeTime: 70_000 });
    engine.process(trade(70_000));
    expect(engine.getCurrent()?.candle).toMatchObject({ openTime: 70_000, closeTime: 130_000 });
  });

  it("rejects wrong instrument and source without mutation", () => {
    const engine = builder();
    expect(engine.process(trade(1_000, "10", "1", { instrumentId: otherInstrument }))[0]).toMatchObject({
      type: "IDENTITY_MISMATCH_REJECTED", field: "instrumentId",
    });
    expect(engine.process(trade(1_000, "10", "1", { source: "other-feed" }))[0]).toMatchObject({
      type: "IDENTITY_MISMATCH_REJECTED", field: "source",
    });
    expect(engine.getCurrent()).toBeUndefined();
  });

  it("returns frozen state copies that cannot mutate internal state", () => {
    const engine = builder();
    engine.process(trade(1_000));
    const returned = engine.getCurrent()!;

    expect(Object.isFrozen(returned)).toBe(true);
    expect(Object.isFrozen(returned.candle)).toBe(true);
    expect(Object.isFrozen(returned.quality)).toBe(true);
    expect(() => { (returned.candle as { close: string }).close = "999"; }).toThrow();
    expect(engine.getCurrent()?.candle.close).toBe("10");
  });

  it("keeps large safe UnixMs bucket arithmetic exact", () => {
    const time = Number.MAX_SAFE_INTEGER - 1_000_000;
    const engine = builder("1s", 123);
    engine.process(trade(time));
    const candle = engine.getCurrent()!.candle;

    expect(Number.isSafeInteger(candle.openTime)).toBe(true);
    expect(candle.openTime % 1_000).toBe(123);
    expect(candle.closeTime - candle.openTime).toBe(1_000);
  });

  it("never emits exponent notation for large exact sums", () => {
    const engine = builder();
    engine.process(trade(1_000, "10", "999999999999999999999999999999.9"));
    engine.process(trade(2_000, "10", "0.1"));
    const volume = engine.getCurrent()!.candle.volume;

    expect(volume).toBe("1000000000000000000000000000000");
    expect(volume).not.toMatch(/[eE]/);
  });
});

describe("MultiTimeframeCandleEngine", () => {
  function multi() {
    return new MultiTimeframeCandleEngine({
      instrumentId: instrument,
      source,
      alignments: [
        { timeframe: parseTimeframe("1m"), anchorTime: unixMs(0) },
        { timeframe: parseTimeframe("5m"), anchorTime: unixMs(0) },
      ],
    });
  }

  it("updates multiple timeframes from the same trade in configuration order", () => {
    const engine = multi();
    const events = engine.process(trade(1_000));

    expect(events.filter((event) => event.type === "CANDLE_OPENED").map((event) => event.timeframe)).toEqual(["1m", "5m"]);
    expect([...engine.getCurrentCandles().keys()]).toEqual(["1m", "5m"]);
  });

  it("aggregates 1m and 5m boundaries independently", () => {
    const engine = multi();
    engine.process(trade(59_999, "10"));
    const minuteBoundary = engine.process(trade(60_000, "11"));
    expect(minuteBoundary.filter((event) => event.type === "CANDLE_CLOSED").map((event) => event.timeframe)).toEqual(["1m"]);

    const fiveMinuteBoundary = engine.process(trade(300_000, "12"));
    expect(fiveMinuteBoundary.filter((event) => event.type === "CANDLE_CLOSED").map((event) => event.timeframe)).toEqual(["1m", "5m"]);
  });

  it("rejects duplicate timeframe configurations", () => {
    expect(() => new MultiTimeframeCandleEngine({
      instrumentId: instrument,
      source,
      alignments: [
        { timeframe: parseTimeframe("1m"), anchorTime: unixMs(0) },
        { timeframe: parseTimeframe("1m"), anchorTime: unixMs(10_000) },
      ],
    })).toThrow(/Duplicate/);
  });

  it("rejects an out-of-order event across every timeframe without partial mutation", () => {
    const engine = multi();
    engine.process(trade(60_000, "10"));
    const before = [...engine.getCurrentCandles()].map(([key, snapshot]) => [key, snapshot.candle] as const);
    const events = engine.process(trade(1_000, "99"));

    expect(events.map((event) => event.type)).toEqual(["OUT_OF_ORDER_REJECTED", "OUT_OF_ORDER_REJECTED"]);
    expect([...engine.getCurrentCandles()].map(([key, snapshot]) => [key, snapshot.candle])).toEqual(before);
  });

  it("does not expose its internal state through the returned map", () => {
    const engine = multi();
    engine.process(trade(1_000));
    const returned = engine.getCurrentCandles();
    (returned as Map<string, unknown>).clear();

    expect([...engine.getCurrentCandles().keys()]).toEqual(["1m", "5m"]);
  });
});
