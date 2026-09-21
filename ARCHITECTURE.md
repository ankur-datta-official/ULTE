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
- `backtest-engine` owns deterministic historical replay and reuses `market-data` candle processing.
- `trading-core` owns shared strategy contracts and deterministic trading semantics used by both live and backtest paths.
- `regime-engine`, `structure-engine`, `setup-engine`, and `prediction-engine` provide focused analysis capabilities without UI dependencies.
- `setup-engine` consumes public regime and structure evidence plus closed setup-timeframe candles; it emits setup candidates, not executable trade signals.
- `risk-engine` deterministically qualifies structural risk and enforces the official net RR floor; `portfolio-risk-engine` separately decides whether requested monetary risk fits explicit account-level capital policy; `position-sizing-engine` converts that approved requested risk into a conservative step-aligned quantity using explicit instrument economics. `trade-intent-engine` verifies and combines those authoritative outputs into a deterministic handoff snapshot without recalculating them. None of these results is an execution instruction.
- `execution-engine` coordinates idempotent, auditable execution requests only after risk approval.
- `broker-adapters` isolates venue-specific protocols and credentials.
- `shared` contains genuinely cross-cutting primitives only; it must not become a miscellaneous domain package.

Dependencies flow from applications and adapters toward stable domain contracts. Domain packages must not import application or UI code. Broker-specific types must not leak into trading rules. Cross-package cycles are prohibited.

## Cross-cutting constraints

All internal times are UTC. Financial values use decimal-safe representations. Missing or stale data is explicit and must never be silently replaced. Secrets remain server-side. Material decisions and execution events must eventually be traceable through durable audit records.

Python research code may explore ideas, but a production rule requires an explicit, tested implementation in the shared trading core. See the decision records in `docs/decisions/` for the governing rationale.
