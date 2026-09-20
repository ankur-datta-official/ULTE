import { describe, expect, it } from "vitest";
import { createInstrumentId, parseTimeframe, unixMs } from "@ulte/instrument-model";
import {
  createMarketDataEvent,
  createTradeTick,
  marketDataSource,
  MultiTimeframeCandleEngine,
  type CandleEngineEvent,
  type TradeTick,
} from "@ulte/market-data";
import {
  ArrayHistoricalEventSource,
  HistoricalReplayEngine,
  ReplayCollector,
  ReplayControl,
  SimulationClock,
  TradeTickCandleReplayConsumer,
  createBacktestRunMetadata,
  createHistoricalDatasetManifest,
} from "./index.js";

const instrument = createInstrumentId({ venue: "test", venueSymbol: "BTC/USD", instrumentKind: "SPOT" });
const source = marketDataSource("historical-feed");

function trade(eventTime: number, price = "10", receivedAt = eventTime, sequence?: string) {
  return createMarketDataEvent({
    instrumentId: instrument,
    source,
    eventTime,
    receivedAt,
    payload: createTradeTick({ price, quantity: "1", side: "UNKNOWN" }),
    quality: ["DELAYED"],
    ...(sequence === undefined ? {} : { sequenceId: sequence }),
  });
}

function replay(events: readonly ReturnType<typeof trade>[]) {
  const seen: { readonly price: string; readonly time: number; readonly index: number }[] = [];
  const result = new HistoricalReplayEngine(new ArrayHistoricalEventSource(events)).run({
    onEvent(event, context) {
      seen.push(Object.freeze({ price: event.payload.price, time: context.simulationTime, index: context.eventIndex }));
    },
  });
  return { result, seen };
}

describe("SimulationClock", () => {
  it("starts unstarted, advances forward, and accepts equal times", () => {
    const clock = new SimulationClock();
    expect(clock.currentTime).toBeUndefined();
    clock.advanceTo(unixMs(100));
    clock.advanceTo(unixMs(100));
    clock.advanceTo(unixMs(200));
    expect(clock.currentTime).toBe(200);
  });

  it("supports explicit initialization and rejects backward movement", () => {
    const clock = new SimulationClock(unixMs(100));
    expect(clock.currentTime).toBe(100);
    expect(() => clock.advanceTo(unixMs(99))).toThrow(/backwards/);
    expect(clock.currentTime).toBe(100);
  });

  it("preserves very large safe UnixMs values", () => {
    const time = unixMs(Number.MAX_SAFE_INTEGER);
    const clock = new SimulationClock();
    clock.advanceTo(time);
    expect(clock.currentTime).toBe(Number.MAX_SAFE_INTEGER);
  });
});

describe("historical source and replay", () => {
  it("replays an empty dataset", () => {
    const result = new HistoricalReplayEngine(new ArrayHistoricalEventSource<TradeTick>([])).run({ onEvent() {} });
    expect(result).toEqual({ processedEventCount: 0, stoppedEarly: false });
    expect(Object.isFrozen(result)).toBe(true);
  });

  it("replays one event with preserved envelope and correct summary", () => {
    const event = trade(100, "12", 90, "sequence-1");
    let delivered: typeof event | undefined;
    const engine = new HistoricalReplayEngine(new ArrayHistoricalEventSource([event]));
    const result = engine.run({
      onEvent(value, context) {
        delivered = value;
        expect(context).toEqual({ simulationTime: 100, eventIndex: 0 });
        expect(Object.isFrozen(context)).toBe(true);
        expect(engine.clock.currentTime).toBe(value.eventTime);
        expect("nextEvent" in context).toBe(false);
      },
    });
    expect(delivered).toBe(event);
    expect(result).toEqual({
      processedEventCount: 1,
      firstEventTime: 100,
      lastEventTime: 100,
      stoppedEarly: false,
      finalSimulationTime: 100,
    });
  });

  it("preserves ordered and equal-timestamp input order", () => {
    const events = [trade(100, "1"), trade(100, "2"), trade(200, "3")];
    const { seen, result } = replay(events);
    expect(seen).toEqual([
      { price: "1", time: 100, index: 0 },
      { price: "2", time: 100, index: 1 },
      { price: "3", time: 200, index: 2 },
    ]);
    expect(result).toMatchObject({ processedEventCount: 3, firstEventTime: 100, lastEventTime: 200 });
  });

  it("rejects an out-of-order dataset before any processing", () => {
    let processed = 0;
    expect(() => {
      const invalid = new ArrayHistoricalEventSource([trade(200), trade(100)]);
      new HistoricalReplayEngine(invalid).run({ onEvent() { processed += 1; } });
    }).toThrow(/out of order/);
    expect(processed).toBe(0);
  });

  it("copies input without mutating or observing later array changes", () => {
    const input = [trade(100)];
    const original = [...input];
    const historical = new ArrayHistoricalEventSource(input);
    input.push(trade(200));
    expect([...historical]).toEqual(original);
    expect(input).toHaveLength(2);
  });

  it("stops early after counting the delivered event", () => {
    const seen: number[] = [];
    const result = new HistoricalReplayEngine(new ArrayHistoricalEventSource([trade(100), trade(200), trade(300)])).run({
      onEvent(event) {
        seen.push(event.eventTime);
        return ReplayControl.STOP;
      },
    });
    expect(seen).toEqual([100]);
    expect(result).toEqual({
      processedEventCount: 1, firstEventTime: 100, lastEventTime: 100,
      stoppedEarly: true, finalSimulationTime: 100,
    });
  });

  it("only lets outputs depend on the already delivered prefix", () => {
    const events = [trade(100, "1"), trade(200, "2"), trade(300, "3")];
    const prefixOutputs: string[][] = [];
    const observed: string[] = [];
    new HistoricalReplayEngine(new ArrayHistoricalEventSource(events)).run({
      onEvent(event) {
        observed.push(event.payload.price);
        prefixOutputs.push([...observed]);
      },
    });
    expect(prefixOutputs).toEqual([["1"], ["1", "2"], ["1", "2", "3"]]);
  });

  it("produces deeply equivalent deterministic outputs on fresh runs", () => {
    const events = [trade(100, "1"), trade(100, "2"), trade(200, "3")];
    expect(replay(events)).toEqual(replay(events));
  });

  it("allows receivedAt before eventTime", () => {
    const event = trade(200, "10", 100);
    let receivedAt: number | undefined;
    new HistoricalReplayEngine(new ArrayHistoricalEventSource([event])).run({
      onEvent(value) { receivedAt = value.receivedAt; },
    });
    expect(receivedAt).toBe(100);
  });

  it("handles very large safe event times", () => {
    const result = replay([trade(Number.MAX_SAFE_INTEGER)]).result;
    expect(result.finalSimulationTime).toBe(Number.MAX_SAFE_INTEGER);
  });
});

describe("collector and metadata", () => {
  it("returns immutable snapshots that cannot mutate collector state", () => {
    const collector = new ReplayCollector<{ nested: { value: number } }>();
    const original = { nested: { value: 1 } };
    collector.collect(original);
    original.nested.value = 2;
    const snapshot = collector.snapshot();
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot[0]!.nested)).toBe(true);
    expect(() => { (snapshot[0]!.nested as { value: number }).value = 9; }).toThrow();
    expect(collector.snapshot()).toEqual([{ nested: { value: 1 } }]);
  });

  it("validates and freezes dataset manifests", () => {
    const manifest = createHistoricalDatasetManifest({
      datasetId: "btc-trades-v1", instrumentId: instrument, source,
      eventType: "TradeTick", startTime: 100, endTime: 200, eventCount: 2,
    });
    expect(Object.isFrozen(manifest)).toBe(true);
    expect(manifest).toMatchObject({ datasetId: "btc-trades-v1", eventCount: 2 });
    expect(() => createHistoricalDatasetManifest({
      datasetId: "x", instrumentId: instrument, source, eventType: "TradeTick", startTime: 200, endTime: 100,
    })).toThrow(/endTime/);
    expect(() => createHistoricalDatasetManifest({
      datasetId: "x", instrumentId: instrument, source, eventType: "TradeTick", startTime: 100, eventCount: 0,
    })).toThrow(/empty dataset/);
  });

  it("preserves caller-supplied run metadata and snapshots configuration", () => {
    const configuration = { mode: "historical", alignments: ["1m", "5m"] };
    const metadata = createBacktestRunMetadata({
      runId: "run-001", datasetId: "dataset-001", replaySchemaVersion: "1", configuration,
    });
    configuration.alignments.push("1h");
    expect(metadata).toEqual({
      runId: "run-001", datasetId: "dataset-001", replaySchemaVersion: "1",
      configuration: { mode: "historical", alignments: ["1m", "5m"] },
    });
    expect(Object.isFrozen(metadata)).toBe(true);
    expect(Object.isFrozen(metadata.configuration)).toBe(true);
  });
});

describe("TradeTick candle replay", () => {
  function runCandleReplay() {
    const candleEngine = new MultiTimeframeCandleEngine({
      instrumentId: instrument,
      source,
      alignments: [
        { timeframe: parseTimeframe("1m"), anchorTime: unixMs(0) },
        { timeframe: parseTimeframe("5m"), anchorTime: unixMs(0) },
      ],
    });
    const consumer = new TradeTickCandleReplayConsumer(candleEngine);
    const events = [trade(0, "10"), trade(30_000, "11"), trade(60_000, "12"), trade(300_000, "13")];
    const result = new HistoricalReplayEngine(new ArrayHistoricalEventSource(events)).run(consumer);
    return { result, outputs: consumer.getOutputs(), current: [...consumer.getCurrentCandles()] };
  }

  it("reuses deterministic 1m/5m boundary semantics", () => {
    const run = runCandleReplay();
    const closed = run.outputs.filter((event): event is Extract<CandleEngineEvent, { type: "CANDLE_CLOSED" }> =>
      event.type === "CANDLE_CLOSED");
    expect(closed.map((event) => [event.timeframe, event.snapshot.candle.openTime, event.snapshot.candle.closeTime])).toEqual([
      ["1m", 0, 60_000],
      ["1m", 60_000, 120_000],
      ["5m", 0, 300_000],
    ]);
    expect(run.result.processedEventCount).toBe(4);
  });

  it("keeps gaps explicit and creates no synthetic candle", () => {
    const outputs = runCandleReplay().outputs;
    const gaps = outputs.filter((event) => event.type === "GAP_DETECTED");
    expect(gaps).toEqual([expect.objectContaining({
      timeframe: "1m", previousCloseTime: 120_000, nextOpenTime: 300_000, missingBucketCount: 3,
    })]);
    const oneMinuteOpened = outputs.filter((event) => event.type === "CANDLE_OPENED" && event.timeframe === "1m");
    expect(oneMinuteOpened).toHaveLength(3);
  });

  it("is completely reproducible across fresh candle engines", () => {
    expect(runCandleReplay()).toEqual(runCandleReplay());
  });
});
