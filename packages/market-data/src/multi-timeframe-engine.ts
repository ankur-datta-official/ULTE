import { parseTimeframe, type InstrumentId, type TimeframeId, type UnixMs } from "@ulte/instrument-model";
import type { TradeTick } from "./contracts.js";
import {
  TradeToCandleBuilder,
  candleBucket,
  type CandleAlignment,
  type CandleEngineEvent,
  type CandleSnapshot,
} from "./candle-engine.js";
import type { MarketDataEvent, MarketDataSource } from "./event.js";

export interface MultiTimeframeCandleEngineConfig {
  readonly instrumentId: InstrumentId;
  readonly source: MarketDataSource;
  readonly alignments: readonly CandleAlignment[];
}

export class MultiTimeframeCandleEngine {
  private readonly builders: readonly TradeToCandleBuilder[];
  private readonly instrumentId: InstrumentId;
  private readonly source: MarketDataSource;
  private latestEventTime: UnixMs | undefined;

  constructor(config: MultiTimeframeCandleEngineConfig) {
    if (config.alignments.length === 0) throw new RangeError("At least one timeframe alignment is required");
    const keys = config.alignments.map((item) => parseTimeframe(item.timeframe));
    if (new Set(keys).size !== keys.length) throw new TypeError("Duplicate timeframe configuration");
    this.builders = Object.freeze(config.alignments.map((alignment) => new TradeToCandleBuilder({
      instrumentId: config.instrumentId, source: config.source,
      timeframe: alignment.timeframe, anchorTime: alignment.anchorTime,
    })));
    this.instrumentId = this.builders[0]!.config.instrumentId;
    this.source = this.builders[0]!.config.source;
  }

  process(event: MarketDataEvent<TradeTick>): readonly CandleEngineEvent[] {
    // Pre-calculate every boundary before any builder mutates, so range/configuration
    // errors cannot leave the timeframes partially updated.
    for (const builder of this.builders) candleBucket(event.eventTime, builder.config);

    const mismatch = event.instrumentId !== this.instrumentId
      ? { field: "instrumentId" as const, expected: this.instrumentId, actual: event.instrumentId }
      : event.source !== this.source
        ? { field: "source" as const, expected: this.source, actual: event.source }
        : undefined;
    if (mismatch !== undefined) {
      return Object.freeze(this.builders.map((builder): CandleEngineEvent => Object.freeze({
        type: "IDENTITY_MISMATCH_REJECTED", timeframe: builder.config.timeframe, ...mismatch,
      })));
    }
    if (this.latestEventTime !== undefined && event.eventTime < this.latestEventTime) {
      return Object.freeze(this.builders.map((builder): CandleEngineEvent => Object.freeze({
        type: "OUT_OF_ORDER_REJECTED", timeframe: builder.config.timeframe,
        eventTime: event.eventTime, latestAcceptedEventTime: this.latestEventTime!,
      })));
    }

    const events: CandleEngineEvent[] = [];
    for (const builder of this.builders) events.push(...builder.process(event));
    this.latestEventTime = event.eventTime;
    return Object.freeze(events);
  }

  getCurrentCandles(): ReadonlyMap<TimeframeId, CandleSnapshot> {
    const snapshots = new Map<TimeframeId, CandleSnapshot>();
    for (const builder of this.builders) {
      const snapshot = builder.getCurrent();
      if (snapshot !== undefined) snapshots.set(builder.config.timeframe, snapshot);
    }
    return snapshots;
  }

  get timeframes(): readonly TimeframeId[] {
    return Object.freeze(this.builders.map((builder) => builder.config.timeframe));
  }
}
