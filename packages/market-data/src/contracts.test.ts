import { describe, expect, it } from "vitest";
import { createInstrumentId } from "@ulte/instrument-model";
import {
  createBestQuote,
  createCandle,
  createFundingRate,
  createMarketDataEvent,
  createOrderBookDelta,
  createOpenInterest,
} from "./index.js";

const instrumentId = createInstrumentId({ venue: "venue-a", venueSymbol: "BTC/USDT", instrumentKind: "SPOT" });

describe("market-data contracts", () => {
  it("validates candle timestamp consistency", () => {
    const base = {
      instrumentId, timeframe: "1m", openTime: 1_000, closeTime: 61_000,
      open: "100", high: "110", low: "90", close: "105", volume: "12.5", isClosed: true,
    } as const;
    expect(createCandle(base).close).toBe("105");
    expect(() => createCandle({ ...base, closeTime: 1_000 })).toThrow(/greater/);
  });

  it("accepts negative funding rates", () => {
    expect(createFundingRate({ rate: "-0.0001" }).rate).toBe("-0.0001");
  });

  it("rejects invalid positive prices", () => {
    expect(() => createBestQuote({ bidPrice: "0", askPrice: "1" })).toThrow();
    expect(() => createBestQuote({ bidPrice: "1", askPrice: "-2" })).toThrow();
  });

  it("keeps unavailable quote quantities absent", () => {
    expect(createBestQuote({ bidPrice: "1", askPrice: "2" })).toEqual({ bidPrice: "1", askPrice: "2" });
  });

  it("preserves sequence identifiers larger than safe integers", () => {
    const value = "900719925474099312345678901234567890";
    expect(createOrderBookDelta({ bids: [], asks: [], sequenceId: value }).sequenceId).toBe(value);
  });

  it.each(["CONTRACTS", "BASE_UNITS", "QUOTE_VALUE"] as const)("labels open interest in %s", (unit) => {
    expect(createOpenInterest({ value: "123.45", unit }).unit).toBe(unit);
  });
});

describe("event envelope", () => {
  it("identifies instrument, source, times, quality, payload, and sequence", () => {
    const event = createMarketDataEvent({
      instrumentId, source: "consolidated-feed", eventTime: 1_000, receivedAt: 1_010,
      payload: { price: "100" }, quality: ["LIVE", "SNAPSHOT"], sequenceId: "42",
    });
    expect(event).toMatchObject({ instrumentId, source: "consolidated-feed", eventTime: 1_000, receivedAt: 1_010, sequenceId: "42" });
    expect(Object.isFrozen(event.quality)).toBe(true);
  });

  it("allows receivedAt before eventTime because source clocks may skew", () => {
    expect(createMarketDataEvent({
      instrumentId, source: "feed", eventTime: 2_000, receivedAt: 1_999, payload: {}, quality: ["LIVE"],
    }).receivedAt).toBe(1_999);
  });
});
