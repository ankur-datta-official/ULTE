import { instrumentId, unixMs, type InstrumentId, type UnixMs } from "@ulte/instrument-model";
import { sequenceId, type SequenceId } from "./contracts.js";

declare const marketDataSourceBrand: unique symbol;
export type MarketDataSource = string & { readonly [marketDataSourceBrand]: "MarketDataSource" };

export function marketDataSource(value: unknown): MarketDataSource {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) {
    throw new TypeError("MarketDataSource must be a non-empty string without surrounding whitespace");
  }
  return value as MarketDataSource;
}

export const DATA_QUALITY_FLAGS = ["LIVE", "DELAYED", "STALE", "GAP_DETECTED", "SNAPSHOT"] as const;
export type DataQualityFlag = (typeof DATA_QUALITY_FLAGS)[number];

export interface MarketDataEvent<T> {
  readonly instrumentId: InstrumentId;
  readonly source: MarketDataSource;
  readonly eventTime: UnixMs;
  readonly receivedAt: UnixMs;
  readonly payload: T;
  readonly quality: readonly DataQualityFlag[];
  readonly sequenceId?: SequenceId;
}

export function createMarketDataEvent<T>(input: {
  readonly instrumentId: string;
  readonly source: string;
  readonly eventTime: number;
  readonly receivedAt: number;
  readonly payload: T;
  readonly quality: readonly DataQualityFlag[];
  readonly sequenceId?: string;
}): MarketDataEvent<T> {
  const quality = [...new Set(input.quality)];
  if (quality.length === 0 || quality.length !== input.quality.length ||
      quality.some((flag) => !(DATA_QUALITY_FLAGS as readonly string[]).includes(flag))) {
    throw new TypeError("Data quality flags must be non-empty, valid, and unique");
  }
  return Object.freeze({
    instrumentId: instrumentId(input.instrumentId), source: marketDataSource(input.source),
    eventTime: unixMs(input.eventTime), receivedAt: unixMs(input.receivedAt), payload: input.payload,
    quality: Object.freeze(quality),
    ...(input.sequenceId === undefined ? {} : { sequenceId: sequenceId(input.sequenceId) }),
  });
}
