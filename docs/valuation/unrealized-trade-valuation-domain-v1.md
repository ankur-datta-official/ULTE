# Authoritative unrealized trade valuation domain V1

## Purpose and boundary

`@ulte/trade-valuation-engine` purely values the current open FIFO basis of one authoritative
`ExecutionAttempt` V2. It first calls Task027A's `projectRealizedTradeAccounting`; Task027A remains
the sole owner of direction, exposure state, open quantity, chronology, FIFO matching, remaining
basis, realized PnL, canonical linear economics, authoritative identities, and `accountingAsOf`.
An accounting rejection is returned unchanged as a nested typed projection, including any nested
position-exposure rejection.

V1 reports gross unrealized PnL only. It does not calculate new realized PnL, combined or net PnL,
fees, commission, funding, swap, taxes, FX conversion, equity, NAV, margin, leverage, liquidation,
settlement rounding, cross-position netting, or portfolio aggregation.

## Resolved valuation mark

No existing provider-neutral type combined a resolved price with canonical instrument identity and
as-of time, so V1 defines the immutable `VALUATION_MARK_V1` contract: `instrumentId`, positive exact
`markPrice`, and `markAsOf`. `createValuationMark` validates those fields with instrument-model
primitives. It uses no clock, random identity, provider field, or generated valuation ID.

The mark is a policy-neutral input already resolved upstream. This domain does not choose last trade,
bid, ask, midpoint, candle close, an execution-preparation quote, or a broker liquidation mark, and
does not prove the mark's source. The mark instrument must exactly equal the accounting instrument.
The mark must satisfy `markAsOf >= accountingAsOf`; equality is allowed because V1 does not invent
intra-timestamp ordering. Task028B will bind this contract to authoritative historical/live data and
stronger no-lookahead rules.

## FIFO open-basis valuation

The method is `FIFO_OPEN_BASIS_MARK_TO_MARKET_V1`. Every Task027A open basis lot produces exactly one
immutable valuation with `entryFillId`, `entryPrice`, unchanged `remainingQuantity`, `entryFilledAt`,
the resolved `markPrice`, and exact `grossUnrealizedPnl`.

For LONG, each lot is `(markPrice - entryPrice) × remainingQuantity ×
pnlValuePerPriceUnitPerQuantity`. For SHORT, each lot is `(entryPrice - markPrice) ×
remainingQuantity × pnlValuePerPriceUnitPerQuantity`. The total is the exact sum of those lot values.
All financial arithmetic uses `@ulte/exact-decimal`; there is no division, average basis, rounding,
tolerance, or floating-point financial arithmetic.

The projection fail-closes unless lot count and entry identity correspond to Task027A, quantities are
unchanged, their exact sum equals authoritative `openQuantity`, zero quantity has no lots, and the
reported total exactly sums the lot valuations.

## Lifecycle, immutability, and determinism

Fresh `NO_EXPOSURE`, `FLAT_ENTRY_ACTIVE`, and terminal `CLOSED` snapshots have empty open basis and
exact gross unrealized PnL `0`. A partial exit values only the remaining basis. An early full-current
exit removes that basis; a later entry creates a fresh lot and consumed basis never reappears.

The attempt, accounting specification, supplied mark, Task027A result, and basis lots are not mutated.
Results, valuation snapshots, lot arrays, and lot values are frozen; the already-frozen Task027A
snapshot is nested by reference. Equal inputs produce equal output across repeated calls and fresh
engine instances. Production valuation has zero broker, adapter, repository, database, persistence,
network, audit, reconciliation, submission, cancellation, or market-subscription side effects.
