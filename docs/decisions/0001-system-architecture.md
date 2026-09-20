# ADR 0001: Modular monorepo with shared trading core

- Status: Accepted
- Date: 2026-09-21

## Context

ULTE will include multiple user interfaces, execution integrations, analytical engines, and both backtest and live workflows. Divergent implementations of trading rules would make validation unreliable and production behavior unsafe.

## Decision

Use a pnpm TypeScript monorepo. Deployable processes live in `apps/`; reusable capabilities live in narrowly scoped `packages/`; quantitative work lives in `research/`. Backtest and live workflows consume the same authoritative `trading-core`. UI applications depend on APIs and contracts and contain no authoritative trading or risk decisions.

Python may be introduced for research, but production trading semantics must be promoted deliberately into the tested shared core. Venue-specific behavior remains behind adapters.

## Consequences

The repository supports focused ownership and incremental extraction into services if operational needs arise. Package boundaries and dependency direction require enforcement as implementation begins. Research prototypes cannot silently become production rules.

