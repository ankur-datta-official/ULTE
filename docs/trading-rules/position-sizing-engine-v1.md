# Position sizing engine V1

## Purpose and gates

`@ulte/position-sizing-engine` converts an already approved monetary-risk budget into a deterministic instrument quantity. It requires both a structurally `QUALIFIED` result and a `CAPITAL_ELIGIBLE` portfolio-risk result with matching candidate, instrument, and timestamp identities. The portfolio result's `requestedRiskAmount` is the authoritative budget; informational portfolio capacity cannot increase it.

## Linear valuation and quantity rules

V1 supports only `LINEAR_PRICE_PNL`. Callers explicitly provide the PnL currency and the monetary PnL in that currency produced by a 1.0 price move for 1.0 quantity, plus the quantity unit, step, minimum, and maximum. Minimum and maximum quantities must be exact step multiples. No instrument, venue, lot, contract, or asset-class default is inferred.

Risk per quantity unit is structural `netRisk` multiplied by the supplied PnL value and the applicable PnL-to-account conversion rate. Risk per step is that value multiplied by `quantityStep`. The engine floors the approved budget divided by risk per step using exact integer arithmetic. It never rounds upward. A safe quantity below the minimum is `NOT_SIZEABLE`; a quantity above the maximum is conservatively capped and identified as such.

## Currency and safety boundary

Matching PnL and account currencies use an exact rate of 1. Different currencies require an explicit positive conversion snapshot from PnL currency to account base currency at the same `asOf`; V1 performs no lookup, inversion, or stale/future substitution.

All authoritative calculations use exact BigInt-backed decimal arithmetic. Actual monetary risk cannot exceed approved requested risk, and unused risk is non-negative. Structural costs are already represented in `netRisk` and are not recomputed. Leverage does not affect sizing. V1 does not normalize price ticks or order prices and does not apply minimum-notional or other venue order filters.

A `SIZED` result is not an order, execution instruction, or profitability claim. The engine does not place trades, calculate margin or liquidation, change entry/stop/target prices, or widen structural invalidation.
