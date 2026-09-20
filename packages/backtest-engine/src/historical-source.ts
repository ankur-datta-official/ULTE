import type { MarketDataEvent } from "@ulte/market-data";

export class ArrayHistoricalEventSource<T> implements Iterable<MarketDataEvent<T>> {
  private readonly historicalEvents: readonly MarketDataEvent<T>[];

  constructor(events: readonly MarketDataEvent<T>[]) {
    const copy = [...events];
    for (let index = 1; index < copy.length; index += 1) {
      if (copy[index]!.eventTime < copy[index - 1]!.eventTime) {
        throw new RangeError(`Historical events are out of order at index ${index}`);
      }
    }
    this.historicalEvents = Object.freeze(copy);
  }

  get eventCount(): number {
    return this.historicalEvents.length;
  }

  [Symbol.iterator](): Iterator<MarketDataEvent<T>> {
    return this.historicalEvents[Symbol.iterator]();
  }
}
