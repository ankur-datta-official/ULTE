# ULTE product specification

## Confirmed requirements

- ULTE will be a production-grade platform whose first trading mode is position trading.
- Trading and financial decision logic must remain independent from UI code.
- Backtesting and live execution must use the same core strategy implementation.
- An LLM must never directly authorize or execute a live trade.
- Live execution must require deterministic risk-engine approval.
- An official system-generated trade signal must have projected reward-to-risk of at least 3.00, net of configured costs.
- Secrets must not be stored in frontend code or committed to version control.
- Money, price, and quantity calculations must use decimal-safe arithmetic.
- Internal timestamps must use UTC.
- Production execution must be idempotent and auditable.

## Future requirements

- Deployable applications: browser extension, backend API, web dashboard, and MetaTrader 5 bridge.
- Domain and infrastructure capabilities: instrument modeling, market data, trading core, regime analysis, structure/liquidity analysis, setup evaluation, statistical prediction, risk, execution, and broker/exchange adapters.
- Research capabilities: feature research, backtesting, notebooks, and historical validation.
- Support for multiple asset classes and trading venues.
- Phase 1 defines venue-neutral instrument identity, decimal-string values, Unix-millisecond time, fixed-duration timeframes, explicit market-data capabilities, and normalized market-data event contracts.
- Live market-data ingestion uses explicit provider-neutral source, stream, event, and reset-epoch
  identity; caller-supplied observation boundaries; bounded deterministic deduplication; explicit
  chronology/gap results; and the same candle implementation as historical replay. It contains no
  concrete feed transport or provider integration.
- Real-time analysis orchestration consumes only finalized candles from accepted live ingestion or
  equivalent replay, creates bounded immutable multi-timeframe views at explicit candle-close as-of
  boundaries, and reuses the existing regime, structure/liquidity, and setup engines. Open/future
  candles and rejected live inputs cannot reach analysis, and risk/execution remain downstream.
- Real-time decision orchestration consumes immutable analysis-cycle results, requires exact
  same-as-of caller-supplied risk and capital context, and reuses structural risk, portfolio risk,
  position sizing, and trade-intent engines in that fixed order. It fail-closes unsupported multiple
  actionable candidates, preserves monotonic idempotent decision boundaries, and stops before
  execution preparation.
- Real-time execution-preparation orchestration consumes immutable real-time decision results, sends
  only ready trade intents to the existing execution-preparation engine with an explicit caller-owned
  observation boundary and execution context, and preserves deterministic rejection/plan results.
  Bounded replay retention is backed by an independent monotonic decision-boundary watermark, and
  the orchestration stops before execution policy, broker, network, reconciliation, or persistence.
- Controlled real-time execution submission accepts only prepared Task 020 results, permits DRY_RUN
  and SANDBOX while hard-blocking LIVE, applies an explicit caller-timed prepared-plan freshness gate,
  and reuses the existing adapter registry, execution policy, and durable entry-submission workflow.
  It performs no fill, protection, cancellation, position, reconciliation, provider, or PostgreSQL work.
- Deterministic real-time fill orchestration accepts only confirmed Task 021 submissions with their
  actual accepted acknowledgement, preserves acknowledgement as distinct from fill, validates
  caller-supplied observation time and execution identity, and reuses the existing normalized fill
  event and execution lifecycle transition for exact partial/full accumulation, overfill rejection,
  and duplicate/conflict behavior. It performs no provider parsing, adapter call, persistence,
  reconciliation, protection, cancellation, position, PnL, or LIVE-enablement work.
- Controlled real-time protection orchestration accepts only newly applied Task 022 fills, asks the
  existing execution policy for exact incremental protection, permits DRY_RUN and SANDBOX while
  hard-blocking LIVE, validates caller-supplied chronology and registry bindings, and reuses durable
  reconciliation-aware protection submission. It never recalculates stop, target, side, quantity, or
  identity and performs no entry/cancellation/modification, exit-fill, position/PnL, reconciliation,
  provider, or PostgreSQL work.
- Deterministic real-time protection lifecycle projection accepts only Task 023
  `PROTECTION_CONFIRMED` results carrying their actual normalized acknowledgement, validates
  attempt/request/durable identity and caller-supplied observation chronology, and reuses the existing
  immutable protection acknowledgement transition for exact partial, full, and incremental coverage.
  It performs no adapter, repository, reconciliation, exit-fill, position-close, PnL, provider, or
  database work, and protection acceptance alone never implies that an exit occurred.
- Authoritative exit execution domain V1 keeps entry `FillEvent` and exit `ExitFillEvent` structurally
  distinct, requires an explicit stop/target leg and acknowledged protection-request provenance,
  and applies immutable exact-decimal partial/full exit transitions with separate deduplication,
  chronology, per-request coverage ceilings, and over-exit rejection. A full exit is terminal only
  after entry can no longer add exposure; no position, PnL, broker, persistence, or real-time exit
  projection behavior is included.
- Deterministic real-time exit-fill projection consumes only a successful Task 024 protection
  lifecycle, explicit normalized authoritative exit evidence, a caller-supplied observation boundary,
  and a replay-verifiable current execution-attempt continuation. It reuses the Task 025A constructor
  and transition for leg identity, protection provenance, chronology, exact partial/full accumulation,
  duplicate/conflict, coverage, and over-exit semantics, with no price inference, broker/repository
  call, persistence, reconciliation, position accounting, PnL, or opposite-leg cancellation.
- Authoritative position exposure V1 purely projects one `ExecutionAttempt` V2 into one immutable
  independent exposure snapshot with exact filled-minus-exited open quantity, entry-derived LONG/SHORT
  direction, and distinct no-exposure, open, partially-exited, flat-with-active-entry, and terminally
  closed states. It performs no realtime orchestration, cross-attempt netting, PnL, valuation, margin,
  broker, persistence, or reconciliation work, and historical protection coverage is not presented as
  current remaining protected exposure.
- Deterministic realtime position exposure projection consumes only actionable authoritative entry-fill
  or exit-fill results, obtains the current `ExecutionAttempt` exclusively from that successful result,
  and delegates all exposure arithmetic, direction, state, and execution-as-of ownership to the position
  engine. Rejected or non-actionable outer states do not project; exact duplicates deterministically
  replay the same snapshot without local memory, I/O, accounting, valuation, or portfolio aggregation.
- Authoritative realized trade accounting V1 purely replays one `ExecutionAttempt` V2, delegates
  direction, open quantity, lifecycle state, and as-of time to the position engine, and uses canonical
  linear instrument economics plus exact decimal FIFO matching to produce gross realized PnL,
  auditable matches, and remaining open basis. It fails closed on incoherent histories, duplicate
  identity, ambiguous equal-time cross-kind chronology, unavailable basis, and instrument mismatch;
  it performs no realtime orchestration, unrealized/net accounting, fees, FX conversion, portfolio
  aggregation, broker operation, persistence, or settlement rounding.
- Authoritative trade cost accounting V1 consumes one authoritative `ExecutionAttempt`, the canonical
  accounting specification, and explicit positive monetary `DEBIT`/`CREDIT` cost events; delegates
  execution-history validation and provenance once to realized accounting; and exactly derives gross
  debit, gross credit, and net cost in the PnL currency. It binds event identity and chronology,
  fail-closes duplicate event IDs, permits post-close settlement costs, and performs no rate/notional
  derivation, net-PnL calculation, FX, tax, slippage, portfolio aggregation, realtime orchestration,
  persistence, or side effect.
- Deterministic realtime trade cost accounting projection consumes only actionable authoritative
  entry-fill or exit-fill results and the complete set of canonical cost deliveries already observed
  at a checkpoint. It obtains the current attempt only from that lifecycle, canonicalizes deliveries,
  collapses exact same-ID same-payload transport duplicates, rejects conflicting duplicates, and
  delegates all validation and monetary accounting to the trade cost accounting engine. Rejected
  outer states do not inspect deliveries; later and post-close costs can replay against the same
  lifecycle without hidden state, future-event access, arithmetic, persistence, or side effects.
- Deterministic realtime realized accounting projection consumes only actionable authoritative
  entry-fill or exit-fill results, obtains the current `ExecutionAttempt` exclusively from that
  successful result, and delegates the complete replay to the trade-accounting engine with the
  canonical linear sizing specification. Rejected or non-actionable outer states do not project;
  exact duplicates replay the same immutable gross-realized snapshot without local FIFO/PnL state,
  broker or repository calls, persistence, or any other side effect.
- Authoritative unrealized trade valuation V1 consumes one authoritative `ExecutionAttempt`, delegates
  exposure, chronology, realized PnL, and FIFO open-basis ownership to the realized accounting domain,
  and values each current open lot at an explicit validated policy-neutral instrument/time mark using
  exact linear arithmetic. It reports gross unrealized PnL only, chooses no market price policy, uses
  no average basis or rounding, and performs no realtime orchestration, aggregation, or side effect.
- Deterministic realtime unrealized valuation projection consumes only actionable authoritative
  entry-fill or exit-fill results and an already-observed canonical trade event. It obtains the current
  attempt only from the lifecycle result, resolves the explicit `LAST_TRADE_V1` price and event-time
  mark, and delegates all accounting and valuation math to the trade-valuation engine. Rejected outer
  states do not project; duplicates and later observed trades replay deterministically without a local
  market cache, lookahead, broker/repository interaction, persistence, or other side effect.
- Authoritative trade performance snapshot V1 consumes one authoritative `ExecutionAttempt`, the
  canonical accounting specification, and an explicit valuation mark; delegates once to the
  authoritative unrealized valuation domain; and exactly adds its nested gross realized PnL and gross
  unrealized PnL. It preserves upstream exposure, lifecycle, FIFO, valuation, rejection, and as-of
  semantics without net/cost/return/portfolio calculations, realtime orchestration, or side effects.
- Deterministic realtime trade performance projection consumes only an authoritative realtime
  valuation result, preserves source/lifecycle/mark-policy provenance, and delegates gross
  aggregation to the authoritative trade performance engine without rerunning valuation or doing
  financial arithmetic.
- Authoritative net trade performance snapshot V1 combines complete gross-performance and
  cost-accounting authorities for one coherent trade state and introduces only exact
  `netTotalPnl = grossTotalPnl - netCostAmount`. It preserves gross and cost components, nested
  authority references, and separate execution, valuation, and cost clocks; permits late post-close
  costs; and deliberately defers net realized/unrealized attribution, FX, tax, slippage, portfolio,
  realtime, persistence, and side-effect behavior.
- Deterministic realtime net trade performance projection consumes only Task029B and Task030B
  authority results, requires source-kind and projection-state coherence, preserves their upstream
  statuses independently, and delegates the two projected snapshots once to the authoritative net
  engine. It supports gross-only and cost-only evidence advances, including late closed-trade costs,
  without upstream recomputation, arithmetic, hidden state, lookahead, or side effects.
- PostgreSQL and Redis-backed infrastructure where later requirements justify them.
- Python tooling for quantitative research, backtesting, and machine learning where later requirements justify it.
- Containerization and continuous integration in later engineering phases.
- Position trading first, with intraday and scalping modes considered only in later phases.
- Account-level capital eligibility uses explicit caller-configured per-trade, aggregate, concurrent-position, daily-loss, and risk-group limits after structural risk qualification; it does not calculate quantity or authorize execution.
- Position sizing converts an approved requested monetary-risk budget into an exact step-aligned quantity under an explicit linear PnL specification and optional point-in-time FX conversion; it cannot increase approved risk or authorize execution.
- Trade-intent orchestration requires a coherent same-time setup, structural-risk, portfolio-risk, and position-sizing chain and copies their authoritative values into a deterministic immutable handoff; it is not an order and cannot authorize execution.
- Execution preparation validates freshness, current-market validity, and exact venue-neutral price/quantity representability before producing a deterministic broker-neutral plan; it does not round, submit, or authorize an order.
- Execution policy creates deterministic attempts and idempotent broker-neutral entry, protection, fill, and cancellation lifecycles from ready plans; protection can cover only confirmed fills and requires adapter-declared non-reversing exit safety.
- Broker-adapter infrastructure requires explicit execution environments, opaque credential references, durable atomic idempotency claims, deterministic request fingerprints, conservative unknown-outcome reconciliation, and sanitized audit contracts before concrete integrations are added.
- Durable execution orchestration claims before submission, persists a may-have-started marker before adapter I/O, blocks ambiguous restart states pending reconciliation, and permits retry only with the same key and fingerprint after definite non-submission.
- PostgreSQL execution persistence provides environment-bound atomic idempotency claims, immutable and monotonic durable outcomes, and append-only sanitized broker audits without owning connections or broker APIs.

## Not yet specified

- Trading strategies, entry/exit rules, and instrument eligibility beyond the explicitly documented V1 portfolio capital and linear position-sizing limits.
- Supported asset classes, exchanges, brokers, symbols, markets, and jurisdictions.
- Market-data vendors, required feeds, canonical data formats, and fallback policies.
- Regime, structure, liquidity, setup, prediction, and validation algorithms.
- Concrete venue order mappings and venue-specific reconciliation providers.
- User roles, authentication, authorization, dashboard behavior, and extension UX.
- Service-level objectives, deployment topology, retention periods, and operational budgets.
- Regulatory, legal, compliance, and reporting requirements.
