# Real-time decision and risk orchestration V1

## Architectural position

`@ulte/realtime-decision-engine` is the provider-neutral, in-process boundary immediately after
`@ulte/realtime-analysis-engine`. It consumes one immutable Task 018 `AnalysisCycleResult` and, only
when exactly one confirmed setup is actionable, coordinates the existing structural-risk,
portfolio-risk, position-sizing, and trade-intent engines. It stops at `TradeIntent`; it has no
execution preparation, broker, network, persistence, provider, or account-fetching behavior.

## Accepted analysis and no-decision outcomes

The engine accepts Task 018 `INSUFFICIENT_HISTORY`, `NO_SETUP`, and `ANALYZED` cycles. Insufficient
history, no setup, a setup evaluator that is not ready, and an analyzed cycle with no confirmed
candidate publish an explicit `NO_DECISION` result without invoking any risk engine. Armed setups
remain non-actionable.

Task 018 setup candidate order is preserved. Because the current portfolio-risk API evaluates one
proposal against one immutable account snapshot and defines no intra-cycle reservation contract,
V1 fails closed when more than one confirmed candidate is present. It returns
`MULTIPLE_ACTIONABLE_CANDIDATES_UNSUPPORTED`, creates no intent, and does not select, rank, or
evaluate a candidate. This also prevents sibling proposals from being independently approved
against unchanged capacity.

## Caller context and fixed stage order

For exactly one confirmed candidate, the caller supplies the existing risk cost and qualification
configuration, account-risk snapshot, requested monetary risk, proposed risk groups, portfolio
policy, linear sizing specification, and optional FX snapshot. The package performs no lookup and
does not infer capital, costs, groups, currencies, or instrument economics.

The only evaluation order is:

```text
confirmed setup
  -> structural risk
  -> portfolio/capital risk
  -> position sizing
  -> trade intent
  -> stop
```

Each stage calls its existing public engine. A non-qualified or data-rejected structural result, a
blocked or rejected portfolio result, or a non-sizeable/rejected sizing result immediately returns
`DECISION_REJECTED` with the actual evaluated upstream records. No downstream result is fabricated.
The existing trade-intent engine retains ownership of intent identity and final coherence checks.

## As-of, no-lookahead, and immutability

`analysisAsOf` must equal `triggerCloseTime`. A ready setup evaluation and every confirmed candidate
must have that exact as-of. Before any risk evaluator runs, the account snapshot and any supplied FX
snapshot must also have that exact as-of. Future and stale context are both contract errors; they do
not publish or poison the boundary. Setup candles come only from the matching immutable Task 018
frame, so unfinished or future candles and current live-candle state cannot enter this layer.

Context is reconstructed through the existing public validators into immutable values. The caller's
analysis, account, positions, groups, policies, sizing inputs, and FX snapshot are never mutated.
Published orchestration records are frozen, and upstream engine results retain their own immutable
public forms. Monetary, price, quantity, cost, FX, and ratio calculations remain exclusively in the
existing decimal-safe engines.

## Identity, idempotency, and monotonic publication

The decision profile identity uses fixed-order, length-prefixed encoding over the explicit profile
version and behaviorally relevant risk, portfolio, and sizing policy. The decision-cycle identity
uses the same collision-safe encoding over the Task 018 analysis-cycle identity and decision profile
identity. It uses no JSON serialization, random value, UUID, clock, or unordered record iteration.

The decision-context fingerprint contains only behaviorally relevant account, request, policy,
sizing, and FX fields. Account positions, position group memberships, and configured group limits
are canonicalized because those domain collections are set-like. Proposed risk groups retain caller
order because the portfolio engine uses that order to select the first failing group. Candle and
candidate chronology is never sorted or repaired.

An exact retained analysis-cycle/context repeat returns `DUPLICATE_DECISION` and runs no evaluator.
The same retained cycle with materially changed context throws a hard conflict. Recent completed
records use a configured positive safe-integer bound and deterministic FIFO eviction without time.
Correctness does not depend on that cache: an independent greatest-published-boundary watermark
prevents any new attempt at or before an already published boundary after eviction.

Input validation and all required evaluation complete before publication state changes. Expected
no-decision and engine-rejection outcomes finalize the boundary. If an evaluator unexpectedly
throws, neither the recent record nor watermark advances, so the identical cycle can be retried.

## Live/replay equivalence and deferred behavior

Equivalent live-ingestion and historical-replay paths already converge on the same Task 018 analysis
cycle. Given equivalent analysis identity and the same caller context, this layer produces equivalent
structural-risk, portfolio-risk, sizing, and trade-intent results. Live-only ingestion metadata is
not consumed.

Execution preparation, current-quote freshness, venue constraints, margin, order planning,
submission, broker adapters, durable persistence, and reconciliation are intentionally deferred.
