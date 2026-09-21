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
- PostgreSQL and Redis-backed infrastructure where later requirements justify them.
- Python tooling for quantitative research, backtesting, and machine learning where later requirements justify it.
- Containerization and continuous integration in later engineering phases.
- Position trading first, with intraday and scalping modes considered only in later phases.
- Account-level capital eligibility uses explicit caller-configured per-trade, aggregate, concurrent-position, daily-loss, and risk-group limits after structural risk qualification; it does not calculate quantity or authorize execution.
- Position sizing converts an approved requested monetary-risk budget into an exact step-aligned quantity under an explicit linear PnL specification and optional point-in-time FX conversion; it cannot increase approved risk or authorize execution.

## Not yet specified

- Trading strategies, entry/exit rules, and instrument eligibility beyond the explicitly documented V1 portfolio capital and linear position-sizing limits.
- Supported asset classes, exchanges, brokers, symbols, markets, and jurisdictions.
- Market-data vendors, required feeds, canonical data formats, and fallback policies.
- Regime, structure, liquidity, setup, prediction, and validation algorithms.
- Execution workflows, order types, reconciliation rules, and failure recovery behavior.
- User roles, authentication, authorization, dashboard behavior, and extension UX.
- Service-level objectives, deployment topology, retention periods, and operational budgets.
- Regulatory, legal, compliance, and reporting requirements.
