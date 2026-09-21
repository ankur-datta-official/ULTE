# Execution policy and adapter contract V1

## Purpose and boundary

`@ulte/execution-engine` consumes only an authoritative `EXECUTION_PLAN_READY` result and defines how that immutable plan is submitted and tracked through a broker-neutral adapter. Execution preparation decides whether a Trade Intent is currently representable; execution policy preserves its entry, stop, target, quantity, risk, and reward/risk values without recalculation or normalization. V1 contains no broker implementation, credential handling, persistence, retry loop, network call, or external side effect.

Adapter submission methods are asynchronous type contracts because real broker I/O is asynchronous; the execution engine itself does not call them or perform any I/O. Entry submission resolves only to an acknowledgement or rejection. Fills are separate asynchronous execution events applied later through `applyEntryFill` after entry acknowledgement, never `submitEntry` return values.

## Attempt and operation identity

An attempt is created without submitting anything. Its identity is a deterministic, fixed-order, length-prefixed encoding of the schema version, plan and intent identities, instrument, side, quantity, entry, stop, and target. Entry submission has a separate stable key derived from the attempt and `ENTRY_SUBMISSION`; every retry of that logical operation reuses the same key and cannot create a second entry identity. Concrete adapters must map stable keys to venue client-order identity or provide durable local deduplication. This package intentionally provides no storage.

Protection and cancellation use separate deterministic operation keys. A protection key includes the target cumulative protected quantity, so a retry of `0 -> 0.4` is identical while later coverage from `0.4 -> 0.7` is distinct. The protection request's `protectedQuantity` is the new incremental coverage; `targetCumulativeProtectedQuantity` is the post-acknowledgement total.

## Entry and fill lifecycle

Attempts begin `READY_FOR_ENTRY_SUBMISSION` with zero filled and protected quantity. Entry submission moves to `ENTRY_SUBMISSION_PENDING`; a matching broker acknowledgement establishes the opaque adapter order ID and moves to `ENTRY_WORKING`, while a matching rejection becomes `REJECTED` and preserves the opaque adapter reason. V1 does not accept acknowledgement-and-fill as an atomic shortcut: fills require a previously acknowledged working order.

Each fill carries caller-supplied identity, exact quantity and price, and UTC Unix milliseconds. Fill quantities are accumulated with BigInt-backed fixed-scale decimal arithmetic. The same fill ID and facts are idempotently ignored; conflicting reuse is rejected. Overfills are `DATA_REJECTED / OVERFILL_DETECTED`. Actual fill facts remain separate from the plan's analytical entry reference and do not trigger risk or reward/risk recalculation.

## Protection and adapter safety

Protection is coverage of confirmed entry exposure, never an independent opening order. The policy protects all currently uncovered fills and never permits cumulative protected quantity above cumulative filled quantity. Unprotected exposure is always exposed as `unprotectedFilledQuantity`.

Mode selection is deterministic: native bracket capability has priority; otherwise managed protection requires both close-only exit semantics and partial-fill reporting; all other capability sets are `EXECUTION_NOT_SUPPORTED / ADAPTER_NOT_SAFE_FOR_PROTECTION`. Native capability declaration alone does not make protection active. In both abstract modes, V1 records coverage only after a matching protection acknowledgement. A protection rejection makes the attempt `FAILED`, preserves its reason, and leaves uncovered exposure visible.

## Cancellation and partial-cancel safety

Only a working entry with remaining quantity can be canceled, and the adapter must declare cancellation support. Cancellation retries reuse one deterministic key. A zero-fill acknowledgement becomes `CANCELED`. A partial-fill acknowledgement becomes `ENTRY_CANCELED_WITH_EXPOSURE`; filled and unprotected quantities remain present, and protection may still be requested for that exposure. A fully filled entry cannot be canceled.

## Time, validation, and immutability

External events must match the attempt and relevant adapter order or operation identity. Event times are explicit caller-supplied Unix milliseconds and cannot move backward from the last accepted execution event. Equal timestamps are accepted because event IDs and operation IDs provide deterministic identity. Duplicate fills are recognized before monotonic-time validation, so delivery of an already accepted event remains idempotent.

All constructors and transitions are pure. Attempts, capability descriptors, generated requests, constructed events, and public arrays are frozen. Every accepted transition returns a new attempt and never mutates its predecessor. Public decimal outputs use plain notation without floating-point conversion or exponent notation.
