# Portfolio and capital risk engine V1

## Purpose and boundary

`@ulte/portfolio-risk-engine` deterministically decides whether the requested monetary risk for an already structurally `QUALIFIED` hypothesis fits explicit account-level capital policy. It is separate from `@ulte/risk-engine`, which owns structural invalidation and the minimum net reward-to-risk qualification. `CAPITAL_ELIGIBLE` is not a trade, order, sizing result, profitability claim, or execution authorization.

## Snapshot and requested risk

The immutable account snapshot contains a UTC Unix-millisecond `asOf`, base currency, current and day-start equity, and caller-supplied open-position stop risk. All money is an exact decimal string in the account base currency; V1 performs no FX conversion. The snapshot time must equal the structural result time, avoiding stale/future ambiguity without using a wall clock. Requested risk is supplied directly and is never derived from quantity, leverage, or margin.

## Capital controls

Callers must explicitly configure positive basis-point limits for per-trade risk, aggregate open risk, daily equity loss, and every exposure/risk group, plus a positive concurrent-position ceiling. No defaults or universally optimal percentages are claimed. Equality is allowed at per-trade, aggregate, and group caps. Daily loss at or above its cap blocks, as does an open-position count already at its ceiling.

Risk groups are caller-defined exposure or correlation buckets; the engine infers no statistical relationship. Every existing and proposed group must be configured. A position in multiple groups contributes its full stop risk independently to each group. Proposed groups are checked in supplied order, so the first failing group is deterministic.

## Capacity and exactness

The result reports exact limit amounts, current and post-trade aggregate risk, per-proposed-group exposure, remaining capacities, and `maximumAdditionalRiskAmount`. The maximum is the smallest non-negative capacity among the per-trade ceiling, aggregate headroom, and proposed-group headroom. An active daily-loss or concurrent-position breaker forces it to zero. This value is informational and is not position quantity.

Money calculations use BigInt-backed fixed-scale decimal arithmetic. Eligibility and daily-loss ratios use exact cross multiplication; displayed limit amounts preserve the precision introduced by division by 10,000 and are never rounded upward.

## Deterministic decision order

The evaluator applies: (1) upstream structural eligibility, (2) input and risk-group validation, (3) daily loss, (4) concurrent positions, (5) per-trade risk, (6) total open risk, (7) proposed risk groups, then (8) `CAPITAL_ELIGIBLE`.
