import {
  instrumentId,
  nonNegativeDecimalString,
  parseTimeframe,
  positiveDecimalString,
  timeframeToMilliseconds,
  unixMs,
  type InstrumentId,
  type NonNegativeDecimalString,
  type PositiveDecimalString,
  type TimeframeId,
  type UnixMs,
} from "@ulte/instrument-model";
import { createCandle, type Candle, type TradeTick } from "./contracts.js";
import {
  DATA_QUALITY_FLAGS,
  marketDataSource,
  type DataQualityFlag,
  type MarketDataEvent,
  type MarketDataSource,
} from "./event.js";
import { addNonNegativeDecimals, compareDecimals } from "./internal/decimal-arithmetic.js";

export interface CandleAlignment {
  readonly timeframe: TimeframeId;
  readonly anchorTime: UnixMs;
}

export interface CandleBuilderConfig extends CandleAlignment {
  readonly instrumentId: InstrumentId;
  readonly source: MarketDataSource;
}

export interface CandleSnapshot {
  readonly candle: Candle;
  readonly quality: readonly DataQualityFlag[];
}

interface TimeframeEventBase { readonly timeframe: TimeframeId }
export type CandleEngineEvent =
  | (TimeframeEventBase & { readonly type: "TRADE_ACCEPTED"; readonly eventTime: UnixMs })
  | (TimeframeEventBase & { readonly type: "CANDLE_OPENED"; readonly snapshot: CandleSnapshot })
  | (TimeframeEventBase & { readonly type: "CANDLE_UPDATED"; readonly snapshot: CandleSnapshot })
  | (TimeframeEventBase & { readonly type: "CANDLE_CLOSED"; readonly snapshot: CandleSnapshot })
  | (TimeframeEventBase & {
      readonly type: "GAP_DETECTED";
      readonly previousCloseTime: UnixMs;
      readonly nextOpenTime: UnixMs;
      readonly missingBucketCount: number;
    })
  | (TimeframeEventBase & {
      readonly type: "OUT_OF_ORDER_REJECTED";
      readonly eventTime: UnixMs;
      readonly latestAcceptedEventTime: UnixMs;
    })
  | (TimeframeEventBase & {
      readonly type: "IDENTITY_MISMATCH_REJECTED";
      readonly field: "instrumentId" | "source";
      readonly expected: string;
      readonly actual: string;
    });

interface Accumulator {
  readonly openTime: UnixMs;
  readonly closeTime: UnixMs;
  readonly open: PositiveDecimalString;
  high: PositiveDecimalString;
  low: PositiveDecimalString;
  close: PositiveDecimalString;
  volume: NonNegativeDecimalString;
  tradeCount: number;
  quality: DataQualityFlag[];
}

function floorDivision(dividend: bigint, divisor: bigint): bigint {
  const quotient = dividend / divisor;
  return dividend < 0n && dividend % divisor !== 0n ? quotient - 1n : quotient;
}

export function candleBucket(
  eventTime: UnixMs,
  alignment: CandleAlignment,
): Readonly<{ openTime: UnixMs; closeTime: UnixMs }> {
  const duration = BigInt(timeframeToMilliseconds(alignment.timeframe));
  const anchor = BigInt(alignment.anchorTime);
  const open = floorDivision(BigInt(eventTime) - anchor, duration) * duration + anchor;
  const close = open + duration;
  if (open < 0n || close > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError("Aligned candle boundary is outside the supported UnixMs range");
  }
  return Object.freeze({ openTime: unixMs(Number(open)), closeTime: unixMs(Number(close)) });
}

function validateQuality(quality: readonly DataQualityFlag[]): void {
  if (quality.length === 0 || new Set(quality).size !== quality.length ||
      quality.some((flag) => !(DATA_QUALITY_FLAGS as readonly string[]).includes(flag))) {
    throw new TypeError("Trade event quality flags must be non-empty, valid, and unique");
  }
}

function validateTradeEvent(event: MarketDataEvent<TradeTick>): void {
  instrumentId(event.instrumentId);
  marketDataSource(event.source);
  unixMs(event.eventTime);
  unixMs(event.receivedAt);
  positiveDecimalString(event.payload.price);
  positiveDecimalString(event.payload.quantity);
  validateQuality(event.quality);
}

function appendQuality(target: DataQualityFlag[], incoming: readonly DataQualityFlag[]): void {
  for (const flag of incoming) if (!target.includes(flag)) target.push(flag);
}

function frozenEvent<T extends CandleEngineEvent>(event: T): T {
  return Object.freeze(event);
}

export class TradeToCandleBuilder {
  readonly config: Readonly<CandleBuilderConfig>;
  private current: Accumulator | undefined;
  private latestEventTime: UnixMs | undefined;

  constructor(config: CandleBuilderConfig) {
    this.config = Object.freeze({
      instrumentId: instrumentId(config.instrumentId),
      source: marketDataSource(config.source),
      timeframe: parseTimeframe(config.timeframe),
      anchorTime: unixMs(config.anchorTime),
    });
  }

  process(event: MarketDataEvent<TradeTick>): readonly CandleEngineEvent[] {
    validateTradeEvent(event);
    const mismatch = this.identityMismatch(event);
    if (mismatch !== undefined) return Object.freeze([mismatch]);
    if (this.latestEventTime !== undefined && event.eventTime < this.latestEventTime) {
      return Object.freeze([frozenEvent({
        type: "OUT_OF_ORDER_REJECTED", timeframe: this.config.timeframe,
        eventTime: event.eventTime, latestAcceptedEventTime: this.latestEventTime,
      })]);
    }

    const bucket = candleBucket(event.eventTime, this.config);
    const accepted = frozenEvent({
      type: "TRADE_ACCEPTED" as const, timeframe: this.config.timeframe, eventTime: event.eventTime,
    });

    if (this.current === undefined) {
      this.current = this.openAccumulator(event, bucket);
      this.latestEventTime = event.eventTime;
      return Object.freeze([accepted, this.candleEvent("CANDLE_OPENED", this.current, false)]);
    }

    if (bucket.openTime === this.current.openTime) {
      this.updateAccumulator(this.current, event);
      this.latestEventTime = event.eventTime;
      return Object.freeze([accepted, this.candleEvent("CANDLE_UPDATED", this.current, false)]);
    }

    const previous = this.current;
    const closed = this.candleEvent("CANDLE_CLOSED", previous, true);
    const events: CandleEngineEvent[] = [accepted, closed];
    const skipped = (BigInt(bucket.openTime) - BigInt(previous.closeTime)) /
      BigInt(timeframeToMilliseconds(this.config.timeframe));
    const quality = [...event.quality];
    if (skipped > 0n) {
      const missingBucketCount = Number(skipped);
      events.push(frozenEvent({
        type: "GAP_DETECTED", timeframe: this.config.timeframe,
        previousCloseTime: previous.closeTime, nextOpenTime: bucket.openTime, missingBucketCount,
      }));
      if (!quality.includes("GAP_DETECTED")) quality.push("GAP_DETECTED");
    }
    this.current = this.openAccumulator(event, bucket, quality);
    this.latestEventTime = event.eventTime;
    events.push(this.candleEvent("CANDLE_OPENED", this.current, false));
    return Object.freeze(events);
  }

  getCurrent(): CandleSnapshot | undefined {
    return this.current === undefined ? undefined : this.snapshot(this.current, false);
  }

  private identityMismatch(event: MarketDataEvent<TradeTick>): CandleEngineEvent | undefined {
    if (event.instrumentId !== this.config.instrumentId) {
      return frozenEvent({
        type: "IDENTITY_MISMATCH_REJECTED", timeframe: this.config.timeframe, field: "instrumentId",
        expected: this.config.instrumentId, actual: event.instrumentId,
      });
    }
    if (event.source !== this.config.source) {
      return frozenEvent({
        type: "IDENTITY_MISMATCH_REJECTED", timeframe: this.config.timeframe, field: "source",
        expected: this.config.source, actual: event.source,
      });
    }
    return undefined;
  }

  private openAccumulator(
    event: MarketDataEvent<TradeTick>,
    bucket: Readonly<{ openTime: UnixMs; closeTime: UnixMs }>,
    quality: readonly DataQualityFlag[] = event.quality,
  ): Accumulator {
    return {
      ...bucket, open: event.payload.price, high: event.payload.price, low: event.payload.price,
      close: event.payload.price, volume: nonNegativeDecimalString(event.payload.quantity), tradeCount: 1,
      quality: [...quality],
    };
  }

  private updateAccumulator(accumulator: Accumulator, event: MarketDataEvent<TradeTick>): void {
    if (compareDecimals(event.payload.price, accumulator.high) > 0) accumulator.high = event.payload.price;
    if (compareDecimals(event.payload.price, accumulator.low) < 0) accumulator.low = event.payload.price;
    accumulator.close = event.payload.price;
    accumulator.volume = addNonNegativeDecimals(accumulator.volume, event.payload.quantity);
    if (accumulator.tradeCount === Number.MAX_SAFE_INTEGER) throw new RangeError("Candle tradeCount exceeds safe integer range");
    accumulator.tradeCount += 1;
    appendQuality(accumulator.quality, event.quality);
  }

  private snapshot(accumulator: Accumulator, isClosed: boolean): CandleSnapshot {
    const candle = createCandle({
      instrumentId: this.config.instrumentId, timeframe: this.config.timeframe,
      openTime: accumulator.openTime, closeTime: accumulator.closeTime,
      open: accumulator.open, high: accumulator.high, low: accumulator.low, close: accumulator.close,
      volume: accumulator.volume, tradeCount: accumulator.tradeCount, isClosed,
    });
    return Object.freeze({ candle, quality: Object.freeze([...accumulator.quality]) });
  }

  private candleEvent(
    type: "CANDLE_OPENED" | "CANDLE_UPDATED" | "CANDLE_CLOSED",
    accumulator: Accumulator,
    isClosed: boolean,
  ): CandleEngineEvent {
    return frozenEvent({ type, timeframe: this.config.timeframe, snapshot: this.snapshot(accumulator, isClosed) });
  }
}
