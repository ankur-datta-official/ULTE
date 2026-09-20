# Market regime engine V1

## Purpose and boundary

`@ulte/regime-engine` deterministically describes the regime of one instrument and one timeframe from already-closed `CandleSnapshot` values. It emits no entry, exit, trade signal, confidence, probability, or execution instruction. Higher-timeframe combination is intentionally deferred.

The primary regimes are `COMPRESSION`, `EXPANSION`, `TREND_UP`, `TREND_DOWN`, `RANGE`, and `TRANSITION`. Direction (`UP`, `DOWN`, or `NEUTRAL`) and volatility state (`COMPRESSION`, `NORMAL`, or `EXPANSION`) are also exposed independently.

## Windows and data policy

Callers must supply an explicit validated `RegimeConfig`; the package exports no default thresholds, and no threshold is claimed to be profitable or optimal. The minimum candle count is:

```text
max(trendLookback, baselineVolatilityBars + recentVolatilityBars + 1)
```

Only that many most-recent input candles are used. The trend window is the last `trendLookback` candles. The volatility window contains one preceding candle followed by consecutive true-range observations: first the configured baseline observations, then the non-overlapping recent observations. The preceding candle supplies only the previous close for the first true range. No future candle is needed.

Every used candle must be closed and have the same instrument and timeframe. Open times must strictly increase, close times must increase, and intervals must not overlap. Duplicate open times, ordering failures, identity mismatches, open candles, and `GAP_DETECTED` quality are rejected explicitly. Insufficient data and rejected data are not regimes; inputs are neither sorted nor repaired.

## Exact features

All price arithmetic uses decimal strings converted to exact integer coefficients and scales. Price values are never converted to JavaScript floating point.

```text
netMove = lastClose - firstClose
pathLength = sum(abs(close[i] - close[i-1]))
efficiency = abs(netMove) / pathLength (zero when pathLength is zero)
directionalConsistency = matching non-zero moves / all non-zero moves
TR[i] = max(high-low, abs(high-previousClose), abs(low-previousClose))
volatilityRatio = recent mean TR / baseline mean TR
```

Efficiency and consistency are floored to integer basis points. Volatility comparisons use exact cross multiplication; its displayed basis points are also floored and serialized as a non-exponent integer string. When both baseline and recent true range are zero, the ratio is defined as `10000` bps. When only baseline is zero, the ratio is `UNBOUNDED` and volatility is expansion.

## Deterministic rules

Rule priority is:

1. volatility ratio at or below the compression threshold: `COMPRESSION`
2. volatility ratio at or above the expansion threshold: `EXPANSION`
3. efficiency and consistency at or above trend minima, with positive/negative net move: `TREND_UP` / `TREND_DOWN`
4. efficiency and consistency at or below range maxima: `RANGE`
5. otherwise: `TRANSITION`

Direction always follows the net-move sign, including during compression or expansion. These classifications are descriptive market evidence only, not recommendations.
