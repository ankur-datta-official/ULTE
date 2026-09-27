# Live market-data ingestion V1

## Purpose and architecture

`@ulte/live-market-data-engine` is the provider-neutral boundary between future feed adapters and ULTE's canonical market-data/candle pipeline. A future adapter normalizes a provider event into a `LiveTradeEvent`; the ingestion engine validates that event and, only after acceptance, passes its canonical `MarketDataEvent<TradeTick>` to the existing `MultiTimeframeCandleEngine`. The package has no networking, credentials, provider SDK, retry loop, persistence, strategy, risk, execution, or UI behavior.

V1 supports trades because they are the existing input to deterministic candle aggregation. It does not accept provider-built candles or invent other live payload types. Source contracts expose an immutable descriptor, subscription request, sink, and subscription lifecycle without prescribing a transport.

## Source, stream, and event identity

A source descriptor contains an explicit canonical `sourceId`, operating mode, supported event kinds, and sequence semantics. Source identity is never inferred from an instrument and contains no credential or configuration blob.

One ingestion engine owns one trade stream. Its stream identity is a versioned, length-prefixed encoding of source ID, instrument ID, and event kind. An event identity additionally includes the caller-supplied source epoch and either the canonical sequence ID or, for a source without sequences, a required opaque source event ID. No clock, random value, unordered object serialization, or hash is used.

The event fingerprint is a fixed-order, length-prefixed encoding of canonical envelope and trade fields. Canonical constructors snapshot and validate the event without mutating caller-owned values. Source event timestamps and receive timestamps are preserved exactly.

## Chronology and no-lookahead

Every `ingest` call requires a validated caller-provided observation time. An event with `eventTime` after that boundary returns `REJECTED_FUTURE` and never reaches candles. An event older than the current epoch boundary or last accepted event returns `REJECTED_OUT_OF_ORDER`. V1 does not sort, buffer, or repair input.

Distinct events with the same timestamp are accepted in caller order. Identity checks happen before equal-time acceptance: an exact retained identity is a duplicate and a changed fingerprint under the same identity is a conflict. For a declared incrementing sequence, the sequence must also advance; for opaque sequences, no numeric ordering is inferred.

`ingestMany` preserves caller order and returns one result per input. It is deliberately sequential rather than batch-atomic: every accepted item is committed independently, and later rejected items do not undo earlier accepted items.

## Sequence and gap semantics

Sequence semantics are explicit:

- `NONE` requires a source event ID and forbids a sequence ID.
- `OPAQUE` requires a sequence ID and uses exact equality only.
- `STRICTLY_INCREMENTING_NON_NEGATIVE_INTEGER` requires a canonical decimal integer string, compares with `BigInt`, rejects non-increasing values, and reports skipped values as `SEQUENCE_GAP` with an exact string count.

The engine never converts sequence IDs to floating point. Time gaps are the existing candle engine's skipped fixed-duration buckets, surfaced as `TIME_GAP`. A gap accompanies an accepted result; neither sequence nor time gaps cause synthetic events or candles.

## Reset and bounded state

`beginSourceEpoch` requires a new opaque epoch ID plus caller-supplied effective and observation times. It rejects future or backward reset boundaries, clears sequence/dedup continuity, preserves candle history and last accepted chronology, and returns `STREAM_RESET`. Events before the new effective boundary remain rejected. Reused sequence values in a new epoch receive different event identities, so continuity is never silently assumed across reconnect/reset.

Deduplication is a deterministic FIFO window with a required positive safe-integer capacity. Only accepted identities and fingerprints are retained. Eviction is count-based and never consults a clock. An evicted event is still protected by event-time and ordered-sequence chronology where those are comparable; an opaque same-time identity outside the configured window cannot be recognized as an old duplicate, which is an explicit V1 retention limitation.

## Candle integration and live/replay consistency

Only accepted events call `MultiTimeframeCandleEngine.process`. Duplicate, conflict, out-of-order, and future results leave candle state unchanged. The existing engine prevalidates every configured candle boundary before any timeframe mutates, preserving atomic multi-timeframe behavior on invalid updates. Candle gap flags, decimal arithmetic, interval alignment, equal-time ordering, and snapshot semantics remain owned by `@ulte/market-data`.

Tests feed the same canonical chronological trades through `HistoricalReplayEngine`/`TradeTickCandleReplayConsumer` and through live ingestion with equivalent observation boundaries. Candle events and current candle snapshots are identical. Live-only ingestion statuses, source epochs, deduplication, and observation-boundary rejection intentionally have no replay equivalent.

## Deferred limitations

V1 is in-process and trade-only. It does not persist continuity state, resolve reconnects, fetch backfill, authenticate, choose providers, map provider payloads, subscribe over a network, or define fallback/failover policy. Those concerns belong to future adapter/runtime phases. Missing market data always remains explicit.
