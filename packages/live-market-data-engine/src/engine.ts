import {
  instrumentId,
  unixMs,
  type InstrumentId,
  type TimeframeId,
  type UnixMs,
} from "@ulte/instrument-model";
import {
  MultiTimeframeCandleEngine,
  type CandleAlignment,
  type CandleEngineEvent,
  type CandleSnapshot,
  type SequenceId,
} from "@ulte/market-data";
import {
  createLiveMarketDataSourceDescriptor,
  createLiveTradeEvent,
  sourceEpochId,
  type LiveMarketDataSourceDescriptor,
  type LiveTradeEvent,
  type SourceEpochId,
} from "./contracts.js";
import {
  createLiveEventFingerprint,
  createLiveEventIdentity,
  createLiveStreamId,
  type LiveEventFingerprint,
  type LiveEventIdentity,
  type LiveStreamId,
} from "./identity.js";

export type LiveGap =
  | Readonly<{
      readonly type: "SEQUENCE_GAP";
      readonly previousSequenceId: SequenceId;
      readonly currentSequenceId: SequenceId;
      readonly missingSequenceCount: string;
    }>
  | Readonly<{
      readonly type: "TIME_GAP";
      readonly timeframe: TimeframeId;
      readonly previousCloseTime: UnixMs;
      readonly nextOpenTime: UnixMs;
      readonly missingBucketCount: number;
    }>;

interface ResultBase {
  readonly streamId: LiveStreamId;
  readonly epochId: SourceEpochId;
  readonly eventIdentity: LiveEventIdentity;
  readonly eventTime: UnixMs;
  readonly observationTime: UnixMs;
}

export type LiveIngestionResult =
  | (ResultBase & {
      readonly status: "ACCEPTED";
      readonly gaps: readonly LiveGap[];
      readonly candleEvents: readonly CandleEngineEvent[];
    })
  | (ResultBase & { readonly status: "DUPLICATE" })
  | (ResultBase & { readonly status: "CONFLICTING_DUPLICATE" })
  | (ResultBase & {
      readonly status: "REJECTED_OUT_OF_ORDER";
      readonly reason: "EVENT_TIME" | "SEQUENCE" | "SOURCE_EPOCH";
      readonly chronologyBoundaryTime: UnixMs;
      readonly latestAcceptedEventTime?: UnixMs;
      readonly latestSequenceId?: SequenceId;
    })
  | (ResultBase & { readonly status: "REJECTED_FUTURE" });

export interface StreamResetResult {
  readonly status: "STREAM_RESET";
  readonly streamId: LiveStreamId;
  readonly previousEpochId: SourceEpochId;
  readonly epochId: SourceEpochId;
  readonly effectiveTime: UnixMs;
  readonly observationTime: UnixMs;
}

export interface LiveTradeIngestionEngineConfig {
  readonly source: LiveMarketDataSourceDescriptor;
  readonly instrumentId: InstrumentId;
  readonly initialEpochId: SourceEpochId;
  readonly initialEpochTime: UnixMs;
  readonly alignments: readonly CandleAlignment[];
  readonly deduplicationWindowSize: number;
}

export interface LiveIngestionStateSnapshot {
  readonly streamId: LiveStreamId;
  readonly epochId: SourceEpochId;
  readonly epochEffectiveTime: UnixMs;
  readonly latestAcceptedEventTime?: UnixMs;
  readonly latestSequenceId?: SequenceId;
  readonly retainedDeduplicationEntries: number;
  readonly deduplicationWindowSize: number;
}

interface DedupEntry {
  readonly identity: LiveEventIdentity;
  readonly fingerprint: LiveEventFingerprint;
}

const NON_NEGATIVE_INTEGER = /^(0|[1-9]\d*)$/;

function freezeResult<T extends object>(result: T): Readonly<T> {
  return Object.freeze(result);
}

export class LiveTradeIngestionEngine {
  readonly descriptor: LiveMarketDataSourceDescriptor;
  readonly instrumentId: InstrumentId;
  readonly streamId: LiveStreamId;
  private epochId: SourceEpochId;
  private epochEffectiveTime: UnixMs;
  private readonly candleEngine: MultiTimeframeCandleEngine;
  private readonly deduplicationWindowSize: number;
  private readonly deduplicationEntries = new Map<LiveEventIdentity, LiveEventFingerprint>();
  private readonly deduplicationOrder: LiveEventIdentity[] = [];
  private latestAcceptedEventTime: UnixMs | undefined;
  private latestSequenceId: SequenceId | undefined;

  constructor(config: LiveTradeIngestionEngineConfig) {
    if (!Number.isSafeInteger(config.deduplicationWindowSize) || config.deduplicationWindowSize <= 0) {
      throw new RangeError("deduplicationWindowSize must be a positive safe integer");
    }
    this.descriptor = createLiveMarketDataSourceDescriptor(config.source);
    if (!this.descriptor.capabilities.includes("TRADE")) {
      throw new TypeError("The source descriptor must declare TRADE capability");
    }
    this.instrumentId = instrumentId(config.instrumentId);
    this.epochId = sourceEpochId(config.initialEpochId);
    this.epochEffectiveTime = unixMs(config.initialEpochTime);
    this.streamId = createLiveStreamId({
      sourceId: this.descriptor.sourceId,
      instrumentId: this.instrumentId,
      eventKind: "TRADE",
    });
    this.deduplicationWindowSize = config.deduplicationWindowSize;
    this.candleEngine = new MultiTimeframeCandleEngine({
      instrumentId: this.instrumentId,
      source: this.descriptor.sourceId,
      alignments: config.alignments,
    });
  }

  ingest(input: LiveTradeEvent, asOf: UnixMs): LiveIngestionResult {
    const observationTime = unixMs(asOf);
    if (input.kind !== "TRADE") throw new TypeError("Unsupported live event kind");
    const liveEvent = createLiveTradeEvent(input);
    const event = liveEvent.event;
    if (event.instrumentId !== this.instrumentId) {
      throw new TypeError("Live event instrument does not match the ingestion stream");
    }
    if (event.source !== this.descriptor.sourceId) {
      throw new TypeError("Live event source does not match the ingestion stream");
    }
    this.validateSequenceContract(liveEvent);

    const eventIdentity = createLiveEventIdentity({
      streamId: this.streamId,
      epochId: this.epochId,
      ...(event.sequenceId === undefined
        ? { sourceEventId: liveEvent.sourceEventId! }
        : { sequenceId: event.sequenceId }),
    });
    const base = {
      streamId: this.streamId,
      epochId: this.epochId,
      eventIdentity,
      eventTime: event.eventTime,
      observationTime,
    };

    if (event.eventTime > observationTime) {
      return freezeResult({ status: "REJECTED_FUTURE", ...base });
    }

    const fingerprint = createLiveEventFingerprint([
      event.instrumentId,
      event.source,
      String(event.eventTime),
      String(event.receivedAt),
      event.payload.price,
      event.payload.quantity,
      event.payload.side,
      ...event.quality,
      event.sequenceId ?? "",
      liveEvent.sourceEventId ?? "",
    ]);
    const retainedFingerprint = this.deduplicationEntries.get(eventIdentity);
    if (retainedFingerprint !== undefined) {
      return freezeResult({
        status: retainedFingerprint === fingerprint ? "DUPLICATE" : "CONFLICTING_DUPLICATE",
        ...base,
      });
    }

    const chronologyBoundaryTime = this.latestAcceptedEventTime === undefined ||
      this.epochEffectiveTime > this.latestAcceptedEventTime
      ? this.epochEffectiveTime
      : this.latestAcceptedEventTime;
    if (event.eventTime < chronologyBoundaryTime) {
      return freezeResult({
        status: "REJECTED_OUT_OF_ORDER",
        ...base,
        reason: this.latestAcceptedEventTime === undefined || this.epochEffectiveTime > this.latestAcceptedEventTime
          ? "SOURCE_EPOCH" as const
          : "EVENT_TIME" as const,
        chronologyBoundaryTime,
        ...(this.latestAcceptedEventTime === undefined
          ? {}
          : { latestAcceptedEventTime: this.latestAcceptedEventTime }),
        ...(this.latestSequenceId === undefined ? {} : { latestSequenceId: this.latestSequenceId }),
      });
    }

    const sequenceComparison = this.compareOrderedSequence(event.sequenceId);
    if (sequenceComparison !== undefined && sequenceComparison <= 0) {
      return freezeResult({
        status: "REJECTED_OUT_OF_ORDER",
        ...base,
        reason: "SEQUENCE" as const,
        chronologyBoundaryTime,
        latestAcceptedEventTime: this.latestAcceptedEventTime!,
        latestSequenceId: this.latestSequenceId!,
      });
    }

    const sequenceGap = sequenceComparison !== undefined && sequenceComparison > 1
      ? freezeResult({
          type: "SEQUENCE_GAP" as const,
          previousSequenceId: this.latestSequenceId!,
          currentSequenceId: event.sequenceId!,
          missingSequenceCount: String(BigInt(event.sequenceId!) - BigInt(this.latestSequenceId!) - 1n),
        })
      : undefined;

    const candleEvents = this.candleEngine.process(event);
    if (candleEvents.some((output) =>
      output.type === "OUT_OF_ORDER_REJECTED" || output.type === "IDENTITY_MISMATCH_REJECTED")) {
      throw new Error("Candle engine rejected an event already validated by live ingestion");
    }

    this.latestAcceptedEventTime = event.eventTime;
    if (event.sequenceId !== undefined) this.latestSequenceId = event.sequenceId;
    this.retain(eventIdentity, fingerprint);

    const timeGaps = candleEvents.flatMap((output): readonly LiveGap[] => output.type === "GAP_DETECTED"
      ? [freezeResult({
          type: "TIME_GAP" as const,
          timeframe: output.timeframe,
          previousCloseTime: output.previousCloseTime,
          nextOpenTime: output.nextOpenTime,
          missingBucketCount: output.missingBucketCount,
        })]
      : []);
    const gaps = Object.freeze([
      ...(sequenceGap === undefined ? [] : [sequenceGap]),
      ...timeGaps,
    ]);
    return freezeResult({
      status: "ACCEPTED",
      ...base,
      gaps,
      candleEvents,
    });
  }

  ingestMany(events: readonly LiveTradeEvent[], asOf: UnixMs): readonly LiveIngestionResult[] {
    const observationTime = unixMs(asOf);
    return Object.freeze(events.map((event) => this.ingest(event, observationTime)));
  }

  beginSourceEpoch(input: {
    readonly epochId: SourceEpochId;
    readonly effectiveTime: UnixMs;
    readonly observationTime: UnixMs;
  }): StreamResetResult {
    const nextEpochId = sourceEpochId(input.epochId);
    const effectiveTime = unixMs(input.effectiveTime);
    const observationTime = unixMs(input.observationTime);
    if (nextEpochId === this.epochId) throw new TypeError("A source reset requires a new epochId");
    if (effectiveTime > observationTime) throw new RangeError("Source reset effectiveTime exceeds observationTime");
    if (this.latestAcceptedEventTime !== undefined && effectiveTime < this.latestAcceptedEventTime) {
      throw new RangeError("Source reset effectiveTime precedes the latest accepted event");
    }
    const previousEpochId = this.epochId;
    this.epochId = nextEpochId;
    this.epochEffectiveTime = effectiveTime;
    this.latestSequenceId = undefined;
    this.deduplicationEntries.clear();
    this.deduplicationOrder.length = 0;
    return freezeResult({
      status: "STREAM_RESET",
      streamId: this.streamId,
      previousEpochId,
      epochId: this.epochId,
      effectiveTime,
      observationTime,
    });
  }

  getCurrentCandles(): ReadonlyMap<TimeframeId, CandleSnapshot> {
    return this.candleEngine.getCurrentCandles();
  }

  getState(): LiveIngestionStateSnapshot {
    return freezeResult({
      streamId: this.streamId,
      epochId: this.epochId,
      epochEffectiveTime: this.epochEffectiveTime,
      ...(this.latestAcceptedEventTime === undefined ? {} : { latestAcceptedEventTime: this.latestAcceptedEventTime }),
      ...(this.latestSequenceId === undefined ? {} : { latestSequenceId: this.latestSequenceId }),
      retainedDeduplicationEntries: this.deduplicationEntries.size,
      deduplicationWindowSize: this.deduplicationWindowSize,
    });
  }

  private validateSequenceContract(liveEvent: LiveTradeEvent): void {
    const sequenceId = liveEvent.event.sequenceId;
    if (this.descriptor.sequenceSemantics === "NONE") {
      if (sequenceId !== undefined) throw new TypeError("Source declared no sequence IDs but event supplied one");
      if (liveEvent.sourceEventId === undefined) {
        throw new TypeError("An event from a non-sequenced source requires sourceEventId");
      }
      return;
    }
    if (sequenceId === undefined) throw new TypeError("Sequenced source event requires sequenceId");
    if (this.descriptor.sequenceSemantics === "STRICTLY_INCREMENTING_NON_NEGATIVE_INTEGER" &&
        !NON_NEGATIVE_INTEGER.test(sequenceId)) {
      throw new TypeError("Ordered sequenceId must be a canonical non-negative integer string");
    }
  }

  private compareOrderedSequence(current: SequenceId | undefined): number | undefined {
    if (this.descriptor.sequenceSemantics !== "STRICTLY_INCREMENTING_NON_NEGATIVE_INTEGER" ||
        this.latestSequenceId === undefined || current === undefined) {
      return undefined;
    }
    const difference = BigInt(current) - BigInt(this.latestSequenceId);
    return difference < 0n ? -1 : difference === 0n ? 0 : difference === 1n ? 1 : 2;
  }

  private retain(identity: LiveEventIdentity, fingerprint: LiveEventFingerprint): void {
    this.deduplicationEntries.set(identity, fingerprint);
    this.deduplicationOrder.push(identity);
    if (this.deduplicationOrder.length > this.deduplicationWindowSize) {
      const evicted = this.deduplicationOrder.shift();
      if (evicted === undefined) throw new Error("Deduplication state is corrupt");
      this.deduplicationEntries.delete(evicted);
    }
  }
}
