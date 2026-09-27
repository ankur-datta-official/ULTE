# Deterministic real-time protection acknowledgement lifecycle V1

## Architectural position and authoritative input

`@ulte/realtime-execution-protection-lifecycle-engine` follows Task 023's controlled durable
protection submission. It is a stateless, provider-neutral projection layer that accepts the actual
`RealtimeExecutionProtectionResult`. Only the outer `PROTECTION_CONFIRMED` status is actionable;
`NO_PROTECTION_ACTION`, `PROTECTION_SUBMISSION_BLOCKED`, `PROTECTION_REJECTED`,
`RECONCILIATION_REQUIRED`, and `DURABLE_PROTECTION_CONTROL` return
`NO_PROTECTION_LIFECYCLE` without requiring an attempt or observation context.

The outer status is authoritative. A `PROTECTION_PENDING` attempt inside any non-confirmed result
does not prove that broker protection exists. Conversely, a confirmed durable result must carry its
actual normalized `ProtectionAcknowledgement`. A replayed durable record without that payload fails
closed as `CONFIRMED_PROTECTION_ACKNOWLEDGEMENT_MISSING`; the acknowledgement is never synthesized
from the request, record, quantity, or request ID.

## Coherence and existing transition ownership

Before projection, the engine requires the Task 023 execution attempt, policy result, pending
`ProtectionRequest`, durable operation, fingerprint, confirmed record, and acknowledgement to agree
on the identities they expose. This includes execution-attempt ID, protection-request ID,
idempotency key, instrument, protection mode, and exact policy request. A separately supplied current
attempt must be the same immutable pending lifecycle snapshot, including static execution identity,
entry/exit fill histories, acknowledged-protection provenance, protection request, quantities, state,
and last event time. Unrelated durable records or
substituted attempts fail closed without lifecycle mutation.

The package delegates the acknowledgement to the existing execution-engine
`acknowledgeProtection` transition. That transition remains authoritative for request matching,
decimal-safe cumulative protected quantity, under/over/inconsistent quantity rejection, monotonic
event chronology, removal of the pending request, derived unprotected quantity, and lifecycle state.
Task 024 performs no protection arithmetic and never clamps a quantity.

For a partial entry fill, the existing request's cumulative target becomes `protectedQuantity` and
the attempt returns to `ENTRY_PARTIALLY_FILLED` with zero currently uncovered quantity. A later fill
can produce a new incremental request through existing policy, which Task 024 can acknowledge in the
same way. For a fully filled entry, exact complete coverage produces the existing `PROTECTED` state.
`MANAGED_PROTECTION` and `NATIVE_BRACKET` are preserved and use the same current V1 transition.

## Observation time, chronology, and replay

Actionable input requires caller-supplied `observationAsOf`, validated as `UnixMs`; no wall clock is
read. The acknowledgement may equal but cannot exceed the observation boundary. It also cannot
precede Task 023's `protectionAsOf`. The existing transition separately rejects an acknowledgement
older than the attempt's last accepted execution event. Events are never sorted.

The Task 025A execution model appends immutable acknowledged-protection provenance when this
transition succeeds. It still defines no special protection acknowledgement duplicate/conflict
status: replaying the same confirmed input from the same pending snapshot deterministically produces
the same protected snapshot and provenance without process-local deduplication. Applying it to an
already-updated snapshot is rejected as a current-attempt mismatch, and a changed quantity is
rejected by `acknowledgeProtection`; neither path increments coverage or mutates its input. Task 024
claims deterministic replay-safe projection, not durable ingestion or exactly-once processing.

All public results and resulting attempts are frozen. Rejection is atomic: the Task 023 result,
request, acknowledgement, current attempt, and fill history remain unchanged.

## Boundary and integration

A `PROTECTION_ACCEPTED` acknowledgement is not an exit fill. It does not mean that a stop or target
was hit, a trade exited, a position closed, or profit/loss exists. Task 024 stops after the existing
protection acknowledgement transition.

The integration test independently drives historical replay and normalized live ingestion through
shared candle, analysis, decision, preparation, durable SANDBOX entry submission, normalized entry
fill, durable protection submission, and this projection. Isolated adapters, repositories, and
projectors produce equal identities and final protection lifecycle state.

This package has no adapter registry, durable repository, reconciliation, provider/network, database,
entry/protection submission, cancellation/modification, exit-fill, position, fee, or PnL behavior.
Protection rejection projection, provider ingestion, exit fills, protection modification/cancellation,
position closure, and accounting remain deferred to Task 025 or later explicitly specified work.
