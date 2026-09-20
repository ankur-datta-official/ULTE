# Market structure and liquidity engine V1

## Purpose and boundary

`@ulte/structure-engine` deterministically describes chart structure for one instrument and timeframe from closed `CandleSnapshot` values. It emits structural evidence only: no trade direction, entry, exit, stop, target, confidence, probability, or execution instruction.

## Confirmed pivots and relationships

A swing high is strictly higher than every high in its configured left and right windows; a swing low is strictly lower than every corresponding low. Any tie disqualifies that pivot. High and low tests are independent, so one candle may satisfy both. A pivot becomes observable only when its final right-side candle closes; `confirmedAt` records that candle's close time.

Each confirmed high is compared exactly with the prior confirmed high as `HIGHER_HIGH`, `LOWER_HIGH`, or `EQUAL_HIGH`. Lows analogously become `HIGHER_LOW`, `LOWER_LOW`, or `EQUAL_LOW`. The first swing of each kind is `UNCLASSIFIED`; no fuzzy tolerance is used.

Structure is `UP` for a latest higher high plus higher low, `DOWN` for a latest lower high plus lower low, `MIXED` when both classified relationships exist but do not form those pairs, and `UNDETERMINED` until both exist.

## Liquidity references and events

Each confirmed swing high creates a buy-side structural reference and each confirmed swing low a sell-side reference. These are descriptive reference levels, not guaranteed liquidity pools. They do not exist before pivot confirmation.

For an active high reference, a later close above it emits `CLOSE_BREAK_ABOVE`; otherwise, a wick strictly above followed by a close at or below emits `SWEEP_ABOVE_RECLAIM`. Low references use the inverse rules. Exact touches are neither sweeps nor breaks. Close breaks take priority. Resolved levels cannot resolve again.

Processing is chronological. A candle can resolve every active level it crosses; events are ordered by level creation, which follows source confirmation time, then pivot open time, with high before low for an otherwise identical pivot. `detectedAt` is always the resolving candle's close time and is never backdated.

## Window and data policy

Only the most recent configured analysis window is authoritative. Its candles are not sorted or repaired. Open candles, identity/timeframe mismatches, duplicate or out-of-order times, overlapping/inconsistent close-time progression, and `GAP_DETECTED` are rejected explicitly. Prices are compared as exact decimal strings without JavaScript floating-point conversion. The rules are timeframe-neutral and use no wall clock or randomness.
