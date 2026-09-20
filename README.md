# ULTE

ULTE (Universal Live Trading Engine) is a planned multi-application platform for research, signal generation, risk-controlled execution, and trading operations across multiple instruments and venues.

This repository currently contains **Phase 0 only**: the engineering foundation. It intentionally contains no strategies, integrations, data pipelines, execution paths, or user interfaces.

## Repository guide

- [`PROJECT_SPEC.md`](PROJECT_SPEC.md) — confirmed scope, future requirements, and open product questions
- [`ARCHITECTURE.md`](ARCHITECTURE.md) — intended components and dependency boundaries
- [`ROADMAP.md`](ROADMAP.md) — milestone sequence
- [`AGENTS.md`](AGENTS.md) — mandatory rules for contributors and coding agents
- [`docs/decisions`](docs/decisions) — architecture decision records

## Layout

- `apps/` — deployable applications and bridges
- `packages/` — reusable TypeScript domain and infrastructure packages
- `research/` — future quantitative research and validation work
- `tests/` — cross-package integration, regression, and end-to-end tests
- `docs/` — focused architecture, trading, execution, security, validation, and decision records

## Toolchain

- Node.js 24 LTS (see `.nvmrc`)
- pnpm 10+
- TypeScript with strict shared defaults

Install dependencies only when an implementation phase requires them. After pnpm is available, `pnpm install` will create the lockfile and install the declared TypeScript toolchain.

