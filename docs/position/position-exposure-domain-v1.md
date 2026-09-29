# Authoritative position exposure domain V1

## Boundary and identity

`@ulte/position-engine` answers how much authoritative executed exposure remains open. The execution
domain continues to answer what happened in the broker lifecycle; later accounting will answer the
monetary outcome. The position engine performs no execution transition and calculates no PnL.

V1 maps one `ExecutionAttempt` V2 to one independent immutable `PositionExposure`. Its authoritative
link is `executionAttemptId`; there is no separate random position ID, cross-attempt netting,
account aggregation, symbol merging, or lot matching. BUY entry maps to `LONG`, SELL entry maps to
`SHORT`, and the exit side must be the opposite authoritative side.

## Quantity semantics

`requestedQuantity` is the attempt quantity, `filledEntryQuantity` is cumulative authoritative entry
execution, and `exitedQuantity` is cumulative authoritative exit execution. `openQuantity` is exactly:

```text
filledEntryQuantity - exitedQuantity
```

The implementation uses decimal-string parsing and bigint coefficients. It never uses binary
floating-point conversion, rounding, tolerance, or clamping. An exit greater than entered quantity,
or entered quantity greater than requested quantity, is rejected.

`protectedQuantity` remains historical cumulative acknowledged protection coverage in the execution
aggregate. Exits do not decrement it. PositionExposure intentionally omits it rather than presenting
it as current remaining protected open exposure. Projection validates that protection does not exceed
filled entry and that the execution aggregate's unprotected quantity remains coherent.

## Exposure lifecycle

- `NO_EXPOSURE`: cumulative filled entry is zero, including a working zero-fill entry. Exposure never existed.
- `OPEN`: open quantity is positive and no authoritative exit has occurred.
- `PARTIALLY_EXITED`: open quantity is positive and authoritative exited quantity is positive.
- `FLAT_ENTRY_ACTIVE`: exposure existed, current open quantity is zero, and entry status is `WORKING`.
- `CLOSED`: exposure existed, open quantity is zero, entry status is `FILLED` or `CANCELED`, and execution state is authoritatively `EXIT_FILLED`.

Only `WORKING` means V1 entry can increase exposure. A fill/protect/exit of 2.75 against a working
entry for 10 is therefore `FLAT_ENTRY_ACTIVE`, not closed. If a later entry fill raises cumulative
entry to 4 while cumulative exits remain 2.75, open quantity becomes 1.25 and state becomes
`PARTIALLY_EXITED`. A canceled partial entry remains `OPEN` or `PARTIALLY_EXITED` while exposure
remains, and becomes `CLOSED` only after authoritative terminal exit. Zero open quantity alone never
implies closure, and `NO_EXPOSURE` is never collapsed into `CLOSED`.

## Validation, time, and determinism

Projection accepts only `EXECUTION_ATTEMPT_V3` with ready attempt status, recognized entry/order
states, opposite BUY/SELL sides, valid exact-decimal quantities, entry not exceeding requested,
exit not exceeding entry, protection not exceeding entry, and coherent unprotected quantity. A flat
attempt whose entry cannot increase must carry the execution domain's terminal `EXIT_FILLED` state;
otherwise projection fails closed rather than inventing a position state.

`executionAsOf` is `lastExecutionEventAt` when present and otherwise the immutable plan
`preparedAsOf`. No wall clock is read. Projection has no local state, randomness, I/O, provider,
network, repository, broker, or orchestration behavior. The snapshot and result are frozen, the
source attempt is never mutated, and equal inputs produce equal outputs across fresh engine instances.

## Explicit exclusions

V1 has no FIFO/LIFO or specific-lot matching, average prices, cost basis, realized or unrealized PnL,
gross/net profit, reward multiple, fees, commission, funding, swap, tax, FX conversion, market price
or valuation, equity impact, leverage, margin, or liquidation calculation. Task 026B may add realtime
position projection orchestration without duplicating this domain. Task 027 may introduce separate
financial/PnL accounting.
