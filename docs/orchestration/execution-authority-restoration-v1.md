# Execution authority restoration and orchestration hydration V1

## Boundary and authority model

`@ulte/execution-engine` restores execution authority from
`EXECUTION_ATTEMPT_RECOVERY_EVIDENCE_V1`. Arbitrary `ExecutionAttempt` JSON deserialization is
prohibited: a final aggregate contains derived lifecycle state, cumulative quantities, and embedded
history whose mutual coherence cannot be established by object shape alone. Initialization now
contains `READY_EXECUTION_PLAN_RECOVERY_DATA_V2`, its expected stable execution identity, and an
explicitly ordered list of canonical lifecycle inputs. The evidence is plain data and does not claim
`ReadyExecutionPlan` authority.

`@ulte/execution-preparation-engine` owns `restoreReadyExecutionPlan`. V2 first calls
`restoreReadyTradeIntent`, then reconstructs the historical quote, execution specification,
configuration, and execution as-of through their normal constructors. It passes those exact inputs
to `prepareExecutionPlan`. Only `EXECUTION_PLAN_READY` succeeds, and the exact plan object returned
by that authority call is exposed; recovery never builds, patches, or clones a plan. A complete
expected-plan selector verifies the replayed result but supplies none of its authority. Legacy
`READY_EXECUTION_PLAN_RECOVERY_DATA_V1` remains a type-level compatibility artifact and is rejected
as unsupported because its plan-shaped checkpoint lacks the historical authority inputs required
for replay.

The normal preparation input graph is:

| Input | Authority owner | Canonical restoration | Historical value | Coherence |
| --- | --- | --- | --- | --- |
| `tradeIntent` | trade-intent engine | `restoreReadyTradeIntent` | complete PRE1 evidence | exact returned `tradeIntent` reference |
| `marketSnapshot` | execution-preparation engine | `createExecutionMarketSnapshot` | instrument, as-of, bid, ask | canonical instrument/time/decimals and non-crossed quote |
| `instrumentExecutionSpec` | execution-preparation engine | `createInstrumentExecutionSpec` | instrument, tick, step, min, max | canonical values, ordered range, step-aligned bounds |
| `config` | execution-preparation engine | `createExecutionPreparationConfig` | all three configured limits | bounded non-negative safe integers |
| `executionAsOf` | instrument model | `unixMs` | exact preparation time | chronology remains owned by `prepareExecutionPlan` |

Execution recovery validates the plain outer envelope, restores preparation authority exactly once,
passes that exact plan to `createExecutionAttempt`, checks the derived attempt identity, and then
replays transitions in caller-supplied order. It does not sort by timestamps. The execution engine
remains the sole authority for chronology, idempotency, fill and exit accumulation, protection
coverage, cancellation, and lifecycle state. Success exposes both the exact restored plan and the
exact attempt reference returned by the final transition, or the exact initial attempt when no
transitions exist.

The plan ID length-prefixes the plan schema, trade-intent ID, preparation and quote times, bid, ask,
entry side, quantity, entry price, stop price, and target price. It does not independently cover
candidate ID, instrument ID, intent time, direction, exit side, quantity unit, account currency,
tick, step, derived ages/deviation, approved or actual risk, net reward-to-risk, or instruction kinds
and effects. The V2 selector therefore binds every exposed non-constant plan field, including all
three complete instructions, and is used only for equality verification after normal replay.

The evidence-to-transition mapping is:

| Evidence kind | Existing execution-engine API |
| --- | --- |
| initialization checkpoint | `restoreReadyExecutionPlan` → `createExecutionAttempt` |
| `ENTRY_SUBMISSION_REQUESTED` | `requestEntrySubmission` |
| `ENTRY_SUBMISSION_ACKNOWLEDGED` | `acknowledgeEntrySubmission` |
| `ENTRY_SUBMISSION_REJECTED` | `rejectEntrySubmission` |
| `ENTRY_FILL_APPLIED` | `applyEntryFill` |
| `PROTECTION_REQUESTED` | `requestProtection` |
| `PROTECTION_ACKNOWLEDGED` | `acknowledgeProtection` |
| `PROTECTION_REJECTED` | `rejectProtection` |
| `ENTRY_CANCELLATION_REQUESTED` | `requestEntryCancellation` |
| `ENTRY_CANCELLATION_ACKNOWLEDGED` | `acknowledgeCancellation` |
| `ENTRY_CANCELLATION_REJECTED` | `rejectCancellation` |
| `EXIT_FILL_APPLIED` | `applyExitFill` |

Structural validation and lifecycle acceptance are distinct. The validator rejects unsupported
schemas, non-plain/non-JSON-safe data, malformed canonical inputs, and identity conflicts. A
structurally valid sequence may still be rejected by execution authority when replay finds an
illegal transition, out-of-order event, overfill, coverage violation, or conflicting duplicate.
Identical fill and exit duplicates retain the execution engine's existing idempotent semantics.

## Pure restoration and excluded side effects

Restoration is synchronous and local. Replaying acknowledgement evidence applies only the pure
execution lifecycle transition for an acknowledgement that is already established; it never submits
an order. V1 performs no broker operation, resubmission, reconciliation, retry, repository access,
database work, network I/O, generated identity, wall-clock read, or financial arithmetic.

Phase33B owns durable orchestration storage. Phase33C owns recovery boot coordination and ambiguous
side-effect reconciliation. This phase does not hydrate live ingestion, realtime analysis, realtime
decision, or realtime execution-preparation engines. Market-stream state recovery remains
unsupported.

## Exact-reference orchestration hydration

`hydrateLiveTradingOrchestrationSession` accepts a current session schema and canonical DRY_RUN or
SANDBOX identity plus optional already-authoritative `ExecutionAttempt`, `TradeRiskBasis`, and latest
projected realtime R result. It never accepts raw fill, quantity, cost, PnL, protection, or lifecycle
fields and does not parse durable JSON.

Hydration assembles one coherent frozen graph without cloning or patching authority objects. The
execution attempt must use the current schema and session instrument. A risk basis is recreated by
calling `createTradeRiskBasisFromExecutionAttempt(restoredAttempt)` and must match every trade
identity field. If latest R is retained, it must be a projected result for the same trade and its
snapshot must refer to the exact supplied risk-basis object. Equal-by-value but different risk-basis
references are rejected. When no coherent authoritative latest-R result is available, callers omit
it and recompute it later through existing projection APIs.

Hydration does not construct or start `SandboxOrchestrationRunner`. It adds no persistence or LIVE
capability and does not change Task033A planner routing semantics or Task033B runner behavior.
