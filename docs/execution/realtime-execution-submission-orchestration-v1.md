# Controlled durable real-time execution submission orchestration V1

## Architectural position

`@ulte/realtime-execution-submission-engine` is ULTE's first external side-effect boundary. It
accepts Task 020 results and permits only an `EXECUTION_PREPARED` result to reach the existing
entry-submission policy and durable reconciliation-aware orchestrator. A prepared plan is not
permission to submit: environment, caller time, plan age, adapter descriptor, credential profile,
and execution-policy controls all pass before any durable claim.

`NO_PREPARATION`, `PREPARATION_REJECTED`, and `DUPLICATE_PREPARATION` return `NO_SUBMISSION`. These
branches require no submission context and perform no registry lookup, durable operation, adapter
call, or broker-submission audit operation.

## Controlled environment and caller context

The caller supplies an explicit `executionEnvironment`, adapter ID, opaque `CredentialProfileRef`,
and `submissionAsOf`. V1 permits `DRY_RUN` and `SANDBOX` only. A syntactically valid `LIVE` request
returns `SUBMISSION_BLOCKED / LIVE_EXECUTION_DEFERRED` before adapter resolution, durable mutation,
or adapter I/O. There is no activation switch or environment-variable escape hatch.

Raw keys, secrets, passwords, private keys, and tokens are absent from the public context. Registry
resolution must find the requested adapter, and its immutable descriptor must match both the
requested environment and opaque credential-profile reference.

`submissionAsOf` is caller-owned Unix milliseconds; no wall clock is read. It cannot precede Task
020's `preparationAsOf`. The inclusive freshness rule is
`submissionAsOf - preparationAsOf <= maxPreparedPlanAgeMs`. An older plan is blocked as
`PREPARED_PLAN_EXPIRED` before durable claim or adapter I/O. The plan is never repriced, resized,
or recalculated; the caller must obtain a new upstream preparation.

## Existing policy and durable orchestration reuse

Task 021 passes the exact ready plan to `createExecutionAttempt`, then uses
`requestEntrySubmission` for deterministic side, attempt, and idempotency identities and adapter
capability policy. It calls only `orchestrateEntrySubmission`. That existing orchestration remains
authoritative for deterministic request fingerprints, atomic claim-before-submit, the durable
`SUBMITTED` marker before adapter I/O, normalized failures, audit delivery, durable outcomes, and
cross-environment conflict protection.

Resolved `CONFIRMED` and `REJECTED` records replay without adapter I/O, including after constructing
a new Task 021 engine over the same durable repository. Existing `CLAIMED`, `SUBMITTED`, and
`OUTCOME_UNKNOWN` records return reconciliation-required outcomes without resubmission. An adapter
throw that may follow submission therefore never causes a blind retry. Definite retry and
do-not-retry classifications are preserved from the durable orchestrator; Task 021 adds no retry
loop and performs no reconciliation.

This is durable idempotent submission with reconciliation for uncertain outcomes, not a claim of
exactly-once broker execution. The package depends only on the durable repository interface and
does not instantiate or import PostgreSQL.

## Entry-only boundary and acknowledgement semantics

Task 021 may call `submitEntry` once for a newly claimed operation. It never calls
`submitProtection` or `cancelEntry`, processes fills, accumulates filled quantity, manages
positions, closes exposure, or calculates PnL. An adapter `SUBMISSION_ACCEPTED` acknowledgement is
preserved as an acknowledgement; it is not a fill or an open position.

No provider SDK, provider symbol, network transport, market-data fetch, new quote, concrete broker,
or raw credential is present. Provider integration, LIVE rollout, fill processing, protection,
cancellation, position lifecycle, and reconciliation execution remain deferred.

## Integration coverage

Tests drive equivalent deterministic events through both `HistoricalReplayEngine ->
MultiTimeframeCandleEngine` and `LiveTradeIngestionEngine`, then through real-time analysis,
decision, preparation, and Task 021 submission. The branches use isolated durable repositories and
fake SANDBOX adapters, and compare upstream cycle identities, prepared plan identity, durable entry
request identity, submission outcome, and normalized acknowledgement.
