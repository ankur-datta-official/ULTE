# Authoritative trade performance snapshot domain V1

## Purpose and boundary

`@ulte/trade-performance-engine` purely projects one authoritative `ExecutionAttempt` V2 into one
immutable gross trade-performance snapshot. It accepts only the execution attempt, the canonical
accounting specification, and one canonical `ValuationMark`. It accepts no caller-supplied exposure,
direction, quantities, open basis, realized PnL, unrealized PnL, total PnL, or as-of time.

For the standalone API, Task 028A's `projectUnrealizedTradeValuation` is the sole upstream call. A
canonical Task 028A valuation is always the sole source of both Task 027A's gross realized PnL and
Task 028A's gross unrealized PnL. Task 027A remains the exclusive realized-accounting, FIFO,
chronology, open-basis, direction, quantity, and position-exposure authority. This package never
calls Task 027A directly and never recreates its work.

The public `projectTradePerformanceFromValuation` composition path accepts exactly one complete,
canonical `UnrealizedTradeValuation` produced by Task 028A or an authoritative wrapper such as Task
028B. It is not a constructor for caller-selected PnL fields. It repeats the same Task 029A coherence
checks, aggregation, reference pass-through, and freezing without rerunning valuation. The standalone
`projectTradePerformanceSnapshot` API remains unchanged: it invokes Task 028A exactly once and then
uses this composition path.

## Exact gross aggregation

V1 introduces exactly one financial aggregate:

```text
grossTotalPnl = grossRealizedPnl + grossUnrealizedPnl
```

The addition uses `@ulte/exact-decimal`'s `addDecimal`. There is no floating point, division,
rounding, weighted average, or new price/quantity valuation math. LONG and SHORT economics remain
entirely upstream-owned.

`grossTotalPnl` is the realized gross PnL plus the currently marked gross unrealized PnL for one
authoritative execution attempt. It is not account equity, NAV, cash or settlement balance, broker
statement or tax PnL, net PnL, portfolio PnL, or margin PnL.

## Lifecycle semantics

- `NO_EXPOSURE` has realized, unrealized, and total PnL of exact zero.
- `OPEN` may retain prior realized PnL and adds the current open-basis unrealized PnL.
- `PARTIALLY_EXITED` combines exited FIFO gross PnL with the marked remaining FIFO basis.
- `FLAT_ENTRY_ACTIVE` retains its upstream state, has zero unrealized PnL, and total equals realized.
- `CLOSED` has zero unrealized PnL and total equals realized.
- A later entry receives only the fresh basis owned by Task 027A; prior realized PnL remains included.

The snapshot's `accountingAsOf` is Task 028A's accounting boundary, which comes from Task 027A and
ultimately the position projection. `valuationAsOf` is Task 028A's explicit mark time. The snapshot
adds no creation, generation, processing, or wall-clock timestamp.

## Rejections, identity, and coherence

A Task 028A rejection is preserved as the exact nested valuation-projection result, including nested
Task 027A accounting and PositionExposure rejection objects. V1 performs only nonduplicative
cross-snapshot coherence checks over execution identity, instrument identity, open quantity,
accounting time, and nested exposure quantity. Impossible incoherence fails closed and is never
repaired.

The Task 028A valuation, its Task 027A accounting snapshot, and its PositionExposure are passed
through by reference. The wrapper result and performance snapshot are frozen; all nested upstream
objects retain their upstream immutability. Inputs are not mutated.

## Determinism and exclusions

Equal execution attempt, accounting specification, and mark inputs produce equal results across
repeated calls and fresh engines. Production projection reads no clock, environment, or randomness
and performs no broker, adapter, repository, persistence, database, network, audit, subscription,
reconciliation, submission, protection, cancellation, or other side effect.

V1 intentionally contains no net PnL, fees, commissions, exchange charges, funding, swap, borrow
cost, tax, withholding, FX, slippage attribution, ROI, ROE, returns, basis points, R-multiple, profit
factor, win rate, drawdown, MFE, MAE, Sharpe, Sortino, trade statistics, multi-attempt aggregation,
portfolio performance, realtime performance projection, account balances, or account equity.

Deferred work includes cost accounting; net realized, unrealized, and total PnL; fees, funding,
borrow costs, tax, and FX; return and trade statistics; portfolio performance; and the Task 029B
realtime performance projection.
