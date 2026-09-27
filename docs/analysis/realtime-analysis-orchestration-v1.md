# Real-time analysis orchestration V1

## Purpose and architectural location

`@ulte/realtime-analysis-engine` is the provider-neutral, in-process boundary between accepted live
market-data progression and future decision orchestration. It consumes Task 017
`LiveIngestionResult` values, or the equivalent `CandleEngineEvent` output from historical replay,
and coordinates the existing regime, structure/liquidity, and setup engines. It does not contain a
market-data provider, transport, database, risk decision, sizing calculation, trade intent, order
preparation, or execution behavior.

## Finalized-candle-only invariant and trigger policy

Only `CANDLE_CLOSED` events are eligible for history. Opened and updated candles do not trigger a
cycle and are never copied into analysis state. A purported close whose snapshot is not closed is
rejected. Rejected Task 017 results (`DUPLICATE`, `CONFLICTING_DUPLICATE`,
`REJECTED_OUT_OF_ORDER`, and `REJECTED_FUTURE`) return `NO_ANALYSIS` and cannot update history or
invoke a downstream engine.

V1 runs once per unique finalized-candle close boundary in an accepted result. The effective candle
close is both `triggerCloseTime` and `analysisAsOf`; it is derived from the candle output and never
from a wall clock. A bounded FIFO of deterministic cycle IDs suppresses repeated boundaries.

## Same-boundary atomicity and as-of semantics

All finalized outputs from one call are validated and staged before any frame is evaluated. When
multiple timeframes close at the same boundary, one frame is produced after every relevant close is
staged. Every timeframe history in that frame is filtered to `closeTime <= analysisAsOf`, so a later
close carried by the same coherent event batch cannot leak into an earlier boundary. Regime,
structure, and setup evaluation then receive references from that one immutable frame. If evaluation
throws, neither staged history nor cycle-deduplication state is committed, and no partial result is
returned.

`processCandleEvents` is an atomic candle-engine batch boundary API, not an arbitrary event
accumulator. Each call must contain the complete, coherent output of exactly one
`MultiTimeframeCandleEngine.process` call. Replaying a finalized candle already stored by timeframe
and close boundary is idempotent. A new timeframe candle arriving in a later call for an
already-published boundary throws `LateSameBoundaryFinalizationError`; history and cycle state remain
unchanged, and the engine neither repairs nor republishes the prior frame. `processLiveIngestion`
additionally verifies the Task 017 stream identity and forwards its already-coherent candle event
batch.

Published analysis boundaries are monotonic. After a batch publishes successfully, the engine keeps
the greatest published close boundary independently of its bounded recent-cycle deduplication
window. Any new finalized candle at or before that boundary fails closed, even after its cycle ID is
evicted; only an exact snapshot already retained in the same timeframe history is an idempotent
replay. The monotonic boundary advances only after staging, downstream evaluation, history commit,
and recent-cycle retention all succeed, so an evaluation failure cannot close or reopen a boundary.

## Timeframe roles and bounded history

Configuration explicitly names regime, structure, and setup timeframes, and every role must refer to
a configured timeframe. The current setup-engine contract requires setup candles to use the same
timeframe as its structure result, so V1 validates that the structure and setup roles match rather
than adapting or changing that strategy rule.

Each configured timeframe has a positive safe-integer history limit. Finalized snapshots are copied,
frozen, appended in chronology, and evicted FIFO by count; no clock-based expiry or sorting occurs.
No missing candle is fabricated. Before downstream evaluation, the coordinator checks the existing
regime required-candle count and structure lookback (plus at least one setup candle). A shortage
returns `INSUFFICIENT_HISTORY` without calling any analysis engine.

## Gaps, reset, and no-lookahead guarantees

Gaps remain gaps. Candle quality is preserved, frames report `GAPPED` plus the affected candle open
times, and the existing engines retain authority over their `DATA_GAP` semantics. Histories are not
reindexed or filled.

A Task 017 source reset returns `NO_ANALYSIS/SOURCE_RESET`. It creates no candle or cycle and does not
erase valid finalized history. Stream epochs are not part of cycle identity because Task 017 keeps
accepted event chronology across reset and a reset cannot itself close a candle; close boundary plus
stream and profile identity remains unambiguous.

Open candles are never present in stored history. A frame cannot contain a candle closing after its
explicit as-of boundary, including a partially formed higher timeframe that the underlying candle
engine may currently hold. Structure pivot confirmation, regime classification, and setup behavior
remain exactly those of their existing packages.

## Analysis identity and outputs

The analysis profile ID uses fixed-order, length-prefixed encoding of behavioral configuration:
profile version, timeframe roles and limits, downstream engine settings, and cycle-deduplication
capacity. The cycle ID uses the same collision-safe encoding over instrument, source, trigger close
boundary, and profile ID. Neither identity uses unordered serialization, randomness, or a clock.

Published results are frozen. A cycle is either `INSUFFICIENT_HISTORY`, `NO_SETUP` (the existing
setup engine is ready with no candidates), or `ANALYZED`; evaluated cycles expose the synchronized
frame and the unmodified public result types from the regime, structure, and setup engines.

## Live/replay equivalence and deferred work

Live ingestion and historical replay both feed the candle events produced by the shared
`@ulte/market-data` implementation into the same coordinator. Tests assert matching close boundaries,
finalized histories, regime outputs, structure/liquidity outputs, and setup outputs. Live-only
rejection and source-reset metadata intentionally have no replay equivalent.

Task 019 may consume these immutable analysis results for deterministic decision, structural-risk,
portfolio-risk, sizing, trade-intent, and execution-preparation orchestration. None of those packages
is imported or invoked here. Provider adapters, REST/WebSocket access, broker APIs, persistence,
timers, and execution are also intentionally absent.
