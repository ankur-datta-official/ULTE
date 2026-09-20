# Backtesting and historical replay

Phase 3 adds `backtest-engine` above `market-data` and `instrument-model`. It replays normalized `MarketDataEvent<T>` values through a deterministic in-memory source and never changes their timestamps, identity, quality, sequence, or payload. The package performs no storage or networking.

`SimulationClock` starts without a time unless explicitly initialized. Replay advances it to each event's `eventTime`; equal timestamps are allowed and backward movement fails. Simulation semantics never read the wall clock and include no timers, so the same ordered inputs and configuration produce the same result.

An `ArrayHistoricalEventSource` copies the supplied sequence and validates the full dataset before replay. `eventTime` must be non-decreasing. Equal timestamps retain input order, while decreasing timestamps reject the dataset rather than being sorted or repaired.

The consumer receives only the current event plus a frozen context containing its zero-based index and matching simulation time. No source, next-event accessor, or future data is present in that context. Replay is synchronous, may stop explicitly, and returns frozen deterministic counts and time bounds without execution-duration metadata.

Historical trades use `TradeTickCandleReplayConsumer`, a thin adapter over the existing `MultiTimeframeCandleEngine`. Consequently live and replay paths share candle boundaries, ordering, gap reporting, and no-synthetic-candle behavior.

Dataset manifests and caller-supplied run metadata provide traceability without random IDs or creation timestamps. This phase intentionally excludes strategies, indicators, signals, risk, fills, PnL/performance statistics, optimization, persistence, venue adapters, live networking, and UI.
