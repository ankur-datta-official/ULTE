# Deterministic realtime position exposure projection V1

## Boundary and authoritative sources

`@ulte/realtime-position-exposure-engine` is the Task 026B boundary immediately after the realtime
entry-fill and exit-fill lifecycles. It depends on Task 026A's `@ulte/position-engine` and converts
only authoritative successful `RealtimeExecutionFillResult` and
`RealtimeExecutionExitFillResult` values into `PositionExposure` V1 snapshots.

The input is a discriminated `ENTRY_FILL` or `EXIT_FILL` source. It deliberately has no independent
`ExecutionAttempt`, quantity, exposure state, direction, or as-of input. For an actionable result,
the projector reads only the `executionAttempt` embedded in that successful upstream result. Thus a
valid lifecycle result cannot be paired with a substituted caller attempt.

## Outer-status gating and replay

Entry `FILL_APPLIED` and `DUPLICATE_FILL` results are actionable. `FILL_REJECTED` and
`NO_FILL_PROCESSING` return `NO_POSITION_PROJECTION`, even if a rejected value carries an
attempt-looking diagnostic field. Exit `EXIT_FILL_APPLIED` and `DUPLICATE_EXIT_FILL` are actionable;
`EXIT_FILL_REJECTED` and `NO_EXIT_FILL_PROCESSING` return `NO_POSITION_PROJECTION` under the same
outer-status rule.

Exact duplicates publicly carry the unchanged authoritative attempt, so they project the same
position snapshot without a local deduplication map, cache, counter, or lifecycle transition. An
upstream rejection is kept distinct from a successful upstream result whose attempt is rejected by
the position domain.

## Position-domain ownership

Every actionable result is passed directly to `projectPositionExposure(upstream.executionAttempt)`.
Task 026B does no decimal arithmetic and derives no open quantity, LONG/SHORT direction,
`entryCanIncreaseExposure`, exposure state, or `executionAsOf`. It returns the exact position-engine
rejection reason when that projection fails.

Consequently, a 2.75 entry fill projects `OPEN` exposure of 2.75. Exiting that 2.75 while the entry
remains `WORKING` projects `FLAT_ENTRY_ACTIVE` with `entryCanIncreaseExposure: true`, not `CLOSED`.
A later 1.25 entry fill produces cumulative entry 4, exited 2.75, open 1.25, and
`PARTIALLY_EXITED`. Any newly uncovered entry quantity must go through a new protection submission
and acknowledgement baseline before subsequent exit projection; Task 025B continuation safety is
unchanged. Once the entry is fully filled or canceled and authoritative exits equal all entered
quantity with execution state `EXIT_FILLED`, the position engine projects `CLOSED`.

## Determinism, immutability, and exclusions

The wrapper result is frozen and retains the already frozen position-engine projection and exposure.
It never mutates either upstream lifecycle result or its embedded attempt. Equal inputs, including
duplicate replays, produce equal results across fresh projector instances. No clock, randomness, or
memory-dependent correctness exists; `executionAsOf` remains owned by Task 026A and authoritative
execution history.

Projection performs no adapter, broker, registry, repository, database, persistence, reconciliation,
submission, cancellation, provider, or network operation. Historical replay and live ingestion use
isolated upstream engines and infrastructure but produce equal position snapshots at equivalent
authoritative checkpoints, and each projection adds zero external calls or durable records.

V1 performs no multi-position aggregation, netting, market valuation, leverage, margin, average
price, cost basis, fee, commission, funding, tax, or realized/unrealized PnL calculation. Financial
accounting remains deferred to Task 027.
