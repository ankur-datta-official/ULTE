# Authoritative realized trade accounting domain V1

## Purpose and boundary

`@ulte/trade-accounting-engine` purely projects one authoritative `ExecutionAttempt` V2 into one
immutable `RealizedTradeAccounting` V1 snapshot. It reports gross realized PnL only. It does not
calculate unrealized or net PnL, fees, commissions, funding, swap, tax, slippage attribution, FX
conversion, equity, margin, leverage, liquidation, settlement adjustments, or portfolio aggregates.
Task 027B may add realtime or historical orchestration; V1 has no orchestrator.

The attempt-owned `processedFills` and `processedExitFills` histories are the only fill provenance.
Callers cannot provide separate fill arrays, quantities, direction, exposure state, realized PnL, or
as-of time. Projection first calls `projectPositionExposure(attempt)`. A position rejection becomes a
typed `POSITION_EXPOSURE_REJECTED` result containing the original position rejection. Direction,
open quantity, lifecycle state, and `accountingAsOf` (the position `executionAsOf`) remain owned by
the position domain.

## Economics and exact arithmetic

V1 accepts the existing canonical `LinearInstrumentSizingSpec` and supports only
`LINEAR_PRICE_PNL`. Its instrument must equal the attempt instrument and its quantity unit must be
coherent with the attempt. The output records the canonical PnL currency and
`pnlValuePerPriceUnitPerQuantity`; it performs no FX conversion.

For LONG exposure, each realized match uses:

```text
(exitPrice - entryPrice) × matchedQuantity × pnlValuePerPriceUnitPerQuantity
```

For SHORT exposure, each realized match uses:

```text
(entryPrice - exitPrice) × matchedQuantity × pnlValuePerPriceUnitPerQuantity
```

`@ulte/exact-decimal` owns the shared BigInt-coefficient exact compare, addition, subtraction,
non-negative subtraction, and multiplication operations. Accounting performs no division,
floating-point financial arithmetic, rounding, tolerance, or currency-minor-unit quantization.
Settlement rounding is outside V1. Exact output is normalized to plain decimal notation, including
canonical `0` rather than `-0`.

## FIFO replay and chronology

The accounting method is `FIFO_V1`. Each entry fill appends an auditable basis lot containing its
fill ID, exact entry price, original and remaining quantities, and fill time. Each exit consumes the
oldest available lots first and emits one immutable realized match per entry/exit pairing. A match
contains entry and exit fill IDs, authoritative exit leg, matched quantity, both prices, exact gross
realized PnL, and both fill times. Only unconsumed lots appear in `openBasisLots`.

ExecutionAttempt V2 has separate append-only entry and exit histories but no authoritative global
fill sequence. V1 therefore preserves source order within each history and merges kinds by
authoritative fill timestamp. A timestamp shared by an entry and exit is rejected as
`AMBIGUOUS_FILL_CHRONOLOGY`; V1 never invents entry-first or exit-first ordering. An exit occurring
before enough basis exists is rejected rather than repaired or clamped.

An early exit may fully consume all currently entered basis while the entry remains active. The
snapshot then has `FLAT_ENTRY_ACTIVE` exposure and an empty basis. A later entry fill creates a new
FIFO lot at its own price; previously consumed basis cannot contaminate it. A terminal `CLOSED`
exposure must have no open basis.

## Coherence, determinism, and side effects

Projection validates exact entry- and exit-history totals against the attempt aggregates, canonical
positive fill quantities and prices, fill/attempt identity, entry adapter order, exit side, source
chronology, globally unambiguous fill IDs, available FIFO basis, and final open-basis quantity
against `PositionExposure.openQuantity`. Malformed histories fail closed with explicit rejection
reasons.

The attempt, fill histories, valuation spec, and position result are never mutated. Successful and
rejected results are frozen; successful snapshots, arrays, realized matches, and open lots are also
frozen. Equal attempt/spec inputs always produce equal output, including across fresh engine
instances. Production accounting reads no clock or environment, creates no random identity, and
performs no broker, adapter, registry, repository, persistence, database, network, reconciliation,
submission, protection, cancellation, or position transition operation.
