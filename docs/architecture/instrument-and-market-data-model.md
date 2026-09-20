# Instrument and market-data model

Phase 1 establishes two venue-neutral packages. `instrument-model` owns instrument identity, metadata, decimal values, Unix timestamps, and fixed-duration timeframes. `market-data` depends on that package and owns normalized payloads, source envelopes, and data-quality flags. Neither package contains adapter, strategy, arithmetic, or execution behavior.

## Decimal values

Authoritative prices, quantities, volumes, rates, sizes, and notionals are validated plain-decimal strings. This preserves source precision and avoids JavaScript binary floating-point rounding. Exponents, separators, whitespace, leading plus signs, non-canonical leading zeroes, and negative zero are rejected. This phase deliberately performs no decimal arithmetic.

## Instrument identity

An `InstrumentId` has the canonical, versioned form `ulte:v1:<encoded venue>:<kind>:<encoded venue symbol>`. Its components are URI-encoded, making the ID stable and reversible. Identity includes venue, native symbol, and instrument kind; asset class alone never identifies an instrument. The native `VenueSymbol` remains case-sensitive and unchanged, while `InstrumentId` is ULTE's cross-component identity.

Metadata records only applicable currencies, limits, contract size, and expiry. Unknown values remain absent. Capabilities are an explicit immutable list drawn from quote, trade, candle, order-book, mark-price, index-price, funding, and open-interest support; future capabilities can be added without reshaping metadata.

## Time and events

Hot-path times use validated non-negative safe-integer Unix epoch milliseconds, interpreted as UTC. Fixed timeframes use a positive integer followed by `s`, `m`, `h`, `d`, or `w`; calendar months are intentionally unsupported. Conversion rejects durations exceeding JavaScript's safe-integer range.

Every `MarketDataEvent` names the instrument and data source separately, carries event and receive times, explicit quality flags, and its payload. Receive time may precede event time because clocks can skew. Sequence IDs are opaque strings so venue values larger than JavaScript's safe-integer limit remain exact. Missing optional fields are never synthesized, and quality is supplied explicitly rather than inferred.

Dependency direction is `shared` (when needed) -> `instrument-model` -> `market-data`; the instrument package never imports market-data contracts.
