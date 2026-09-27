import { describe, expect, it } from "vitest";
import { ArrayHistoricalEventSource, HistoricalReplayEngine, TradeTickCandleReplayConsumer } from "@ulte/backtest-engine";
import { createInstrumentId, parseTimeframe, unixMs } from "@ulte/instrument-model";
import {
  MultiTimeframeCandleEngine,
  createMarketDataEvent,
  createTradeTick,
  marketDataSource,
  type CandleEngineEvent,
  type MarketDataEvent,
  type TradeTick,
} from "@ulte/market-data";
import {
  LiveTradeIngestionEngine,
  createLiveMarketDataSourceDescriptor,
  createLiveStreamId,
  createLiveSubscriptionRequest,
  createLiveTradeEvent,
  liveSubscriptionId,
  observationTime,
  sourceEpochId,
  type LiveMarketDataSink,
  type LiveMarketDataSource,
  type LiveSubscription,
} from "./index.js";

const instrument = createInstrumentId({ venue: "test", venueSymbol: "BTC/USD", instrumentKind: "SPOT" });
const otherInstrument = createInstrumentId({ venue: "test", venueSymbol: "ETH/USD", instrumentKind: "SPOT" });
const source = marketDataSource("primary-feed");
const otherSource = marketDataSource("secondary-feed");

function descriptor(
  sequenceSemantics: "NONE" | "OPAQUE" | "STRICTLY_INCREMENTING_NON_NEGATIVE_INTEGER" = "NONE",
  sourceId = source,
) {
  return createLiveMarketDataSourceDescriptor({
    sourceId,
    mode: "LIVE",
    capabilities: ["TRADE"],
    sequenceSemantics,
  });
}

function canonicalTrade(
  eventTime: number,
  price = "10",
  options: {
    source?: string;
    instrumentId?: string;
    sequenceId?: string;
    receivedAt?: number;
    quantity?: string;
  } = {},
) {
  return createMarketDataEvent({
    instrumentId: options.instrumentId ?? instrument,
    source: options.source ?? source,
    eventTime,
    receivedAt: options.receivedAt ?? eventTime,
    payload: createTradeTick({ price, quantity: options.quantity ?? "1", side: "UNKNOWN" }),
    quality: ["LIVE"],
    ...(options.sequenceId === undefined ? {} : { sequenceId: options.sequenceId }),
  });
}

function liveTrade(
  eventTime: number,
  id: string,
  price = "10",
  options: Parameters<typeof canonicalTrade>[2] = {},
) {
  return createLiveTradeEvent({ sourceEventId: id, event: canonicalTrade(eventTime, price, options) });
}

function engine(options: {
  sequenceSemantics?: "NONE" | "OPAQUE" | "STRICTLY_INCREMENTING_NON_NEGATIVE_INTEGER";
  deduplicationWindowSize?: number;
  sourceId?: typeof source;
  instrumentId?: typeof instrument;
  alignments?: readonly { timeframe: ReturnType<typeof parseTimeframe>; anchorTime: ReturnType<typeof unixMs> }[];
} = {}) {
  return new LiveTradeIngestionEngine({
    source: descriptor(options.sequenceSemantics, options.sourceId),
    instrumentId: options.instrumentId ?? instrument,
    initialEpochId: sourceEpochId("epoch-1"),
    initialEpochTime: unixMs(0),
    alignments: options.alignments ?? [
      { timeframe: parseTimeframe("1m"), anchorTime: unixMs(0) },
      { timeframe: parseTimeframe("5m"), anchorTime: unixMs(0) },
    ],
    deduplicationWindowSize: options.deduplicationWindowSize ?? 8,
  });
}

function sequencedTrade(eventTime: number, sequenceId: string, price = "10") {
  return createLiveTradeEvent({ event: canonicalTrade(eventTime, price, { sequenceId }) });
}

describe("live trade ingestion chronology and identity", () => {
  it("accepts the first valid event and updates all configured timeframes", () => {
    const subject = engine();
    const result = subject.ingest(liveTrade(1_000, "event-1"), unixMs(1_000));
    expect(result.status).toBe("ACCEPTED");
    if (result.status !== "ACCEPTED") throw new Error("Expected acceptance");
    expect(result.candleEvents.filter((event) => event.type === "TRADE_ACCEPTED")).toHaveLength(2);
    expect([...subject.getCurrentCandles()]).toHaveLength(2);
  });

  it("accepts a later chronological event", () => {
    const subject = engine();
    subject.ingest(liveTrade(1_000, "event-1"), unixMs(1_000));
    expect(subject.ingest(liveTrade(2_000, "event-2"), unixMs(2_000)).status).toBe("ACCEPTED");
    expect(subject.getState().latestAcceptedEventTime).toBe(2_000);
  });

  it("treats an exact duplicate as idempotent without a second candle mutation", () => {
    const subject = engine();
    const event = liveTrade(1_000, "event-1");
    subject.ingest(event, unixMs(1_000));
    const before = [...subject.getCurrentCandles()];
    expect(subject.ingest(event, unixMs(1_000)).status).toBe("DUPLICATE");
    expect([...subject.getCurrentCandles()]).toEqual(before);
  });

  it("rejects a conflicting duplicate without a candle mutation", () => {
    const subject = engine();
    subject.ingest(liveTrade(1_000, "event-1", "10"), unixMs(1_000));
    const before = [...subject.getCurrentCandles()];
    expect(subject.ingest(liveTrade(1_000, "event-1", "11"), unixMs(1_000)).status)
      .toBe("CONFLICTING_DUPLICATE");
    expect([...subject.getCurrentCandles()]).toEqual(before);
  });

  it("rejects an earlier timestamp without a candle mutation", () => {
    const subject = engine();
    subject.ingest(liveTrade(2_000, "event-2"), unixMs(2_000));
    const before = [...subject.getCurrentCandles()];
    const result = subject.ingest(liveTrade(1_000, "event-1"), unixMs(2_000));
    expect(result).toMatchObject({ status: "REJECTED_OUT_OF_ORDER", reason: "EVENT_TIME" });
    expect([...subject.getCurrentCandles()]).toEqual(before);
  });

  it("rejects an event beyond the caller observation boundary", () => {
    const subject = engine();
    expect(subject.ingest(liveTrade(2_000, "event-1"), unixMs(1_999)).status).toBe("REJECTED_FUTURE");
    expect(subject.getState().latestAcceptedEventTime).toBeUndefined();
    expect(subject.getCurrentCandles().size).toBe(0);
  });

  it("accepts distinct equal-timestamp identities in caller order", () => {
    const subject = engine();
    expect(subject.ingest(liveTrade(1_000, "event-1", "10"), unixMs(1_000)).status).toBe("ACCEPTED");
    expect(subject.ingest(liveTrade(1_000, "event-2", "11"), unixMs(1_000)).status).toBe("ACCEPTED");
    expect([...subject.getCurrentCandles()].map(([, snapshot]) => snapshot.candle.close)).toEqual(["11", "11"]);
  });

  it("snapshots validation input without mutating caller-owned data", () => {
    const mutable = {
      kind: "TRADE" as const,
      sourceEventId: "event-1" as ReturnType<typeof createLiveTradeEvent>["sourceEventId"],
      event: {
        instrumentId: instrument,
        source,
        eventTime: unixMs(1_000),
        receivedAt: unixMs(1_001),
        payload: { price: "10", quantity: "1", side: "UNKNOWN" },
        quality: ["LIVE"],
      },
    } as unknown as ReturnType<typeof createLiveTradeEvent>;
    const before = structuredClone(mutable);
    engine().ingest(mutable, unixMs(1_000));
    expect(mutable).toEqual(before);
    expect(Object.isFrozen(mutable)).toBe(false);
  });

  it("returns frozen public results and nested result collections", () => {
    const result = engine().ingest(liveTrade(1_000, "event-1"), unixMs(1_000));
    expect(Object.isFrozen(result)).toBe(true);
    if (result.status !== "ACCEPTED") throw new Error("Expected acceptance");
    expect(Object.isFrozen(result.gaps)).toBe(true);
    expect(Object.isFrozen(result.candleEvents)).toBe(true);
  });

  it("derives distinct stream identities by source and instrument", () => {
    const first = createLiveStreamId({ sourceId: source, instrumentId: instrument, eventKind: "TRADE" });
    const differentSource = createLiveStreamId({ sourceId: otherSource, instrumentId: instrument, eventKind: "TRADE" });
    const differentInstrument = createLiveStreamId({ sourceId: source, instrumentId: otherInstrument, eventKind: "TRADE" });
    expect(first).not.toBe(differentSource);
    expect(first).not.toBe(differentInstrument);
  });

  it("rejects cross-instrument input before state or candles can change", () => {
    const subject = engine();
    expect(() => subject.ingest(liveTrade(1_000, "event-1", "10", { instrumentId: otherInstrument }), unixMs(1_000)))
      .toThrow(/instrument/);
    expect(subject.getState().retainedDeduplicationEntries).toBe(0);
    expect(subject.getCurrentCandles().size).toBe(0);
  });

  it("rejects cross-source input before state or candles can change", () => {
    const subject = engine();
    expect(() => subject.ingest(liveTrade(1_000, "event-1", "10", { source: otherSource }), unixMs(1_000)))
      .toThrow(/source/);
    expect(subject.getState().retainedDeduplicationEntries).toBe(0);
    expect(subject.getCurrentCandles().size).toBe(0);
  });
});

describe("sequence, gap, and reset behavior", () => {
  it("surfaces a detectable sequence gap without fabricating candles", () => {
    const subject = engine({ sequenceSemantics: "STRICTLY_INCREMENTING_NON_NEGATIVE_INTEGER" });
    subject.ingest(sequencedTrade(1_000, "10"), unixMs(1_000));
    const result = subject.ingest(sequencedTrade(2_000, "13"), unixMs(2_000));
    if (result.status !== "ACCEPTED") throw new Error("Expected acceptance");
    expect(result.gaps).toContainEqual({
      type: "SEQUENCE_GAP", previousSequenceId: "10", currentSequenceId: "13", missingSequenceCount: "2",
    });
    expect([...subject.getCurrentCandles()].every(([, snapshot]) => snapshot.candle.tradeCount === 2)).toBe(true);
  });

  it("does not impose numeric ordering on opaque sequence identifiers", () => {
    const subject = engine({ sequenceSemantics: "OPAQUE" });
    expect(subject.ingest(sequencedTrade(1_000, "z"), unixMs(1_000)).status).toBe("ACCEPTED");
    expect(subject.ingest(sequencedTrade(2_000, "a"), unixMs(2_000)).status).toBe("ACCEPTED");
  });

  it("rejects decreasing ordered sequences even when time advances", () => {
    const subject = engine({ sequenceSemantics: "STRICTLY_INCREMENTING_NON_NEGATIVE_INTEGER" });
    subject.ingest(sequencedTrade(1_000, "2"), unixMs(1_000));
    expect(subject.ingest(sequencedTrade(2_000, "1"), unixMs(2_000)))
      .toMatchObject({ status: "REJECTED_OUT_OF_ORDER", reason: "SEQUENCE" });
  });

  it("detects exact and conflicting duplicate opaque sequence IDs", () => {
    const subject = engine({ sequenceSemantics: "OPAQUE" });
    const accepted = sequencedTrade(1_000, "opaque-sequence", "10");
    subject.ingest(accepted, unixMs(1_000));
    expect(subject.ingest(accepted, unixMs(1_000)).status).toBe("DUPLICATE");
    expect(subject.ingest(sequencedTrade(1_000, "opaque-sequence", "11"), unixMs(1_000)).status)
      .toBe("CONFLICTING_DUPLICATE");
  });

  it("surfaces candle time gaps and creates no empty candles", () => {
    const subject = engine();
    subject.ingest(liveTrade(0, "event-1"), unixMs(0));
    const result = subject.ingest(liveTrade(180_000, "event-2"), unixMs(180_000));
    if (result.status !== "ACCEPTED") throw new Error("Expected acceptance");
    expect(result.gaps).toContainEqual(expect.objectContaining({ type: "TIME_GAP", timeframe: "1m", missingBucketCount: 2 }));
    const oneMinuteOpened = result.candleEvents.filter((event) => event.type === "CANDLE_OPENED" && event.timeframe === "1m");
    expect(oneMinuteOpened).toHaveLength(1);
  });

  it("establishes an explicit new continuity epoch without fabricating events", () => {
    const subject = engine({ sequenceSemantics: "STRICTLY_INCREMENTING_NON_NEGATIVE_INTEGER" });
    subject.ingest(sequencedTrade(1_000, "50"), unixMs(1_000));
    const before = [...subject.getCurrentCandles()];
    const reset = subject.beginSourceEpoch({
      epochId: sourceEpochId("epoch-2"), effectiveTime: unixMs(1_000), observationTime: unixMs(1_000),
    });
    expect(reset).toMatchObject({ status: "STREAM_RESET", previousEpochId: "epoch-1", epochId: "epoch-2" });
    expect(Object.isFrozen(reset)).toBe(true);
    expect([...subject.getCurrentCandles()]).toEqual(before);
    expect(subject.getState().retainedDeduplicationEntries).toBe(0);
  });

  it("does not alias a pre-reset identity with the same post-reset sequence", () => {
    const subject = engine({ sequenceSemantics: "STRICTLY_INCREMENTING_NON_NEGATIVE_INTEGER" });
    const before = subject.ingest(sequencedTrade(1_000, "1"), unixMs(1_000));
    subject.beginSourceEpoch({
      epochId: sourceEpochId("epoch-2"), effectiveTime: unixMs(1_000), observationTime: unixMs(1_000),
    });
    const after = subject.ingest(sequencedTrade(1_000, "1"), unixMs(1_000));
    expect(after.status).toBe("ACCEPTED");
    expect(after.eventIdentity).not.toBe(before.eventIdentity);
  });

  it("rejects events timestamped before the new epoch boundary", () => {
    const subject = engine();
    subject.ingest(liveTrade(1_000, "event-1"), unixMs(1_000));
    subject.beginSourceEpoch({
      epochId: sourceEpochId("epoch-2"), effectiveTime: unixMs(2_000), observationTime: unixMs(2_000),
    });
    expect(subject.ingest(liveTrade(1_500, "event-2"), unixMs(2_000)))
      .toMatchObject({ status: "REJECTED_OUT_OF_ORDER", reason: "SOURCE_EPOCH", chronologyBoundaryTime: 2_000 });
  });

  it("retains a caller-bounded FIFO deduplication window", () => {
    const subject = engine({ deduplicationWindowSize: 2 });
    subject.ingest(liveTrade(1_000, "event-1"), unixMs(1_000));
    subject.ingest(liveTrade(2_000, "event-2"), unixMs(2_000));
    subject.ingest(liveTrade(3_000, "event-3"), unixMs(3_000));
    expect(subject.getState()).toMatchObject({ retainedDeduplicationEntries: 2, deduplicationWindowSize: 2 });
    expect(subject.ingest(liveTrade(1_000, "event-1"), unixMs(3_000)).status).toBe("REJECTED_OUT_OF_ORDER");
  });
});

describe("candle integration and determinism", () => {
  it("does not partially mutate timeframes when candle prevalidation fails", () => {
    const subject = engine({
      alignments: [
        { timeframe: parseTimeframe("1s"), anchorTime: unixMs(991) },
        { timeframe: parseTimeframe("1m"), anchorTime: unixMs(0) },
      ],
    });
    subject.ingest(liveTrade(1_000, "event-1"), unixMs(1_000));
    const beforeCandles = [...subject.getCurrentCandles()];
    const beforeState = subject.getState();
    const nearMaximum = Number.MAX_SAFE_INTEGER - 1;
    expect(() => subject.ingest(liveTrade(nearMaximum, "event-2"), unixMs(Number.MAX_SAFE_INTEGER)))
      .toThrow(/boundary/);
    expect([...subject.getCurrentCandles()]).toEqual(beforeCandles);
    expect(subject.getState()).toEqual(beforeState);
  });

  it("processes batches sequentially in caller order with explicit partial results", () => {
    const subject = engine();
    const results = subject.ingestMany([
      liveTrade(1_000, "event-1"),
      liveTrade(3_000, "event-3"),
      liveTrade(2_000, "event-2"),
    ], unixMs(3_000));
    expect(results.map((result) => result.status)).toEqual(["ACCEPTED", "ACCEPTED", "REJECTED_OUT_OF_ORDER"]);
    expect(Object.isFrozen(results)).toBe(true);
  });

  it("produces identical results for the same sequence on fresh engines", () => {
    function run() {
      const subject = engine({ sequenceSemantics: "STRICTLY_INCREMENTING_NON_NEGATIVE_INTEGER" });
      return [
        subject.ingest(sequencedTrade(0, "1", "10"), unixMs(0)),
        subject.ingest(sequencedTrade(60_000, "3", "11"), unixMs(60_000)),
      ];
    }
    expect(run()).toEqual(run());
  });

  it("matches existing historical replay candle outputs for the same trades", () => {
    const trades = [canonicalTrade(0, "10"), canonicalTrade(30_000, "11"), canonicalTrade(60_000, "12")];
    const alignments = [
      { timeframe: parseTimeframe("1m"), anchorTime: unixMs(0) },
      { timeframe: parseTimeframe("5m"), anchorTime: unixMs(0) },
    ];
    const replayCandleEngine = new MultiTimeframeCandleEngine({ instrumentId: instrument, source, alignments });
    const replayConsumer = new TradeTickCandleReplayConsumer(replayCandleEngine);
    new HistoricalReplayEngine(new ArrayHistoricalEventSource(trades)).run(replayConsumer);

    const liveEngine = engine({ alignments });
    const liveOutputs: CandleEngineEvent[] = [];
    trades.forEach((event, index) => {
      const result = liveEngine.ingest(createLiveTradeEvent({ sourceEventId: `event-${index}`, event }), event.eventTime);
      if (result.status !== "ACCEPTED") throw new Error("Expected acceptance");
      liveOutputs.push(...result.candleEvents);
    });
    expect(liveOutputs).toEqual(replayConsumer.getOutputs());
    expect([...liveEngine.getCurrentCandles()]).toEqual([...replayConsumer.getCurrentCandles()]);
  });
});

describe("provider-neutral source contract", () => {
  it("delivers normalized events through a fake source without provider knowledge", async () => {
    const event = liveTrade(1_000, "event-1");
    class FakeSource implements LiveMarketDataSource {
      readonly descriptor = descriptor();
      async subscribe(
        request: ReturnType<typeof createLiveSubscriptionRequest>,
        sink: LiveMarketDataSink,
      ): Promise<LiveSubscription> {
        expect(request.instrumentId).toBe(instrument);
        await sink.onEvent(event, observationTime(1_000));
        return Object.freeze({
          subscriptionId: liveSubscriptionId("subscription-1"),
          async unsubscribe() {},
        });
      }
    }
    const received: MarketDataEvent<TradeTick>[] = [];
    const subscription = await new FakeSource().subscribe(
      createLiveSubscriptionRequest({ instrumentId: instrument, eventKinds: ["TRADE"] }),
      { onEvent(value) { received.push(value.event); } },
    );
    expect(received).toEqual([event.event]);
    expect(subscription.subscriptionId).toBe("subscription-1");
  });
});
