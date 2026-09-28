# Deterministic realtime realized accounting projection V1

## Purpose and trust boundary

`@ulte/realtime-trade-accounting-engine` is the pure Task 027B boundary immediately after the
realtime entry-fill and exit-fill lifecycles. Its input explicitly identifies `ENTRY_FILL` or
`EXIT_FILL`, carries the corresponding public lifecycle result, and carries the canonical
`LinearInstrumentSizingSpec`. It accepts no independent execution attempt, position exposure, fill
history, quantity, direction, realized PnL, FIFO basis, or accounting time.

For actionable results, the authoritative `ExecutionAttempt` is read only from the successful
upstream result. Entry `FILL_APPLIED` and `DUPLICATE_FILL` and exit `EXIT_FILL_APPLIED` and
`DUPLICATE_EXIT_FILL` are actionable. Entry `FILL_REJECTED` and `NO_FILL_PROCESSING`, and exit
`EXIT_FILL_REJECTED` and `NO_EXIT_FILL_PROCESSING`, return `NO_ACCOUNTING_PROJECTION`. The outer
status is checked first, so attempt-looking diagnostics on rejected results cannot cross the trust
boundary.

## Sole accounting authority

Every actionable result calls `projectRealizedTradeAccounting` with the embedded attempt and the
unchanged canonical sizing specification. Task 027A remains the sole owner of position-exposure
delegation, history validation, chronology, direction, FIFO matching, gross realized PnL, remaining
basis, and `accountingAsOf`. Task 027B performs no financial arithmetic and creates no alternate
multiplier or valuation model.

An actionable lifecycle whose authoritative attempt or sizing specification is rejected produces
`REALIZED_ACCOUNTING_REJECTED`. The exact Task 027A reason and rejection object, including a nested
position-exposure rejection when present, are preserved unchanged. This remains distinct from a
nonactionable upstream lifecycle.

## Replay, immutability, and side effects

Exact entry and exit duplicates carry the current authoritative attempt and replay it through Task
027A. The same attempt and sizing specification therefore produce the same snapshot; duplicate exits
cannot realize PnL twice. There is no cache, fill-ID set, previous snapshot, cumulative PnL, FIFO lot
state, clock, randomness, or environment-dependent behavior in this package.

The realtime wrapper is frozen and retains Task 027A's already immutable accounting or rejection
result without cloning or mutation. Projection does not mutate the upstream result, embedded attempt,
or sizing specification. It performs no adapter, broker, repository, database, persistence, audit,
network, reconciliation, submission, protection, cancellation, or close operation. Historical replay
and live ingestion therefore produce equal accounting at equivalent authoritative checkpoints, and
the projection itself adds zero external calls or durable records.

V1 reports gross realized PnL only. Unrealized and net PnL, fees and commission, funding and swap,
tax, FX conversion, portfolio aggregation, account equity, and persistence/reporting are deferred.
