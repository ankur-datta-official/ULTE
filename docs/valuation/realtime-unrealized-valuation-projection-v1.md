# Deterministic realtime unrealized valuation projection V1

## Purpose and trust boundaries

`@ulte/realtime-trade-valuation-engine` is the pure Task 028B policy boundary after the authoritative
realtime entry-fill and exit-fill lifecycles. Its source-discriminated input accepts the corresponding
public lifecycle result, the canonical accounting specification, and one already-observed canonical
`MarketDataEvent<TradeTick>`. It accepts no independent execution attempt, valuation mark, mark price,
mark time, direction, open basis, exposure, accounting result, or PnL value.

Entry `FILL_APPLIED` and `DUPLICATE_FILL`, and exit `EXIT_FILL_APPLIED` and
`DUPLICATE_EXIT_FILL`, are actionable. Rejected and no-processing outer statuses return
`NO_VALUATION_PROJECTION`. This gate runs before mark resolution or inspection of attempt-looking
diagnostics, so a rejected result cannot cross the execution trust boundary.

## Explicit LAST_TRADE_V1 policy

Task 028A remains policy-neutral: it validates and values a resolved mark but never chooses market
evidence. Task 028B is the first explicit resolution policy and V1 supports exactly
`LAST_TRADE_V1`. It canonically revalidates the supplied trade event, then maps its `instrumentId` to
the mark instrument, its trade payload `price` to `markPrice`, and its `eventTime` to `markAsOf` by
calling Task 028A's public `createValuationMark`. `receivedAt`, source, quality, and sequence identity
remain event provenance; `receivedAt` is never substituted for valuation time.

Malformed trade evidence is rejected as `MARK_SOURCE_INVALID`. Instrument mismatch and the inherited
`markAsOf >= accountingAsOf` rule remain Task 028A decisions, including exact preservation of
`VALUATION_MARK_INSTRUMENT_MISMATCH` and `VALUATION_MARK_PRECEDES_ACCOUNTING`; equal time is allowed.
Bid, ask, midpoint, candle close, preparation quote, and broker/exchange marks are not V1 sources.

## Sole valuation authority and replay behavior

For an actionable result, Task 028B takes only its embedded current `ExecutionAttempt`, resolves the
mark, and calls `projectUnrealizedTradeValuation`. Task 028A remains the sole valuation authority and
Task 027A remains the sole accounting, FIFO, exposure, direction, chronology, and open-basis authority.
Task 028B performs no financial arithmetic. It preserves the exact Task 028A rejection object, which
in turn preserves nested Task 027A and position-exposure failures.

The same lifecycle result can be projected against a later observed trade without a new fill, so open
exposure is deterministically marked to market. Exact duplicate execution results and repeated market
events produce equal snapshots and cannot double-count anything. No latest-trade cache, watermark,
deduplication set, or other production state exists.

## Observation discipline, immutability, and side effects

The caller must pass only the event currently yielded by historical replay or the corresponding event
after live ingestion accepted it. Task 028B does not inspect wall-clock time and cannot make an
arbitrary future event authoritative. Historical replay must not expose a later array element before
it is yielded; live code must not project a rejected or not-yet-observed event.

Inputs are not mutated. The wrapper result is frozen and Task 028A's already-frozen valuation remains
nested by reference. Equal inputs produce equal output across repeated calls and fresh instances.
Projection makes no broker, adapter, repository, database, persistence, network, reconciliation,
submission, protection, cancellation, or market-subscription call. V1 reports gross unrealized PnL
only.

Deferred policies and concerns include bid, ask, midpoint, native exchange/broker, index, and
liquidation marks; net PnL; fees, funding, tax, and FX; portfolio valuation; and persistence/reporting.
