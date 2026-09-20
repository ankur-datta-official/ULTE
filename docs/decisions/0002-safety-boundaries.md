# ADR 0002: Deterministic live-trading safety boundaries

- Status: Accepted
- Date: 2026-09-21

## Context

Live trading can create irreversible financial effects. Generated analysis, probabilistic components, UI behavior, and language-model output are not sufficient authorization to place an order.

## Decision

No LLM response may directly authorize or execute a live trade. Every future live execution request must pass deterministic `RiskEngine` approval, include an idempotency mechanism, and produce an auditable record. Official generated signals must meet a minimum projected reward-to-risk ratio of 3.00 after configured costs.

Calculations involving money, price, or quantity use decimal-safe arithmetic; internal timestamps use UTC. Secrets stay outside frontend bundles and version control. Missing market data is surfaced explicitly rather than silently substituted.

## Consequences

Execution paths must fail closed when approval, required data, or auditability is unavailable. Trading-rule changes require regression coverage. The exact risk rules, audit schema, and idempotency design remain future decisions.

