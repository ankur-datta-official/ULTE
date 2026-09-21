# Trade intent orchestration V1

## Purpose and boundary

`@ulte/trade-intent-engine` is the deterministic handoff between analysis/risk outputs and future execution preparation. It requires, in fixed priority order, a `CONFIRMED` setup, `QUALIFIED` structural risk, `CAPITAL_ELIGIBLE` portfolio risk, and `SIZED` position. A failed gate returns the blocking layer and preserves its status and reason. Trade Intent V1 is not an order, execution authorization, or profitability claim.

## Coherent snapshot and source ownership

All four inputs must have exactly the same `asOf`, candidate, and instrument identity. The setup owns family, direction, context timeframe, and setup timeframe; structural risk must agree with the setup fields it exposes. Structural risk exclusively supplies the analytical entry reference, invalidation, primary target, net risk, and reward-to-risk values. Position sizing exclusively supplies quantity, quantity step, currencies, conversion, sizing economics, and approved/actual/unused risk. Portfolio risk supplies the approved requested-risk trace, which must exactly equal sizing's approved risk; actual risk may not exceed it. Values are verified with exact decimal comparison and copied without rounding or recalculation.

## Identity, time, and immutability

The intent ID uses a fixed-order, length-prefixed encoding of schema version, candidate, instrument, timestamp, direction, three structural prices, quantity, and account currency. Identical inputs therefore produce deeply equivalent frozen output and the same ID, while a material identity-field change produces a different ID. The canonical field order is part of V1.

No-lookahead is inherited from the authoritative upstream engines by requiring one exact same-`asOf` snapshot. This engine reads no market data, live quote, clock, or random source. Structural prices remain analytical references. V1 has no freshness or expiry policy and exposes no venue, broker, side mapping, order type, or submission behavior.
