import { describe, expect, it } from "vitest";
import {
  createInstrumentId,
  createInstrumentMetadata,
  decimalString,
  formatTimeframe,
  nonNegativeDecimalString,
  parseInstrumentId,
  parseTimeframe,
  positiveDecimalString,
  timeframeToMilliseconds,
  unixMs,
  venueSymbol,
} from "./index.js";

describe("decimal strings", () => {
  it.each(["0", "0.0", "12", "12.3400", "-0.5"])("accepts canonical plain decimal %s", (value) => {
    expect(decimalString(value)).toBe(value);
  });

  it.each(["", " 1", "1 ", "+1", "01", ".5", "1.", "1e3", "NaN", "Infinity", "1,000", "-0", "-0.00"])(
    "rejects non-canonical decimal %s", (value) => expect(() => decimalString(value)).toThrow(),
  );

  it("enforces positive and non-negative rules without numeric conversion", () => {
    const veryLarge = "90071992547409931234567890.123456789";
    expect(positiveDecimalString(veryLarge)).toBe(veryLarge);
    expect(nonNegativeDecimalString("0.000")).toBe("0.000");
    expect(() => positiveDecimalString("0.000")).toThrow();
    expect(() => nonNegativeDecimalString("-0.1")).toThrow();
  });
});

describe("instrument identity", () => {
  it("round trips a stable, reversible identity while preserving native symbol formatting", () => {
    const id = createInstrumentId({ venue: "Example Venue", venueSymbol: "xAu/usd.r", instrumentKind: "CFD" });
    expect(id).toBe("ulte:v1:Example%20Venue:CFD:xAu%2Fusd.r");
    expect(parseInstrumentId(id)).toEqual({ venue: "Example Venue", venueSymbol: "xAu/usd.r", instrumentKind: "CFD" });
    expect(venueSymbol("xAu/usd.r")).toBe("xAu/usd.r");
  });

  it.each(["", " BTCUSD", "BTCUSD "])("rejects invalid symbol %j", (value) => {
    expect(() => venueSymbol(value)).toThrow();
  });

  it("represents capabilities explicitly and immutably", () => {
    const id = createInstrumentId({ venue: "venue", venueSymbol: "BTC-USDT", instrumentKind: "SPOT" });
    const metadata = createInstrumentMetadata({
      instrumentId: id, venue: "venue", venueSymbol: "BTC-USDT", assetClass: "CRYPTO", instrumentKind: "SPOT",
      baseCurrency: "BTC", quoteCurrency: "USDT", tickSize: "0.01", quantityStep: "0.0001",
      marketDataCapabilities: ["QUOTE", "TRADES", "ORDER_BOOK"],
    });
    expect(metadata.marketDataCapabilities).toEqual(["QUOTE", "TRADES", "ORDER_BOOK"]);
    expect(Object.isFrozen(metadata.marketDataCapabilities)).toBe(true);
  });
});

describe("time primitives", () => {
  it.each([["1s", 1_000], ["3m", 180_000], ["2h", 7_200_000], ["1d", 86_400_000], ["1w", 604_800_000]] as const)(
    "parses and converts %s", (value, expected) => {
      const timeframe = parseTimeframe(value);
      expect(formatTimeframe(timeframe)).toBe(value);
      expect(timeframeToMilliseconds(timeframe)).toBe(expected);
    },
  );

  it.each(["0m", "-1m", "01m", "1M", "1mo", "1.5h", "m", "", "9007199254740992w"])(
    "rejects malformed or unsafe timeframe %j", (value) => expect(() => parseTimeframe(value)).toThrow(),
  );

  it("revalidates branded values before converting a duration", () => {
    expect(() => timeframeToMilliseconds("9007199254740992w" as never)).toThrow();
  });

  it.each([0, 1, Number.MAX_SAFE_INTEGER])("accepts valid UnixMs %s", (value) => expect(unixMs(value)).toBe(value));
  it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid UnixMs %s", (value) => expect(() => unixMs(value)).toThrow(),
  );
});
