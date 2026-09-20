import type { UnixMs } from "@ulte/instrument-model";
import type { MarketDataEvent } from "@ulte/market-data";
import { ArrayHistoricalEventSource } from "./historical-source.js";
import { SimulationClock } from "./simulation-clock.js";

export const ReplayControl = Object.freeze({ CONTINUE: "CONTINUE", STOP: "STOP" } as const);
export type ReplayControl = (typeof ReplayControl)[keyof typeof ReplayControl];

export interface ReplayContext {
  readonly simulationTime: UnixMs;
  readonly eventIndex: number;
}

export interface ReplayConsumer<T> {
  onEvent(event: MarketDataEvent<T>, context: ReplayContext): ReplayControl | void;
}

export interface ReplayRunResult {
  readonly processedEventCount: number;
  readonly firstEventTime?: UnixMs;
  readonly lastEventTime?: UnixMs;
  readonly stoppedEarly: boolean;
  readonly finalSimulationTime?: UnixMs;
}

export class HistoricalReplayEngine<T> {
  readonly clock: SimulationClock;
  private hasRun = false;

  constructor(
    private readonly source: ArrayHistoricalEventSource<T>,
    clock: SimulationClock = new SimulationClock(),
  ) {
    this.clock = clock;
  }

  run(consumer: ReplayConsumer<T>): ReplayRunResult {
    if (this.hasRun) throw new Error("A HistoricalReplayEngine instance can only be run once");
    this.hasRun = true;

    let processedEventCount = 0;
    let firstEventTime: UnixMs | undefined;
    let lastEventTime: UnixMs | undefined;
    let stoppedEarly = false;

    for (const event of this.source) {
      this.clock.advanceTo(event.eventTime);
      firstEventTime ??= event.eventTime;
      lastEventTime = event.eventTime;
      const context = Object.freeze({
        simulationTime: event.eventTime,
        eventIndex: processedEventCount,
      });
      const control = consumer.onEvent(event, context);
      processedEventCount += 1;
      if (control === ReplayControl.STOP) {
        stoppedEarly = processedEventCount < this.source.eventCount;
        break;
      }
      if (control !== undefined && control !== ReplayControl.CONTINUE) {
        throw new TypeError(`Invalid replay control: ${String(control)}`);
      }
    }

    return Object.freeze({
      processedEventCount,
      ...(firstEventTime === undefined ? {} : { firstEventTime }),
      ...(lastEventTime === undefined ? {} : { lastEventTime }),
      stoppedEarly,
      ...(this.clock.currentTime === undefined ? {} : { finalSimulationTime: this.clock.currentTime }),
    });
  }
}
