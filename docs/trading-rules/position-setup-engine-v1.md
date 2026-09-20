# Position setup engine V1

`@ulte/setup-engine` deterministically identifies structural setup candidates from an existing context-timeframe regime result, setup-timeframe structure result, and closed setup candles. It produces setup state only; a setup is not a trade signal and conveys no profitability claim.

## Timeframes and states

The context and setup timeframes are independent and are never hard-coded. `ARMED` means the initiating structural event is known. `CONFIRMED` means the configured pattern later completed; it does not authorize a trade. State timestamps record when their required evidence became observable.

V1 supports exactly:

- `TREND_PULLBACK_CONTINUATION`: direction-aligned context, then a counter-side sweep/reclaim, followed by a strictly later direction-aligned close break.
- `BREAKOUT_RETEST`: a direction-compatible close break, followed by the first strictly later candle that touches or crosses the reference intrabar and closes back on the breakout side.
- `LIQUIDITY_SWEEP_REVERSAL`: a sweep/reclaim followed by a strictly later opposite close break; context direction agreement is not required.

Each family has an explicit allowlist of context primary regimes. No default or preferred regime combination is supplied.

## Chronology and data policy

Regime and structure windows must end by `asOf`; setup candles must be closed by `asOf`. Future structure events cannot create candidates. Candles and structure events are consumed in supplied order and are never sorted or repaired. Instrument/timeframe mismatches, open or future candles, gaps, duplicates, and decreasing chronology are explicit data rejections.

Every event reference is resolved by `referenceSwingId` to a liquidity level. A confirming close break may only use a level confirmed no later than its initiating sweep, preventing a later-created reference from confirming earlier state. Retest comparisons use exact decimal arithmetic, and the breakout candle cannot retest itself.

For each family and direction, V1 exposes only the most recently initiated valid candidate. A newer armed candidate therefore supersedes an older confirmed candidate. Results, candidates, and evidence snapshots are immutable and deterministic.

The engine inherits structure-engine V1's recent-window limitation: it can evaluate only the structural events and liquidity references retained in the supplied authoritative result.
