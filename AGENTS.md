# Engineering constitution

Read `PROJECT_SPEC.md` and relevant docs before changing architecture. The repository map is: deployables in `apps/`, reusable domain code in `packages/`, quantitative work in `research/`, cross-cutting tests in `tests/`, and durable decisions in `docs/`.

## Mandatory rules

- Never change trading semantics silently.
- Never place trading calculations only in UI code.
- Never put secrets in frontend code or commit `.env` files containing secrets.
- Never let an LLM response directly execute a live trade.
- Live trading eventually requires deterministic `RiskEngine` approval.
- Minimum official generated signal reward-to-risk is 3.00 net of configured costs.
- Backtest and live systems must share the same `trading-core` implementation.
- Every trading rule change must have regression tests.
- Every execution request must eventually be idempotent.
- Use UTC internally.
- Use decimal-safe arithmetic for money, price, and quantity calculations.
- Do not silently substitute unavailable market data.
- No production feature is complete without appropriate tests.
- Prefer small, focused changes; do not perform unrelated refactors.
- Do not add dependencies without a concrete requirement.

