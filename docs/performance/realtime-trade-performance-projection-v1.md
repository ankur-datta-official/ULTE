# Deterministic realtime trade performance projection V1

## Purpose and authority

`@ulte/realtime-trade-performance-engine` projects one immutable gross performance result from one
already-authoritative Task 028B `RealtimeTradeValuationResult`. Task 028B is the sole realtime
valuation upstream. Task 029A remains the sole gross performance aggregation authority through
`projectTradePerformanceFromValuation`.

Task 029B never recalculates Task 028A valuation, reruns Task 027A accounting, resolves a mark, or
accepts an execution attempt, accounting specification, market event, valuation mark, or PnL field.
Its single public input is the complete Task 028B result. It performs no financial arithmetic.

## Status and provenance mapping

- `NO_VALUATION_PROJECTION` maps to `NO_PERFORMANCE_PROJECTION`; source kind and upstream status are
  passed through, and no valuation-looking field is inspected.
- `UNREALIZED_VALUATION_REJECTED` maps to `TRADE_PERFORMANCE_REJECTED` with reason
  `REALTIME_VALUATION_REJECTED`; the exact Task 028B rejection object is retained by reference.
- `UNREALIZED_VALUATION_PROJECTED` is passed to Task 029A's canonical valuation composition API. A
  successful snapshot retains source kind, upstream status, and the exact `LAST_TRADE_V1` mark policy.
  A Task 029A coherence rejection is retained under `performanceProjection` without flattening it.

The complete projected Task 028B result is retained for provenance. The performance snapshot's
unrealized valuation is that exact valuation object; its realized accounting and position exposure
are the exact nested authoritative objects. No clone or reconstruction occurs.

## Lifecycle and replay semantics

`OPEN` combines current unrealized PnL with realized PnL. A later Task 028B mark revalues the same
execution without requiring a fill. `PARTIALLY_EXITED` combines FIFO realized PnL with the remaining
open-basis valuation. `FLAT_ENTRY_ACTIVE` and `CLOSED` retain zero unrealized PnL, so total equals
realized. A later entry includes only its new upstream-owned basis plus retained realized PnL.

Applied and duplicate entry results with equal authoritative valuations yield equal snapshots while
retaining `FILL_APPLIED` versus `DUPLICATE_FILL`. Exit results behave the same for
`EXIT_FILL_APPLIED` versus `DUPLICATE_EXIT_FILL`. There is no local deduplication, cache, or state.

## Observation boundary and exclusions

Task 029B knows nothing about market events. Historical or live callers may pass only a Task 028B
result produced from evidence already yielded or accepted, preserving Task 028B's no-lookahead
boundary. Equal inputs produce equal outputs across repeated calls and fresh engine instances.

Production performs no clock, environment, randomness, broker, adapter, repository, persistence,
database, network, market subscription, reconciliation, submission, protection, cancellation, or
audit operation. Net PnL, costs, returns, analytics, portfolio aggregation, and account values remain
out of scope.
