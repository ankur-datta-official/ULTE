# Candle and multi-timeframe engine

Phase 2 adds deterministic candle construction to `market-data`. The same APIs accept normalized trade events in live arrival or replay order, so future live and backtest paths share identical aggregation behavior.

## Time and alignment

Candle intervals are half-open: `[openTime, closeTime)`. A trade exactly at `closeTime` belongs to the next candle, and `closeTime` is the exact boundary rather than the last millisecond in a bucket. Every timeframe has an explicit UTC `anchorTime`; boundaries use floor-aligned fixed-duration arithmetic relative to that anchor. Adapters will choose venue or session anchors later.

## Ordering, gaps, and finalization

Each builder accepts trade events in non-decreasing `eventTime` order. Equal timestamps are applied in input order. An older event produces `OUT_OF_ORDER_REJECTED` and changes no state; no reorder buffer is used. Once a candle has been emitted as closed, later input cannot rewrite it.

Crossing into a later bucket emits the closed candle and opens the new candle. If full buckets were skipped, `GAP_DETECTED` reports their count and boundaries. No empty candles are synthesized. The new candle conservatively carries the input quality flags plus `GAP_DETECTED`; all other candle snapshots preserve the ordered union of their contributing trade-quality flags. Quality is never inferred as `LIVE`.

## Multi-timeframe processing

`MultiTimeframeCandleEngine` binds one instrument and source to one or more unique timeframe alignments. It processes builders in configuration order, identifies every output by timeframe, and validates common routing/order conditions before timeframe state changes can diverge. Read-only snapshot APIs return frozen copies rather than mutable accumulators. No persistence or closed-candle resampling is included in this phase.
