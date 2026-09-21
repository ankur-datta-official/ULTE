# Broker-neutral execution preparation V1

## Purpose and boundary

`@ulte/execution-preparation-engine` converts an authoritative `INTENT_READY` Trade Intent into an immutable broker-neutral execution plan. The plan is preparation data, not a submitted order, broker authorization, fill guarantee, or profitability claim. The package performs no market-data lookup, network call, or venue-specific mapping.

## Explicit execution snapshot and freshness

The caller supplies the execution clock as UTC Unix milliseconds, a same-instrument bid/ask snapshot, and all freshness limits. The intent and quote may be exactly at their configured maximum ages. Future intents, future quotes, quotes predating the intent, and ages beyond their limits are rejected explicitly; no wall clock or missing quote is substituted.

## Exact venue-neutral constraints

The execution spec supplies a positive price tick, positive quantity step, and step-aligned positive minimum and maximum quantities. Entry, invalidation, target, and quantity must be exactly representable. V1 rejects non-representable values instead of rounding because any silent change could invalidate structural risk, net reward-to-risk, or approved monetary risk. Trade Intent values are copied and risk metadata is never recalculated.

## Sides, instructions, and market validity

`UP` maps to a `BUY` entry and `SELL` exits; `DOWN` maps to a `SELL` entry and `BUY` exits. V1 emits an exact-price `ENTRY_LIMIT`, an opposite-side `PROTECTIVE_STOP_TRIGGER`, and an opposite-side `PROFIT_TARGET_LIMIT`. It does not define venue order strings, time in force, OCO, or reduce-only behavior.

The current bid/ask must show that neither structural invalidation nor the primary target has already been reached. Entry deviation uses ask for an UP/BUY plan and bid for a DOWN/SELL plan. Eligibility compares the exact absolute deviation ratio by cross multiplication; the exposed basis-point value is display-only and floored. A resting buy limit below ask or sell limit above bid remains valid within the configured deviation.

## Identity and fill limitation

The execution plan ID is a deterministic fixed-order, length-prefixed encoding of schema version, intent identity, preparation and quote times, bid/ask, side, quantity, entry, stop, and target. It identifies this preparation snapshot and is not a broker idempotency key. Actual fills, partial fills, latency, and slippage belong to later execution handling, so analytical risk is not a promise of realized broker fill risk.
