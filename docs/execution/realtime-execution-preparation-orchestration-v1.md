# Real-time execution-preparation orchestration V1

## Architectural position

`@ulte/realtime-execution-preparation-engine` is the provider-neutral, in-process boundary between
Task 019 real-time decisions and the existing `@ulte/execution-preparation-engine`. It accepts one
immutable `RealtimeDecisionResult`, optionally prepares its ready trade intent, publishes an
immutable orchestration outcome, and stops. It has no execution-policy, broker-adapter, network,
persistence, reconciliation, acknowledgement, fill, cancellation, or submission behavior.

A trade intent is not an order. An `EXECUTION_PREPARED` result is also not an order authorization;
it contains the existing broker-neutral execution plan and nothing downstream is invoked.

## Accepted Task 019 outcomes

`NO_DECISION`, `DECISION_REJECTED`, and `DUPLICATE_DECISION` become `NO_PREPARATION`. They neither
require nor validate execution context and never call the preparation evaluator. In particular, a
Task 019 duplicate does not contain the original trade intent, so V1 returns
`DUPLICATE_DECISION_INPUT` rather than reconstructing upstream data. Callers that need replayed
prepared output must retain the original Task 020 result.

Only `TRADE_INTENT_CREATED` may reach execution preparation. It must carry an `INTENT_READY` result
whose `asOf` exactly equals the decision's `analysisAsOf` and `triggerCloseTime` boundary.

## Caller-owned execution context and engine reuse

For an actionable decision the caller supplies one explicit `preparationAsOf` observation boundary,
the existing market-snapshot input, instrument execution-spec input, and preparation configuration.
The orchestrator performs no quote, broker, account, database, environment, or clock lookup. It
rebuilds the context with the existing public constructors, which copy, validate, and freeze the
values, then calls the existing `prepareExecutionPlan` API exactly once.

Direction/side mapping, current-market gates, deviation, freshness, tick and quantity-step
representability, and execution-plan identity remain owned by the existing preparation engine.
Its `PLAN_NOT_PREPARABLE`, `DATA_REJECTED`, and other non-ready outcomes are preserved verbatim inside
`PREPARATION_REJECTED`; `EXECUTION_PLAN_READY` is preserved inside `EXECUTION_PREPARED`.

## Time, freshness, and no-lookahead

`preparationAsOf` maps directly to the existing engine's `executionAsOf`. A quote may be later than
the historical decision boundary because it is an observable execution quote, but it may not be
later than `preparationAsOf`. The existing engine also enforces that the quote does not predate the
intent and that intent and quote ages remain within the caller's explicit limits. Task 020 does not
weaken those rules or consult a hidden wall clock. Later fill, account, or broker state is absent.

## Identity, idempotency, and monotonic safety

The preparation profile uses fixed-order, length-prefixed fields covering the orchestration profile
version, preparation policy, and venue-neutral execution constraints. The preparation-cycle identity
combines that profile identity with the Task 019 `decisionCycleId`; it does not replace the existing
execution-plan identity. The context fingerprint adds only the observation boundary and quote fields
that can change preparation behavior. No arbitrary JSON, random ID, clock, or sorting is used.

Completed outcomes are retained in a bounded positive-safe-integer FIFO window. An exact retained
repeat returns `DUPLICATE_PREPARATION` without evaluator work; changed retained context is a hard
`PreparationContextConflictError`. The bounded cache is only a replay optimization. An independent
greatest-published upstream decision-boundary watermark rejects any evicted attempt at or before the
latest boundary, so a newer quote cannot reopen an old trading decision.

## Atomicity, immutability, and retryability

Caller/API validation and required evaluator work complete before retention or watermark mutation.
Expected preparation rejection is a finalized deterministic outcome. Malformed context and an
unexpected evaluator throw publish nothing and leave the same decision retryable. Caller decisions
and context are not mutated; published records and reconstructed context follow package freeze
conventions, and internal maps never escape.

## Live/replay equivalence and deferred work

Integration coverage drives real historical replay and real live ingestion through the shared candle
engine, Task 018 analysis, Task 019 decision/risk, and Task 020 preparation. Equivalent supplied
execution context produces equal no-preparation outcomes, identities, ready plans, and deterministic
preparation rejections.

Execution policy, broker adapters, submission, protection lifecycles, fills, cancellation,
reconciliation, durable idempotency, PostgreSQL state, provider transports, and concrete venue APIs
are explicitly deferred.
