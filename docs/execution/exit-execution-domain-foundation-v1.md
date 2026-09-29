# Authoritative exit execution domain foundation V1

## Why the real-time projection was blocked

Task 025 could not safely project exit fills because the execution aggregate had only entry-side
`FillEvent` semantics. It retained neither acknowledged protection identity nor exit quantity,
deduplication, coverage, chronology, or terminal rules. Task 025A establishes those provider-neutral
domain primitives in `@ulte/execution-engine`; a real-time Task 025B projector remains deferred.

## Authoritative exit evidence and identity

`FillEvent` (`kind: "FILL"`) remains exclusively an entry fill. `ExitFillEvent`
(`kind: "EXIT_FILL"`) is structurally distinct and is created by `createExitFillEvent`. It requires
the execution-attempt ID, acknowledged protection-request ID, explicit expected exit side, explicit
`PROTECTIVE_STOP` or `PROFIT_TARGET` leg, fill ID, positive exact-decimal quantity and price, and
Unix-millisecond fill time.

The event is an actual normalized provider execution. No candle, stop/target price, market price,
acknowledgement, or elapsed-time input can synthesize it. The leg is authoritative metadata: a stop
fill remains a stop at a target-like price, and a target fill remains a target at a stop-like price.
Price is execution evidence only and never determines the leg.

## Acknowledged protection provenance

Every successful `acknowledgeProtection` appends an immutable `AcknowledgedProtection` record that
retains the exact frozen `ProtectionRequest` and `ProtectionAcknowledgement`. This preserves request
identity, idempotency key, mode, exit side, incremental quantity, cumulative coverage ceiling,
stop/target prices, and acknowledgement time after the pending request is cleared. Exit fills must
reference one of these acknowledged requests; quantity alone is insufficient.

Both `MANAGED_PROTECTION` and `NATIVE_BRACKET` use the same provenance and exit arithmetic. No
provider-specific identifier or behavior is introduced.

## Cumulative lifecycle semantics

The aggregate keeps three distinct gross cumulative values:

- `filledEntryQuantity`: authoritative entry execution.
- `protectedQuantity`: authoritative acknowledged cumulative protection; exits do not reduce it.
- `exitedQuantity`: authoritative exit execution.

`processedFills` and `processedExitFills` are separate append-only ledgers. Exact partial exits are
supported using the existing decimal-safe arithmetic. An exit may not make cumulative exited
quantity exceed the referenced request's cumulative coverage ceiling, total protected quantity, or
total filled entry quantity. Excess is rejected; values are never clamped.

These exit fields originally changed the persisted/public aggregate to `EXECUTION_ATTEMPT_V2`.
The current `EXECUTION_ATTEMPT_V3` additionally requires the upstream account-currency provenance;
as in prior versions, the current version participates in deterministic attempt and operation identity.

After an early exit, later entry fills remain valid while the entry order is `WORKING`. For example,
fill/protect/exit 2.75, then fill another 1.25, leaves filled 4, protected 2.75, and exited 2.75.
The existing cumulative protection policy correctly requests the newly uncovered 1.25; after its
acknowledgement, a later authoritative exit can reach cumulative 4.

## State and terminal rules

Any nonzero exit that is not terminal derives `EXIT_PARTIALLY_FILLED`. `EXIT_FILLED` is derived only
when the entry order can no longer increase exposure (`FILLED` or `CANCELED`) and cumulative exited
quantity exactly equals cumulative filled entry quantity. Fully exiting the currently filled 2.75
while an entry order for 10 remains `WORKING` is therefore non-terminal.

Safety-critical failure, rejection, cancellation-pending, and protection-pending states retain
precedence over exit presentation. Historical exit fields remain authoritative under those states.
Cancellation with no exit retains the existing cancellation states.

## Deduplication, chronology, and leg races

An identical exit payload with an already processed exit `fillId` is
`DUPLICATE_EVENT_IGNORED`. Reusing that exit ID with any changed meaningful field is
`DUPLICATE_EXIT_FILL_CONFLICT` and leaves the attempt unchanged. Entry and exit fill IDs live in
separate domains, so an equal ID across the two ledgers is not a duplicate.

Exit time may equal but may not precede `lastExecutionEventAt`. Events remain in accepted arrival
order and are never sorted. Stop and target fills are applied as authoritative events in that order;
the engine does not guess which leg should have won or cancel the opposite leg. Once exposure is
consumed, a later positive fill is rejected by the normal over-exit guard.

## Boundary and deterministic replay

`applyExitFill` is pure, immutable, and replay-deterministic. It performs no network, broker,
persistence, reconciliation, cancellation/modification, position/account aggregation, PnL, fee,
commission, tax, or balance behavior. The exit price is retained only as evidence. Task 025B may
later orchestrate authoritative normalized exit events into this transition; it must not recreate
these rules or infer fills.
