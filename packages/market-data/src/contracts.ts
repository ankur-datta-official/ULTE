import {
  decimalString,
  instrumentId,
  nonNegativeDecimalString,
  parseTimeframe,
  positiveDecimalString,
  unixMs,
  type DecimalString,
  type InstrumentId,
  type NonNegativeDecimalString,
  type PositiveDecimalString,
  type TimeframeId,
  type UnixMs,
} from "@ulte/instrument-model";

export interface BestQuote {
  readonly bidPrice: PositiveDecimalString;
  readonly bidQuantity?: NonNegativeDecimalString;
  readonly askPrice: PositiveDecimalString;
  readonly askQuantity?: NonNegativeDecimalString;
}

export function createBestQuote(input: {
  readonly bidPrice: string; readonly bidQuantity?: string; readonly askPrice: string; readonly askQuantity?: string;
}): BestQuote {
  return Object.freeze({
    bidPrice: positiveDecimalString(input.bidPrice),
    ...(input.bidQuantity === undefined ? {} : { bidQuantity: nonNegativeDecimalString(input.bidQuantity) }),
    askPrice: positiveDecimalString(input.askPrice),
    ...(input.askQuantity === undefined ? {} : { askQuantity: nonNegativeDecimalString(input.askQuantity) }),
  });
}

export const TRADE_SIDES = ["BUY", "SELL", "UNKNOWN"] as const;
export type TradeSide = (typeof TRADE_SIDES)[number];

export interface TradeTick {
  readonly price: PositiveDecimalString;
  readonly quantity: PositiveDecimalString;
  readonly side: TradeSide;
}

export function createTradeTick(input: { readonly price: string; readonly quantity: string; readonly side: TradeSide }): TradeTick {
  if (!(TRADE_SIDES as readonly string[]).includes(input.side)) throw new TypeError(`Invalid trade side: ${String(input.side)}`);
  return Object.freeze({ price: positiveDecimalString(input.price), quantity: positiveDecimalString(input.quantity), side: input.side });
}

export interface Candle {
  readonly instrumentId: InstrumentId;
  readonly timeframe: TimeframeId;
  readonly openTime: UnixMs;
  readonly closeTime: UnixMs;
  readonly open: PositiveDecimalString;
  readonly high: PositiveDecimalString;
  readonly low: PositiveDecimalString;
  readonly close: PositiveDecimalString;
  readonly volume: NonNegativeDecimalString;
  readonly quoteVolume?: NonNegativeDecimalString;
  readonly tradeCount?: number;
  readonly isClosed: boolean;
}

export function createCandle(input: {
  readonly instrumentId: string; readonly timeframe: string; readonly openTime: number; readonly closeTime: number;
  readonly open: string; readonly high: string; readonly low: string; readonly close: string; readonly volume: string;
  readonly quoteVolume?: string; readonly tradeCount?: number; readonly isClosed: boolean;
}): Candle {
  const openTime = unixMs(input.openTime);
  const closeTime = unixMs(input.closeTime);
  if (closeTime <= openTime) throw new RangeError("Candle closeTime must be greater than openTime");
  if (input.tradeCount !== undefined && (!Number.isSafeInteger(input.tradeCount) || input.tradeCount < 0)) {
    throw new RangeError("Candle tradeCount must be a non-negative safe integer");
  }
  if (typeof input.isClosed !== "boolean") throw new TypeError("Candle isClosed must be boolean");
  return Object.freeze({
    instrumentId: instrumentId(input.instrumentId), timeframe: parseTimeframe(input.timeframe), openTime, closeTime,
    open: positiveDecimalString(input.open), high: positiveDecimalString(input.high), low: positiveDecimalString(input.low),
    close: positiveDecimalString(input.close), volume: nonNegativeDecimalString(input.volume),
    ...(input.quoteVolume === undefined ? {} : { quoteVolume: nonNegativeDecimalString(input.quoteVolume) }),
    ...(input.tradeCount === undefined ? {} : { tradeCount: input.tradeCount }), isClosed: input.isClosed,
  });
}

export interface OrderBookLevel {
  readonly price: PositiveDecimalString;
  readonly quantity: NonNegativeDecimalString;
}

export function createOrderBookLevel(input: { readonly price: string; readonly quantity: string }): OrderBookLevel {
  return Object.freeze({ price: positiveDecimalString(input.price), quantity: nonNegativeDecimalString(input.quantity) });
}

declare const sequenceIdBrand: unique symbol;
export type SequenceId = string & { readonly [sequenceIdBrand]: "SequenceId" };

export function sequenceId(value: unknown): SequenceId {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) {
    throw new TypeError("SequenceId must be a non-empty string without surrounding whitespace");
  }
  return value as SequenceId;
}

export interface OrderBookSnapshot {
  readonly bids: readonly OrderBookLevel[];
  readonly asks: readonly OrderBookLevel[];
  readonly sequenceId?: SequenceId;
}

export interface OrderBookDelta {
  readonly bids: readonly OrderBookLevel[];
  readonly asks: readonly OrderBookLevel[];
  readonly sequenceId?: SequenceId;
}

type OrderBookInput = {
  readonly bids: readonly { readonly price: string; readonly quantity: string }[];
  readonly asks: readonly { readonly price: string; readonly quantity: string }[];
  readonly sequenceId?: string;
};

function createOrderBook(input: OrderBookInput): OrderBookSnapshot {
  return Object.freeze({
    bids: Object.freeze(input.bids.map(createOrderBookLevel)),
    asks: Object.freeze(input.asks.map(createOrderBookLevel)),
    ...(input.sequenceId === undefined ? {} : { sequenceId: sequenceId(input.sequenceId) }),
  });
}

export const createOrderBookSnapshot = createOrderBook;
export const createOrderBookDelta = createOrderBook;

export interface MarkPrice { readonly price: PositiveDecimalString }
export interface IndexPrice { readonly price: PositiveDecimalString }
export interface FundingRate { readonly rate: DecimalString; readonly nextFundingTime?: UnixMs }

export const createMarkPrice = (input: { readonly price: string }): MarkPrice =>
  Object.freeze({ price: positiveDecimalString(input.price) });
export const createIndexPrice = (input: { readonly price: string }): IndexPrice =>
  Object.freeze({ price: positiveDecimalString(input.price) });
export function createFundingRate(input: { readonly rate: string; readonly nextFundingTime?: number }): FundingRate {
  return Object.freeze({
    rate: decimalString(input.rate),
    ...(input.nextFundingTime === undefined ? {} : { nextFundingTime: unixMs(input.nextFundingTime) }),
  });
}

export const OPEN_INTEREST_UNITS = ["CONTRACTS", "BASE_UNITS", "QUOTE_VALUE"] as const;
export type OpenInterestUnit = (typeof OPEN_INTEREST_UNITS)[number];
export interface OpenInterest { readonly value: NonNegativeDecimalString; readonly unit: OpenInterestUnit }
export function createOpenInterest(input: { readonly value: string; readonly unit: OpenInterestUnit }): OpenInterest {
  if (!(OPEN_INTEREST_UNITS as readonly string[]).includes(input.unit)) throw new TypeError(`Invalid open-interest unit: ${String(input.unit)}`);
  return Object.freeze({ value: nonNegativeDecimalString(input.value), unit: input.unit });
}
