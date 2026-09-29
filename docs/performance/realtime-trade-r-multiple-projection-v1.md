# Deterministic realtime net R-multiple projection V1

## Purpose and authority boundary

`@ulte/realtime-trade-r-multiple-engine` consumes exactly one Task031B
`RealtimeNetTradePerformanceResult` and one already-established immutable Task032A `TradeRiskBasis`.
Task031B is the complete realtime net-performance authority. Task032A remains the sole R-composition
authority; the realtime package never recreates the risk basis or reruns net, gross, cost, valuation,
realized-accounting, exposure, fill, or execution logic.

## State gating and rejection precedence

The Task031B outer status is gated before the risk basis is inspected. A
`NO_NET_TRADE_PERFORMANCE_PROJECTION` result produces no R projection, ratio, monetary zero, or risk
validation result. A `NET_TRADE_PERFORMANCE_REJECTED` result takes precedence over any malformed risk
basis and is retained by reference. Only `NET_TRADE_PERFORMANCE_PROJECTED` delegates exactly once to
`projectTradeRMultipleFromAuthorities`. Any Task032A rejection, including invalid risk, incoherent
identity, or currency mismatch, is wrapped as `AUTHORITATIVE_R_MULTIPLE_REJECTED` and retained intact.

## Exact evolving projection

Success preserves Task032A's exact numerator/denominator ratio unchanged; the realtime package does
no division, rounding, risk recomputation, PnL recomputation, currency comparison, or FX conversion.
The same original risk basis and denominator are reused as market-only, cost-only, combined, partial,
flat-entry-active, closed, or late post-close cost evidence changes the Task031B numerator. LONG and
SHORT use the same delegation. A projected zero net PnL is a valid zero numerator and is distinct from
the absence of a projection.

The Task031B result, Task032A result and snapshot, net-performance snapshot, risk basis, position
exposure, source kind, independent upstream statuses, and projected mark policy retain their original
references or values. Only the new top-level realtime result is created and frozen.

## Determinism and exclusions

Equivalent historical-replay and live inputs produce equivalent results. The projection is
function-local, reads no clocks or future evidence, keeps no cache or watermark, mutates no input,
and performs no broker, network, repository, persistence, reconciliation, or execution side effect.

Deferred scope includes FX-normalized R, display-decimal R, reporting or persistence, multi-trade
expectancy, win rate, profit factor, and portfolio analytics.
