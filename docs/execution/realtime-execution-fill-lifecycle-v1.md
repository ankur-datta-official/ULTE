# Deterministic real-time execution fill lifecycle V1

## Architectural position

`@ulte/realtime-execution-fill-engine` follows Task 021's controlled durable entry submission. It is
a provider-neutral, side-effect-free projection layer between a confirmed entry acknowledgement and
the existing execution lifecycle. It accepts the actual `RealtimeExecutionSubmissionResult`, gates
on `SUBMISSION_CONFIRMED`, initializes the acknowledged attempt, and applies an existing normalized
`FillEvent` through `applyEntryFill`.

An acknowledgement is not a fill. A `SUBMISSION_ACCEPTED` acknowledgement moves the existing attempt
from submission-pending to working through `acknowledgeEntrySubmission`; it never changes filled
quantity and leaves `processedFills` empty. Task 022 neither derives a fill from acknowledged order
quantity nor invents partial, full, or position state.

## Submission gating and acknowledgement ownership

`NO_SUBMISSION`, `SUBMISSION_BLOCKED`, `SUBMISSION_REJECTED`, `RECONCILIATION_REQUIRED`, and
`DURABLE_SUBMISSION_CONTROL` produce `NO_FILL_PROCESSING`. In particular, an uncertain durable result
cannot establish whether an order exists and is never treated as fill-safe.

A confirmed result must contain the actual normalized `EntryAcknowledgement`. Durable replay may
return a confirmed record without the original acknowledgement; Task 022 rejects that input rather
than reconstructing or fabricating an acknowledgement. The acknowledgement must match the execution
attempt, submission idempotency key, durable record, and adapter order ID, and it may not predate
`submissionAsOf`.

## Normalized fill ownership and identity

Provider adapters or later ingestion infrastructure own conversion from venue payloads into the
existing `@ulte/execution-engine` `FillEvent`. This package parses no REST, WebSocket, FIX, exchange,
broker, or platform payload. `createFillEvent` remains the constructor and validates stable fill ID,
attempt ID, adapter order ID, positive exact-decimal quantity and price, and Unix-millisecond time.

The existing `fillId` is the sole fill identity. `applyEntryFill` treats an identical repeated fill
as `DUPLICATE_EVENT_IGNORED`, without accumulating it again. Reusing the ID with a meaningfully
different attempt/order, quantity, price, or time is `DUPLICATE_FILL_CONFLICT` and leaves the supplied
attempt unchanged. Task 022 introduces no second fill identity or hidden deduplication state.

The caller supplies the current immutable `ExecutionAttempt`. Its plan, trade-intent, candidate,
instrument, side, requested quantity, prices, submission idempotency key, and acknowledged adapter
order identity must remain coherent with Task 021. A fill's attempt and adapter-order identities are
then checked by the existing transition.

## Exact lifecycle and chronology

`applyEntryFill` remains authoritative for exact-decimal cumulative filled quantity, remaining
entry state, last fill price, processed-fill retention, partial-to-full lifecycle transitions,
overfill detection, duplicate handling, and event chronology. Task 022 performs no price or quantity
arithmetic. V1's existing execution state exposes the last fill price, not an average fill price.

Partial fills accumulate exactly and retain `ENTRY_PARTIALLY_FILLED` until cumulative quantity equals
the requested entry quantity. Equality transitions to `ENTRY_FILLED`; Task 022 stops there. A
pre-terminal fill that exceeds requested quantity is rejected as `OVERFILL_DETECTED`; a new distinct
fill after the terminal state is rejected as `INVALID_TRANSITION`. Values are never clamped or
rounded.

Every application has an explicit caller-supplied `observationAsOf`, validated as `UnixMs`. A fill
with `filledAt > observationAsOf` is rejected before the lifecycle transition. Equality is accepted.
The existing attempt chronology rejects fills earlier than its last acknowledged or fill event. No
wall clock or sorting is used, and independently identified fills remain in caller arrival order.

## Atomicity, immutability, and replay

Initialization and fill application are pure deterministic functions. Results are frozen and the
Task 021 result, acknowledgement, current attempt, normalized fill, and processed-fill array are not
mutated. Invalid, conflicting, future, mismatched, and overfill events return no updated lifecycle
state. There are no process-global maps, timers, random identities, or background work.

Task 022 claims deterministic projection, not durable or exactly-once ingestion:

```text
same confirmed submission + same initial attempt + same normalized fill sequence
= same final execution lifecycle
```

After restart, a caller can reproduce the state by replaying an authoritative fill history or by
supplying an authoritative lifecycle snapshot. Persistence remains a later concern.

## Integration and deferred work

The integration test independently drives historical replay and normalized live trade ingestion
through candle, analysis, decision, preparation, Task 021 durable SANDBOX submission, real
acknowledgement projection, and the same normalized fill event. It compares upstream cycle and plan
identities, attempt and submission identities, acknowledgement, processed fill identity, exact final
quantity, lifecycle state, and last fill price. Each branch has its own fake adapter and in-memory
durable repository.

Task 022 performs no entry/protection submission, cancellation, order modification, reconciliation,
broker-status query, provider call, persistence, position accounting, realized or mark-to-market PnL,
or LIVE enablement. It never invokes an adapter registry. Protection orchestration, cancellation,
provider event normalization, durable fill ingestion, reconciliation, and position/PnL ledgers remain
explicitly deferred.
