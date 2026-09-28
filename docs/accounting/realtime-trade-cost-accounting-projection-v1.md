# Deterministic realtime trade cost accounting projection V1

## Purpose and authority

`@ulte/realtime-trade-cost-accounting-engine` is the stateless delivery boundary between actionable
Task022/Task025B execution lifecycle results and authoritative Task030A cost accounting. It accepts
only the `ExecutionAttempt` embedded in an actionable realtime entry-fill or exit-fill result. There
is no separate attempt input and no caller-supplied aggregate cost, position, PnL, rate, or notional.

Task030A remains the sole cost-accounting authority. After delivery normalization, this package calls
`projectTradeCostAccounting` once. Task030A continues to own Task027A validation, attempt,
instrument, currency, and chronology binding, canonical ledger ordering, all debit/credit/net
arithmetic, accounting as-of times, and the nested realized-accounting and position-exposure
provenance. This projection performs no financial arithmetic and does not import exact-decimal.

## Execution and observed-delivery gates

Entry projection is allowed only for `FILL_APPLIED` and `DUPLICATE_FILL`; exit projection is allowed
only for `EXIT_FILL_APPLIED` and `DUPLICATE_EXIT_FILL`. Every other outer status returns
`NO_COST_ACCOUNTING_PROJECTION` before any cost delivery is inspected. Thus a rejected lifecycle
cannot masquerade as actionable by carrying an attempt or malformed delivery.

`observedCostEvents` is the complete set of deliveries the caller has already observed at that
checkpoint. The projection never polls, fetches, subscribes, reads a wall clock, or assumes a future
delivery. Reusing the same actionable lifecycle with a larger observed set permits accounting to
advance without a new fill, including settlement costs observed after a position is closed.

## Canonical delivery normalization

Every delivery is revalidated and canonicalized with Task030A's public `createTradeCostEvent`
constructor before comparison. An invalid delivery produces `COST_EVENT_DELIVERY_INVALID` without
throwing and without fabricating an authoritative Task030A rejection.

For one projection call only, deliveries are grouped by `costEventId`. Repeated deliveries collapse
when all canonical fields are equal: schema version, ID, attempt, instrument, type, effect, amount,
currency, effective time, and source. Equality is evaluated after the constructor returns; the
current Task030A decimal constructor preserves scale, so `1.2500` and `1.25` remain different
canonical payloads. If any canonical field differs, the projection fails closed with
`CONFLICTING_DUPLICATE_COST_EVENT_ID`; it never selects, merges, or sums a conflicting value. The
resulting unique event set is passed to Task030A, whose authoritative duplicate-ID rule is unchanged.

Normalization state is function-local. No map, set, ledger, cache, watermark, or processed-ID state
survives a call. Input order does not affect the authoritative ledger or delivery counts. An
actionable lifecycle with no deliveries still delegates an empty ledger and projects Task030A's
canonical zero-cost snapshot; this differs from no projection for a non-actionable lifecycle.

## Rejections, immutability, and side effects

If Task030A rejects, the wrapper reports `AUTHORITATIVE_COST_ACCOUNTING_REJECTED` and preserves its
exact rejection object, including nested Task027A and PositionExposure failures. On success the
`accounting` field is the exact frozen Task030A object rather than a clone, so all nested references
remain authoritative. Wrapper results and locally owned normalized arrays are frozen; lifecycle,
attempt, specification, delivery array, delivery objects, and Task030A output are not mutated.

Equal lifecycle, specification, and observed deliveries produce equal output across repeated calls
and fresh engine instances. Production has no broker, adapter, provider, network, repository,
PostgreSQL, reconciliation, submission, protection, cancellation, or audit dependency. Same-currency
accounting remains a Task030A rule. This package derives no commissions, exchange fees, funding,
borrow costs, or other charges from rates and calculates no tax, FX, slippage, net trade performance,
or portfolio aggregate.

Deferred scope includes provider-specific fee APIs, websocket ingestion, persistent cost journals,
broker reconciliation, fee schedules, funding- and borrow-rate calculation, tax, FX, slippage, net
trade performance, and portfolio aggregation.
