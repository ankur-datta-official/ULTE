# Finalized candle snapshot restoration V1

## Authority boundary

`FINALIZED_CANDLE_RECOVERY_EVIDENCE_V1` is plain, versioned recovery data, not a
`CandleSnapshot`. `restoreFinalizedCandleSnapshot` reconstructs every trade with
`createTradeTick` and `createMarketDataEvent`, validates the historical builder
configuration, and replays the resulting events through a fresh
`TradeToCandleBuilder`. Success returns the exact snapshot reference carried by
the builder's target `CANDLE_CLOSED` event. No candle or quality object is built,
cloned, or patched by recovery code.

V1 supports at most 10,000 target-bucket trades. A candle requiring more raw
events is rejected rather than restored from an aggregate shortcut. One required
`previousAcceptedTrade` is the exact last accepted canonical trade preceding the
target bucket and recreates the builder state relevant to target-opening gap
detection. One required accepted event in a later bucket is the finalization
witness. The evidence contract asserts that the target list is the complete
canonical target-bucket sequence. Missing predecessor authority is unsupported
and rejects; V1 has no caller-asserted "first candle" escape hatch. Durable
storage of that evidence belongs to Phase33B.

An optional evidence-local event identity allows recovery to reject both exact
duplicate entries and same-identity conflicting payloads. It is not converted
to a live event identity and has no candle-authority role.

## Normal finalization semantics

The builder input is `MarketDataEvent<TradeTick>`. Recovery establishes its value
authority only through the public market-data constructors. It does not claim
that the old live ingestion engine accepted the event: live dedupe retention,
source epoch, observation-time checks, and sequence watermarks are separate
stream-continuation authority and do not affect candle calculation.

Intervals are half-open `[openTime, closeTime)`. `candleBucket` applies exact
fixed-duration floor alignment relative to the evidence's explicit UTC anchor.
The first accepted event opens a bucket. Events in that bucket update high and
low by exact decimal comparison, set close in replay order, add positive
quantities with decimal-safe arithmetic, and increment trade count. Open and
close are therefore the first and last replayed target prices. Equal timestamps
remain in evidence order; decreasing timestamps reject without sorting.

A candle closes only when the builder accepts a trade whose aligned bucket is
later. Crossing several buckets emits the prior close, reports the number of
fully skipped buckets, and opens no synthetic candles. The new candle receives
`GAP_DETECTED`; the candle being closed does not. Consequently, recreating a
target candle whose gap flag originated in bucket rollover requires one
predecessor event from the actual prior non-empty bucket. A same-bucket witness
cannot finalize and is rejected. If `GAP_DETECTED` was already explicit on a
canonical target event, the normal ordered quality union preserves that distinct
source-quality provenance without any recovery-time patch.

## Dependency table

| Final snapshot fact | Exact normal input | Required builder state | Bounded V1 evidence |
| --- | --- | --- | --- |
| instrument | builder configuration and every event | configured identity | configuration plus all events |
| timeframe | builder configuration | configured alignment | explicit timeframe |
| open/close time | event time, timeframe, anchor | none beyond configuration | explicit target boundary checked against `candleBucket` |
| open | first target trade price | target accumulator | ordered target trades |
| high/low | every target trade price | target accumulator | ordered target trades |
| close | last target trade price | target accumulator | ordered target trades |
| volume | every target trade quantity | target accumulator | ordered target trades, capped at 10,000 |
| quote volume | unsupported by the normal builder | none | absent |
| trade count | number of target trades | target accumulator | bounded target list |
| `isClosed` | later-bucket accepted trade | open target accumulator | one finalization witness |
| quality | ordered union of target event quality | target accumulator | quality on every reconstructed event |
| rollover `GAP_DETECTED` | prior non-empty bucket plus first target trade | prior open accumulator | required exact last accepted predecessor plus target boundary |

The five normal quality flags are `LIVE`, `DELAYED`, `STALE`, `GAP_DETECTED`,
and `SNAPSHOT`. The builder preserves their first-occurrence order across target
trades. It neither infers `LIVE` nor uses receive time, side, or sequence ID in
candle arithmetic. Source and instrument are routing authority. Event time owns
chronology and alignment. Price and quantity own OHLC and volume. No snapshot
quality supplied by a checkpoint is trusted.

## Rejections and scope

Restoration fails closed for malformed/non-plain data, unsupported schema,
invalid event construction, excess target cardinality, missing predecessor
authority, wrong instrument or source, decreasing chronology, target trades
outside the asserted bucket, alignment mismatch, an invalid predecessor
boundary, missing/same/earlier-bucket finalization witness, or any replay output
inconsistent with the asserted target. Recovery never sorts evidence and never
uses current/default alignment.

V1 does not restore live stream ownership, epochs, dedupe state, sequence
continuation, open buckets, future ingestion, persistence, broker/network I/O,
or analysis-cycle state. Restored snapshots are ordinary authoritative builder
outputs and can be passed to regime and structure analysis through their normal
public APIs.
