# Execution risk-currency provenance V1

Position sizing is the authority for `actualRiskAmount` and establishes that it is denominated in
`accountCurrency`. `ReadyTradeIntent` already preserves that pair. `EXECUTION_PLAN_V2` now requires
and copies the same `accountCurrency`, and `EXECUTION_ATTEMPT_V3` validates and copies it again.

The authoritative path is:

`ReadyTradeIntent.accountCurrency` -> `ReadyExecutionPlan.accountCurrency` ->
`ExecutionAttempt.accountCurrency`

Every execution-attempt transition preserves the value through immutable copying. The denomination
is never inferred from `pnlCurrency`, and this domain performs no FX conversion or risk
recomputation. Execution plan and attempt identity algorithms are unchanged because the existing
trade-intent identity already binds `accountCurrency`.

This provenance enables Task032A to require same-currency evidence before comparing PnL with actual
risk. Task032A and net R-multiple calculation remain outside this phase.
