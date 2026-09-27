# Controlled durable real-time protection submission orchestration V1

## Architectural position and eligibility

`@ulte/realtime-execution-protection-engine` follows Task 022's deterministic entry-fill projection.
It consumes the actual `RealtimeExecutionFillResult`, and only a new `FILL_APPLIED` result is
actionable. `NO_FILL_PROCESSING`, `FILL_REJECTED`, and `DUPLICATE_FILL` produce an immutable
`NO_PROTECTION_ACTION` without requiring context, resolving an adapter, claiming durable state, or
calling an adapter. A duplicate fill therefore cannot become permission for a second protection
submission.

For a new applied fill, `requestProtection` remains the authoritative eligibility and request
transition. Non-actionable execution states, absent unprotected exposure, failed protection, and
unsupported policy states stop before durable work. The package does not infer eligibility from the
Task 022 status alone.

## Existing partial-fill and protection-mode semantics

The existing execution policy explicitly supports incremental protection after partial fills. A
request covers exactly `filledEntryQuantity - protectedQuantity`, while its cumulative target is the
current `filledEntryQuantity`. Task 023 performs no arithmetic itself: it submits the exact
`ProtectionRequest` returned by `requestProtection`. Full fills use the same transition and cover the
exact remaining unprotected quantity. Stop trigger, target, exit side, quantity, protection mode,
request identity, and idempotency key all originate from the existing `ExecutionAttempt` policy.

`requestEntrySubmission` selects `NATIVE_BRACKET` when the adapter declares native bracket support;
otherwise it selects `MANAGED_PROTECTION` only when close-only exit and partial-fill reporting are
available. In the current V1 contract, the entry request contains no attached stop or target and
there is no reachable state meaning native protection was already established by entry submission.
Consequently both selected modes use the existing post-fill `requestProtection` and
`submitProtection` path. Task 023 does not fabricate an already-protected native state and would not
submit when existing policy reports no unprotected quantity.

## Caller controls and adapter policy

Only an actionable request requires context: execution environment, adapter ID, opaque
`CredentialProfileRef`, and explicit `protectionAsOf`. The time is validated as `UnixMs` and must be
at least `executionAttempt.lastExecutionEventAt`. No wall clock is read. There is deliberately no
maximum protection age: blocking risk-reducing protection merely because exposure is old would add
risk and is not an existing policy rule.

DRY_RUN and SANDBOX are supported. LIVE is hard-blocked as `LIVE_EXECUTION_DEFERRED` before registry
resolution, durable mutation, or adapter I/O, with no override. The existing `BrokerAdapterRegistry`
must resolve the requested adapter and match environment and opaque credential profile. Its current
capabilities must exactly match the capabilities bound to the execution attempt; drift or unsafe
capability state is blocked before claim. There is no provider-specific code or credential material.

## Durable idempotent protection submission

Task 023 delegates the policy-produced request to `orchestrateProtectionSubmission`. The existing
durable invariant is preserved:

```text
atomic claim -> durable SUBMITTED -> adapter.submitProtection -> durable outcome
```

CONFIRMED and REJECTED records replay without a second adapter call, including after engine
recreation with the same repository. Existing CLAIMED, SUBMITTED, and OUTCOME_UNKNOWN records return
`RECONCILIATION_REQUIRED` and are never blindly resubmitted. A thrown adapter failure that may have
crossed the external boundary is durably marked uncertain and also requires reconciliation.
Environment conflicts remain durable idempotency conflicts, and changing an otherwise valid opaque
credential profile cannot create a second submission for an already claimed request. Concurrent
identical calls are arbitrated by the durable repository, not an engine mutex.

This is durable idempotent protection submission with reconciliation for uncertain outcomes, not
exactly-once broker execution. Task 023 does not perform reconciliation.

## Boundary and integration coverage

A protection acknowledgement is preserved as an acknowledgement; it is not an exit fill, a closed
position, profit, or loss. The returned execution attempt remains at the existing policy's
`PROTECTION_PENDING` submission boundary. Applying protection acknowledgements/rejections to the
execution lifecycle, protection fills, exit fills, modification, replacement, cancellation,
position accounting, and PnL are deferred.

The package submits no entry, cancels no entry, accepts no new market quote, reprices nothing, and
contains no retry loop, provider/network implementation, PostgreSQL dependency, timer, randomness,
or floating-point price/quantity calculation. Integration coverage independently drives historical
replay and normalized live ingestion through shared candles, analysis, decision, preparation,
durable SANDBOX entry submission, normalized full fill, and durable protection submission. The
branches use isolated adapters and repositories and compare all deterministic identities and
outcomes.
