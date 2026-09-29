# Authoritative net R-multiple snapshot V1

## Purpose and prerequisite

`@ulte/trade-r-multiple-engine` answers how many units of a trade's original actual risk are
represented by its current authoritative net performance. Task032-PRE is the prerequisite that
propagates risk denomination into `EXECUTION_ATTEMPT_V3`.

## Risk and performance authorities

The immutable `TRADE_RISK_BASIS_V1` is constructed only from an `ExecutionAttempt` V3.
`actualRiskAmount` becomes `initialActualRiskAmount`; `approvedRiskAmount` is validated but is never
the denominator. `accountCurrency` is the denomination of that risk. `preparedAsOf` becomes
`riskBasisAsOf`, meaning the execution preparation boundary at which the risk basis was frozen for
execution. It is not presented as the original position-sizing observation time.

Task031A `NetTradePerformanceSnapshot.netTotalPnl` is the sole numerator authority. Task032A does not
rerun net, gross, cost, valuation, realized, exposure, or execution domains and does not recalculate
risk from price, quantity, stop distance, or instrument economics.

## Exact representation and currency coherence

Net R is preserved as an exact source ratio:

```text
numerator   = netPerformance.netTotalPnl
denominator = riskBasis.initialActualRiskAmount
```

V1 performs no division, ratio reduction, rounding, or display-decimal selection. It requires
`netPerformance.pnlCurrency === riskBasis.accountCurrency`. Cross-currency inputs fail closed; no FX
rate is accepted, inferred, fetched, or applied.

## Static original risk and evolving performance

One risk basis is reused as market or cost evidence advances. Market-only, cost-only, combined, and
late post-close cost updates may change the numerator but never the denominator or `riskBasisAsOf`.
OPEN, PARTIALLY_EXITED, FLAT_ENTRY_ACTIVE, and CLOSED exposure states are passed through without a
state-specific formula. LONG and SHORT performance use the same composition. A canonical zero net
PnL is valid and remains the exact zero numerator.

The snapshot preserves Task031A's independent `executionAccountingAsOf`, `valuationAsOf`, and
`costAccountingAsOf` clocks. Later valuation or cost evidence need not share the risk-basis boundary.

## Immutability, determinism, and exclusions

Task032A-owned bases, ratios, snapshots, and results are frozen. Nested net performance, risk basis,
and position exposure authorities are preserved by reference. The domain is deterministic,
function-local, and has no broker, repository, network, database, persistence, audit, or execution
side effect.

Deferred scope includes explicit FX-normalized R, decimal/display R, realized or unrealized R, ROI,
expectancy, win rate, profit factor, portfolio analytics, persistence/reporting, and Task032B
realtime projection.
