# Deterministic realtime net trade performance projection V1

## Purpose and authority boundary

`@ulte/realtime-net-trade-performance-engine` (Task031B) is a pure composition boundary over two
already-authoritative realtime results: Task029B `RealtimeTradePerformanceResult` and Task030B
`RealtimeTradeCostAccountingResult`. Its public API accepts exactly those two results. It accepts no
execution attempt, accounting specification, mark, market event, raw cost delivery, position,
quantity, direction, or caller-supplied monetary value.

Task031B never recomputes Task029B or Task030B and never invokes their upstream valuation,
accounting, position, fill, or execution domains. When both results are projected it delegates once
to Task031A `projectNetTradePerformanceFromAuthorities`. Task031A remains the sole owner of authority
coherence and `netTotalPnl = grossTotalPnl - netCostAmount`; Task031B imports no decimal arithmetic.

## Realtime provenance and state gating

The two `sourceKind` values must match. An `ENTRY_FILL` result can never compose with an `EXIT_FILL`
result, even if test-forged nested snapshots appear coherent; the result rejects with
`REALTIME_SOURCE_KIND_INCOHERENT` before Task031A is called.

Gross and cost `upstreamStatus` values are retained independently as `grossUpstreamStatus` and
`costUpstreamStatus`. Applied and duplicate statuses are compatible when their nested authorities
are coherent: entry applied/duplicate and exit applied/duplicate can be paired in any combination.
They are not collapsed because duplicate delivery can represent the same authoritative state with
different realtime provenance.

Two no-projection results produce `NO_NET_TRADE_PERFORMANCE_PROJECTION` only when source kind and
the non-actionable upstream status match exactly. No monetary zero is invented. A no-projection
paired with projected or rejected state, or two no-projection results with different upstream
statuses, rejects as `REALTIME_PROJECTION_STATE_INCOHERENT`.

Task029B rejection has deterministic precedence and is retained as the exact
`grossPerformanceResult`, including when both inputs reject. Otherwise a Task030B rejection is
retained as the exact `costAccountingResult`. If two projected inputs reach Task031A and it rejects,
Task031B reports `AUTHORITATIVE_NET_PERFORMANCE_REJECTED` and retains that exact Task031A result;
the rejection tree is neither flattened nor repaired.

## Independent evidence advancement

A new Task029B result from a later already-observed `LAST_TRADE_V1` mark can be composed with the
same Task030B accounting result. No new fill or cost delivery is required. Conversely, a later
Task030B result can be composed with the same Task029B result without a new mark or fill. Both may
advance together. Task031B resolves no mark and preserves Task029B's `markPolicy` exactly.

OPEN and PARTIALLY_EXITED checkpoints retain upstream gross valuation and position state.
FLAT_ENTRY_ACTIVE and CLOSED checkpoints retain upstream zero-unrealized behavior. A late
post-close cost can change net total while the same CLOSED gross snapshot and valuation evidence
remain unchanged; it never reopens the position.

The Task031A snapshot carries its separate `executionAccountingAsOf`, `valuationAsOf`, and
`costAccountingAsOf` clocks unchanged. Task031B adds no combined clock, processing time, or wall
clock. Cost evidence may therefore be later than valuation evidence.

## Identity, determinism, and observation boundary

The successful `snapshot` is the exact Task031A snapshot reference. Its `grossPerformance`,
`costAccounting`, and `positionExposure` remain the exact Task029B/Task030B/Task029B nested
references. The retained `netPerformanceProjection` is the exact Task031A result. No authority is
cloned, rebuilt, or mutated; only Task031B-owned top-level results are newly frozen.

The projection is deterministic and function-local. It has no cache, map, set, previous/latest
snapshot, processed-ID collection, or watermark. It reads no clock, random source, environment, or
external state. Historical and live no-lookahead guarantees remain upstream-owned: Task031B cannot
look ahead because it receives neither market events nor cost deliveries, only authorities already
constructed from evidence observed at the checkpoint.

Production performs no broker or adapter access, market subscription, provider polling, repository
or database write, network request, reconciliation, entry/protection/cancellation action, or audit
write. It contains no injectable side-effect dependency.

## Deferred scope

V1 deliberately excludes net realized/unrealized attribution, cost allocation, tax, withholding,
FX, slippage, fee/rate/notional derivation, ROI, R-multiple, portfolio aggregation, account
equity/NAV, persistence, reporting, and broker-statement reconciliation.
