# Deterministic live trading orchestration core V1

## Purpose and boundary

`@ulte/live-trading-orchestration-engine` is the pure planning half of the Option-D architecture:
observed evidence or one existing ULTE API result enters `planLiveTradingStep`, which returns an
immutable session plus zero or one frozen invocation descriptor. Task033A never executes that
descriptor. Task033B owns stateful engine instances, serialized command execution, broker and
repository coordination, and delivery of each result back to the planner.

The V1 planner is synchronous, deterministic, stateless outside its input session, and has no I/O.
It performs no risk, quantity, price, PnL, cost, or R arithmetic. Commands contain only exact
caller-supplied inputs or existing authority references for public ULTE APIs.

## Session and execution authority

One `LIVE_TRADING_ORCHESTRATION_SESSION_V1` represents one instrument and at most one execution
attempt identity. It may retain only the latest authoritative `ExecutionAttempt` reference, the
immutable original `TradeRiskBasis` reference, and the latest successful realtime R projection
reference. It does not copy or merge their fields, keep an execution phase enum, or contain any
engine, service, adapter, repository, cost ledger, fill ledger, or protection ledger.

`ExecutionAttempt` V3 remains the sole execution lifecycle authority. A successful result that
contains a replacement aggregate is adopted by exact reference. Evidence for another attempt or
instrument fails closed. V1 deliberately requires a new orchestration session before another
attempt identity, even if the retained attempt appears terminal.

## Modes and side-effect safety

Only `DRY_RUN` and `SANDBOX` are representable. `LIVE` cannot be created and a caller-supplied LIVE
execution context is rejected. DRY_RUN planning never emits an entry- or protection-submission
descriptor. SANDBOX may emit only a descriptor for the existing realtime submission or protection
coordinator, using exact fresh caller context; the planner itself still performs no broker call.

Existing broker/reconciliation idempotency remains authoritative. The planner creates no command,
operation, fill, or idempotency identity and reads no clock or randomness.

## Serialized routing

Every call accepts one observed input and emits at most one command. Market ingestion, analysis,
decision, preparation, execution lifecycle, and projection work therefore advance through successive
result inputs. Independent position, realized-accounting, valuation, and cost projections use
explicit caller-supplied public inputs so the planner never retains mutable account, quote, policy,
mark, or cumulative-cost context merely for convenience. Valuation may route to gross performance;
complete caller-supplied gross and cost authorities may route to net performance; net performance
may route to R only after the session has retained the original risk-basis authority.

Valid duplicates, non-actionable states, and upstream rejections return frozen no-action results and
preserve the observed result reference. Duplicate fill evidence never creates another protection
submission. Downstream pure projection packages that explicitly accept duplicates can still be
invoked through their own request variants.

## Explicit V1 limitations

- One instrument and one attempt identity per session.
- The caller/runner must serialize `planLiveTradingStep` per session; V1 has no lock or mutex.
- There is no exit-order submission, cancellation, replacement, or inferred market close. Only
  explicit authoritative exit-fill evidence can be routed to the existing exit-fill projection.
- `restartRecoverySupported` is `false`. A process restart loses the in-memory orchestration session;
  deterministic replay is not durable crash recovery.
- No portfolio-wide atomic admission, global kill switch, provider transport, persistence, database,
  network, or production LIVE readiness is claimed.

Equivalent fresh sessions and the same ordered immutable inputs produce equivalent routing outputs.
Phase33 owns persistence and recovery; Task033B owns the thin imperative runner and per-session
serialization.
