import {
  createMarketDataEvent,
  createTradeTick,
  type MarketDataEvent,
  type TradeTick,
} from "@ulte/market-data";
import { createValuationMark, type ValuationMark } from "@ulte/trade-valuation-engine";

/** Resolves the explicit LAST_TRADE_V1 policy from one already-observed canonical trade event. */
export function resolveLastTradeValuationMark(
  markSource: MarketDataEvent<TradeTick>,
): ValuationMark | undefined {
  try {
    const event = createMarketDataEvent({
      instrumentId: markSource.instrumentId,
      source: markSource.source,
      eventTime: markSource.eventTime,
      receivedAt: markSource.receivedAt,
      payload: createTradeTick({
        price: markSource.payload.price,
        quantity: markSource.payload.quantity,
        side: markSource.payload.side,
      }),
      quality: markSource.quality,
      ...(markSource.sequenceId === undefined ? {} : { sequenceId: markSource.sequenceId }),
    });
    return createValuationMark({
      instrumentId: event.instrumentId,
      markPrice: event.payload.price,
      markAsOf: event.eventTime,
    });
  } catch {
    return undefined;
  }
}
