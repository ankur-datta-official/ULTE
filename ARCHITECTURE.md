# Intended architecture

ULTE is a monorepo of deployable applications, reusable domain packages, and research tooling. This document defines boundaries, not implementations.

```text
 Browser extension       Web dashboard
         |                     |
         +----------+----------+
                    |
                 API app
                    |
     +--------------+----------------+
     | domain/application services   |
     | market data -> analysis ->     |
     | setup -> risk -> execution     |
     +--------------+----------------+
                    |
          adapters / MT5 bridge
                    |
        external venues (future)

 Research/backtests ------> same trading-core
 Live execution ----------> same trading-core
```

## Deployable applications

- `apps/extension` and `apps/dashboard` are presentation clients. They may display results and collect intent, but cannot own authoritative trading, reward/risk, sizing, approval, or execution logic.
- `apps/api` will expose application workflows while keeping domain decisions in packages.
- `apps/mt5-bridge` will be an integration boundary, not a source of trading policy.

## Package boundaries

- `instrument-model` defines canonical instruments and decimal-safe domain values.
- `market-data` owns normalized market-data contracts and quality semantics.
- `live-market-data-engine` validates normalized live trades at a provider-neutral boundary, enforces
  explicit source/stream/epoch identity, bounded deduplication, chronology and no-lookahead rules,
  and routes only accepted events into the shared `market-data` multi-timeframe candle engine.
- `backtest-engine` owns deterministic historical replay and reuses `market-data` candle processing.
- `realtime-analysis-engine` consumes only finalized candle events from accepted live ingestion or
  equivalent historical replay, builds bounded synchronized as-of frames, and reuses the regime,
  structure/liquidity, and setup engines without invoking risk or execution.
- `realtime-decision-engine` consumes immutable real-time analysis cycles and coordinates the
  existing structural-risk, portfolio-risk, position-sizing, and trade-intent engines in strict
  order. It uses caller-supplied same-as-of context, fail-closes unsupported multi-candidate cycles,
  and publishes deterministic monotonic outcomes without preparing or executing orders.
- `realtime-execution-preparation-engine` consumes Task 019 decision results and routes only
  `TRADE_INTENT_CREATED` through the existing execution-preparation engine with caller-supplied quote,
  observation boundary, policy, and instrument constraints. It publishes deterministic monotonic
  no-op, rejected, or prepared outcomes and stops before policy, broker, persistence, or network code.
- `realtime-execution-submission-engine` is the controlled first side-effect boundary. It accepts only
  Task 020 prepared results, hard-blocks LIVE, enforces caller-timed plan freshness, reuses the adapter
  registry and execution policy, and delegates entry-only submission to the existing durable
  reconciliation-aware orchestrator. It owns no provider transport, fill, protection, cancellation,
  reconciliation execution, or PostgreSQL implementation.
- `realtime-execution-fill-engine` is the provider-neutral deterministic projection layer after a
  confirmed Task 021 acknowledgement. It initializes the existing execution attempt without creating
  a fill, accepts only normalized execution-engine fill events with caller-supplied observation time,
  and reuses the existing immutable fill transition for identity, chronology, exact accumulation,
  duplicate/conflict, partial/full, and overfill semantics. It owns no provider parsing, persistence,
  adapter calls, reconciliation, protection, cancellation, position accounting, or PnL.
- `realtime-execution-protection-engine` consumes only a newly applied Task 022 fill, reuses the
  existing incremental protection policy and registry-bound adapter capabilities, hard-blocks LIVE,
  and delegates the exact policy-produced request to durable reconciliation-aware protection
  submission. It owns no protection calculation, retry loop, modification, cancellation, exit fill,
  position/PnL state, reconciliation execution, provider transport, or PostgreSQL implementation.
- `realtime-execution-protection-lifecycle-engine` consumes only an actual confirmed Task 023
  protection acknowledgement, validates request/attempt/durable identity and caller-supplied
  chronology, and reuses the existing immutable protection acknowledgement transition. It performs
  no adapter, repository, reconciliation, exit-fill, position, or PnL work; protection acceptance is
  coverage acknowledgement only, never evidence that a stop or target executed.
- `realtime-execution-exit-fill-engine` consumes only a successful Task 024 protection lifecycle and
  explicit normalized authoritative exit evidence. It validates caller observation time and an exact
  replayable current-attempt continuation, then reuses the existing exit transition for stop/target
  identity, chronology, protection provenance, coverage, duplicate, partial, and terminal semantics.
  It owns no price inference, adapter/repository call, submission, cancellation, position, or PnL work.
- `position-engine` purely projects one authoritative `ExecutionAttempt` V2 into one immutable
  provider-neutral exposure snapshot. It derives exact open quantity, LONG/SHORT direction, and
  no/open/partially-exited/flat-but-entry-active/closed lifecycle semantics without cross-attempt
  netting, orchestration, market valuation, persistence, or financial/PnL accounting.
- `exact-decimal` owns the minimal public BigInt-backed compare, addition, subtraction, non-negative
  subtraction, and multiplication primitives shared by domains that require exact finite-decimal
  arithmetic. It exposes no division or rounding policy.
- `trade-accounting-engine` purely replays one authoritative `ExecutionAttempt` V2 into immutable
  gross realized PnL, auditable FIFO matches, and remaining FIFO basis. It delegates exposure
  direction, open quantity, lifecycle semantics, and as-of time to `position-engine`, consumes the
  canonical linear economics from `position-sizing-engine`, and performs no realtime orchestration,
  unrealized/net accounting, FX conversion, broker operation, or persistence.
- `trade-cost-accounting-engine` purely accounts explicit authoritative monetary cost events for one
  execution attempt. It delegates execution-history validation and accounting provenance once to
  `trade-accounting-engine`, then exactly aggregates positive `DEBIT` and `CREDIT` events in the
  Task027A PnL currency. It derives no charge from rates, notional, quantity, price, or market value
  and performs no net-PnL, FX, tax, slippage, portfolio, realtime, persistence, or side-effect work.
- `realtime-trade-cost-accounting-engine` gates authoritative Task 022 entry-fill and Task 025B
  exit-fill results by their outer statuses, takes the current attempt only from an actionable
  result, canonicalizes already-observed cost deliveries, collapses exact canonical transport
  duplicates, and fails closed on conflicting same-ID deliveries before delegating once to
  `trade-cost-accounting-engine`. It owns no cost arithmetic, hidden delivery state, future-event
  access, rate derivation, provider transport, persistence, or side effect.
- `trade-valuation-engine` consumes one authoritative execution attempt, delegates all exposure and
  FIFO basis ownership to `trade-accounting-engine`, and values only its current open lots at an
  explicit upstream-resolved instrument/time mark using exact gross linear PnL arithmetic. It makes
  no bid/ask/last/mid selection, average-basis calculation, realtime orchestration, or side effect.
- `trade-performance-engine` consumes one authoritative execution attempt, canonical accounting
  specification, and explicit valuation mark; delegates once to `trade-valuation-engine`; and adds
  its nested authoritative gross realized PnL to gross unrealized PnL with exact decimal arithmetic.
  It owns no accounting, FIFO, exposure, valuation, cost/net, analytics, portfolio, realtime, or
  side-effect behavior.
- `net-trade-performance-engine` combines complete authoritative `trade-performance-engine` and
  `trade-cost-accounting-engine` snapshots for the same trade/accounting state and introduces only
  exact `grossTotalPnl - netCostAmount`. It preserves both authorities and their separate valuation
  and cost evidence clocks, fails closed on semantic incoherence, and performs no cost attribution,
  FX, tax, slippage, portfolio, realtime, persistence, or side-effect work.
- `realtime-net-trade-performance-engine` consumes only complete Task029B realtime gross-performance
  and Task030B realtime cost-accounting results. It requires coherent source and projection states,
  preserves each upstream status independently, and delegates projected authorities exactly once to
  `net-trade-performance-engine`. It reruns no upstream engine, performs no financial arithmetic,
  keeps no state, and has no broker, repository, market-data, network, or persistence side effect.
- `realtime-trade-valuation-engine` gates authoritative Task 022 entry-fill and Task 025B exit-fill
  results by their outer statuses, takes the current attempt only from an actionable result, resolves
  `LAST_TRADE_V1` exclusively from an already-observed canonical `MarketDataEvent<TradeTick>`, and
  delegates all accounting and valuation semantics to `trade-valuation-engine`. It owns no alternate
  attempt or mark input, market cache, arithmetic, side effect, or historical/live observation state.
- `realtime-trade-performance-engine` consumes only an authoritative realtime valuation result and
  delegates projected valuation composition to `trade-performance-engine`, preserving source,
  lifecycle-status, and `LAST_TRADE_V1` provenance without resolving marks or doing arithmetic.
- `realtime-trade-accounting-engine` gates authoritative Task 022 entry-fill and Task 025B exit-fill
  results by their outer statuses, takes the current attempt only from an actionable upstream result,
  and delegates the entire immutable realized-accounting replay to `trade-accounting-engine` with the
  canonical linear sizing specification. It owns no alternate attempt input, FIFO or PnL arithmetic,
  incremental state, broker interaction, persistence, or other side effect.
- `realtime-position-exposure-engine` gates authoritative Task 022 entry-fill and Task 025B exit-fill
  results by their outer statuses, takes the current attempt only from an actionable upstream result,
  and delegates the entire immutable exposure projection to `position-engine`. It owns no alternate
  attempt/as-of input, arithmetic, lifecycle state, broker or repository interaction, or accounting.
- `trading-core` owns shared strategy contracts and deterministic trading semantics used by both live and backtest paths.
- `regime-engine`, `structure-engine`, `setup-engine`, and `prediction-engine` provide focused analysis capabilities without UI dependencies.
- `setup-engine` consumes public regime and structure evidence plus closed setup-timeframe candles; it emits setup candidates, not executable trade signals.
- `risk-engine` deterministically qualifies structural risk and enforces the official net RR floor; `portfolio-risk-engine` separately decides whether requested monetary risk fits explicit account-level capital policy; `position-sizing-engine` converts that approved requested risk into a conservative step-aligned quantity using explicit instrument economics. `trade-intent-engine` verifies and combines those authoritative outputs into a deterministic handoff snapshot without recalculating them. None of these results is an execution instruction.
- `execution-preparation-engine` converts a ready trade intent plus an explicit current quote and venue-neutral constraints into an exact, broker-neutral execution plan without submitting it. `realtime-execution-preparation-engine` orchestrates that boundary for live/replay decisions without duplicating its rules. `realtime-execution-submission-engine` controls entry submission through the existing durable workflow for DRY_RUN and SANDBOX only, `realtime-execution-fill-engine` projects normalized entry fills after a confirmed acknowledgement, `realtime-execution-protection-engine` durably submits exact existing-policy protection for newly applied exposure, `realtime-execution-protection-lifecycle-engine` projects only the actual confirmed protection acknowledgement, and `realtime-execution-exit-fill-engine` projects explicit authoritative exit fills. `execution-engine` preserves that plan while coordinating immutable, idempotent entry, acknowledged-protection provenance, authoritative stop/target exit fills, exact cumulative exit coverage, and cancellation lifecycles through capability-declared adapter contracts; it contains no venue implementation, position/PnL aggregate, or exit-fill transport. `position-engine` provides the separate authoritative exposure view without changing execution state or interpreting historical protection coverage as current open protection. `trade-accounting-engine` separately derives gross realized FIFO accounting from that authoritative history and exposure projection, while `realtime-trade-accounting-engine` provides only the status-gated realtime projection boundary.
- `broker-adapters` defines explicit adapter identity/environment metadata, deterministic registration,
  durable-idempotency and sanitized-audit contracts, and normalized failure/retry safety for future
  venue integrations. It extends execution-engine contracts without owning execution lifecycle state
  and contains no concrete venue or credential-resolution implementation.
- `execution-reconciliation-engine` claims logical operations durably before submission, writes a
  conservative may-have-started marker before every adapter call, suppresses duplicate/conflicting
  submissions, and coordinates broker-neutral reconciliation and explicit same-key retry authorization.
  It contains neither persistence nor a concrete broker integration.
- `execution-store-postgres` implements those idempotency and sanitized audit contracts with
  environment-bound PostgreSQL uniqueness, insert-first atomic claims, immutable identity, and
  caller-timed monotonic updates. It owns neither database connections nor broker integration.
- `shared` contains genuinely cross-cutting primitives only; it must not become a miscellaneous domain package.

Dependencies flow from applications and adapters toward stable domain contracts. Domain packages must not import application or UI code. Broker-specific types must not leak into trading rules. Cross-package cycles are prohibited.

## Cross-cutting constraints

All internal times are UTC. Financial values use decimal-safe representations. Missing or stale data is explicit and must never be silently replaced. Secrets remain server-side. Material decisions and execution events must eventually be traceable through durable audit records.

Python research code may explore ideas, but a production rule requires an explicit, tested implementation in the shared trading core. See the decision records in `docs/decisions/` for the governing rationale.
