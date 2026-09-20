import type { TimeframeId } from "@ulte/instrument-model";
import {
  type CandleEngineEvent,
  type CandleSnapshot,
  type MarketDataEvent,
  MultiTimeframeCandleEngine,
  type TradeTick,
} from "@ulte/market-data";
import { ReplayCollector } from "./collector.js";
import type { ReplayConsumer } from "./replay-engine.js";

export class TradeTickCandleReplayConsumer implements ReplayConsumer<TradeTick> {
  private readonly collector = new ReplayCollector<CandleEngineEvent>();

  constructor(private readonly candleEngine: MultiTimeframeCandleEngine) {}

  onEvent(event: MarketDataEvent<TradeTick>): void {
    this.collector.collectAll(this.candleEngine.process(event));
  }

  getOutputs(): readonly CandleEngineEvent[] {
    return this.collector.snapshot();
  }

  getCurrentCandles(): ReadonlyMap<TimeframeId, CandleSnapshot> {
    return this.candleEngine.getCurrentCandles();
  }
}
