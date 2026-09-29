# Authoritative net trade performance snapshot V1

## Purpose and authority

`@ulte/net-trade-performance-engine` combines one complete Task029A
`TradePerformanceSnapshot` with one complete Task030A `TradeCostAccounting` snapshot for the same
trade and accounting state. Task029A remains the authority for gross realized, gross unrealized, and
gross total PnL. Task030A remains the authority for gross debit costs, gross credit costs, net cost,
the canonical cost ledger, and its cost-accounting time.

The standalone API establishes those authorities in order. It calls
`projectTradePerformanceSnapshot` once and stops with the exact nested Task029A rejection if gross
performance fails. Only after gross success does it call `projectTradeCostAccounting` once. It
preserves an exact Task030A rejection if cost accounting fails. The two-authority composition API
performs no upstream projection, allowing a later realtime layer to combine authorities it already
has.

## Exact net aggregation

V1 introduces exactly one financial formula:

```text
netTotalPnl = grossTotalPnl - netCostAmount
```

The subtraction uses `@ulte/exact-decimal`. A positive net cost reduces performance, zero leaves it
unchanged, and a negative net cost represents a net credit or rebate and increases performance.
Canonical arithmetic emits `0`, never negative zero. There is no LONG/SHORT arithmetic branch;
directional economics are already reflected by Task029A.

Only `netTotalPnl` is new. The snapshot exposes `grossRealizedPnl`, `grossUnrealizedPnl`,
`grossTotalPnl`, `grossDebitCostAmount`, `grossCreditCostAmount`, and `netCostAmount` as direct
authoritative pass-throughs. V1 deliberately has no `netRealizedPnl`, `netUnrealizedPnl`, realized
cost allocation, or unrealized cost allocation because Task030A does not attribute costs between
closed and open quantities.

## Coherence, provenance, and currency

Before subtraction, composition fail-closes with `NET_PERFORMANCE_INCOHERENT` unless the authorities
agree on attempt, plan, intent, candidate, instrument, PnL currency, execution-accounting time,
realized PnL, filled quantity, exited quantity, open quantity, and the semantic PositionExposure
state. Position direction, sides, execution state, lifecycle state, quantities, and execution time
must also agree. There is no repair, precedence choice, currency overwrite, or FX conversion.

The successful snapshot preserves `grossPerformance` and `costAccounting` by reference. Its
`positionExposure` is exactly Task029A's reference. Independently projected realized-accounting and
PositionExposure objects need not have reference identity across Task029A and Task030A; semantic
equality is required instead.

## Lifecycle and evidence clocks

OPEN and PARTIALLY_EXITED snapshots combine the current Task029A gross valuation with the latest
supplied Task030A costs. FLAT_ENTRY_ACTIVE and CLOSED retain their upstream exposure states and
zero-unrealized semantics. A later cost snapshot can change net total without a new fill or market
mark. This includes a post-close settlement cost, which does not reopen or otherwise alter the
position.

V1 retains three separate clocks: `executionAccountingAsOf`, `valuationAsOf`, and
`costAccountingAsOf`. A cost may arrive after the valuation mark, so `costAccountingAsOf` may exceed
`valuationAsOf`. There is intentionally no single `netPerformanceAsOf`: net total combines the
latest supplied gross-performance authority and cost-accounting authority while preserving each
evidence boundary.

## Immutability, determinism, and exclusions

The snapshot and result are frozen. Inputs are not mutated, and nested authorities remain their
original frozen objects. Equal inputs produce equal outputs across repeated calls and fresh engine
instances. Production reads no clock, environment, or randomness and performs no broker, adapter,
repository, persistence, database, network, subscription, reconciliation, submission, protection,
cancellation, or audit operation.

Deferred scope includes net realized/unrealized attribution, fee allocation, taxes, withholding, FX
conversion, slippage and execution-quality costs, rate/notional calculation, ROI, R-multiple,
portfolio aggregation, account equity/NAV, persistence/reporting, and the Task031B realtime net
performance projection.
