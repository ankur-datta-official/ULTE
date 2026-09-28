# Authoritative trade cost accounting domain V1

## Purpose and boundary

`@ulte/trade-cost-accounting-engine` purely projects an authoritative monetary cost ledger for one
`ExecutionAttempt`. Each supplied event is already authoritative: this domain records explicit
charges and credits and never derives them from quantity, price, market value, trade notional,
percentages, fee rates, funding rates, borrow rates, or broker schedules.

Task027A's `projectRealizedTradeAccounting` is called once and remains the authority for validating
execution history and for execution identity, instrument identity, PnL currency, execution
accounting as-of time, FIFO accounting, and `PositionExposure`. A Task027A rejection is wrapped as
`REALIZED_ACCOUNTING_REJECTED` with the exact rejection object, including a nested position
rejection when present. The successful cost snapshot preserves the exact Task027A accounting and
position-exposure references.

## Authoritative cost events

`TRADE_COST_EVENT_V1` supports `COMMISSION`, `EXCHANGE_FEE`, `BROKER_FEE`, `FUNDING`, and
`BORROW_COST`. The cost type is classification and provenance only; it does not select arithmetic.
Every event has an explicit `DEBIT` or `CREDIT` effect and a strictly positive exact-decimal monetary
amount. A debit is money charged to the trade. A credit is money credited or rebated to the trade;
credits are never represented as negative event amounts.

Every event is canonically revalidated before aggregation and must match Task027A's execution
attempt ID, instrument ID, and PnL currency exactly. V1 performs no FX conversion. An event's
`effectiveAt` may equal but cannot precede the attempt's `preparedAsOf`. It need not be at or after
the current execution-accounting boundary, so entry-time costs remain valid after later fills.
Post-close settlement costs are also valid and do not reopen or reclassify the upstream position.

Duplicate cost-event IDs fail closed even when their payloads are identical. Distinct events at the
same time are valid. Accepted events are ordered canonically by `effectiveAt` ascending and then
`costEventId` ascending, making input array order immaterial.

## Exact totals and as-of semantics

The immutable `TRADE_COST_ACCOUNTING_V1` snapshot derives only:

```text
grossDebitCostAmount  = sum(DEBIT event amounts)
grossCreditCostAmount = sum(CREDIT event amounts)
netCostAmount         = grossDebitCostAmount - grossCreditCostAmount
```

A positive net cost is a cost burden; zero means debits and credits offset; a negative value is a
net credit or rebate. `netCostAmount` is cost accounting and is **not net trade PnL**. No-event
snapshots use canonical `0` for all three totals and an empty frozen ledger.

`executionAccountingAsOf` is the exact Task027A `accountingAsOf` value. `costAccountingAsOf` is the
later of that boundary and the latest accepted cost-event time, or the execution boundary when no
events exist. Neither timestamp is caller-overridable and no wall clock is read.

## Determinism and deferred scope

Canonical events, the canonical event array, snapshot, and result are frozen. Inputs and upstream
objects are not mutated or rebuilt. Equal inputs produce equal output across repeated calls and
fresh engine instances. Production code performs no broker, adapter, repository, persistence,
database, network, market-subscription, reconciliation, submission, protection, cancellation, or
audit operation.

Deferred scope includes realtime provider cost binding, broker fee schedules, maker/taker rate
calculation, slippage and execution-quality attribution, taxes, FX conversion, net trade
performance, account or portfolio costs, and persistence/reporting.
