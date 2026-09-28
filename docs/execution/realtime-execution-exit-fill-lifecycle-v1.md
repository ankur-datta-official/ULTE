# Deterministic real-time exit-fill lifecycle V1

## Architectural position and Task 024 gate

`@ulte/realtime-execution-exit-fill-engine` is the side-effect-free Task 025B projection boundary
after Task 025A's authoritative exit domain and Task 024's protection acknowledgement lifecycle. It
consumes the actual `RealtimeExecutionProtectionLifecycleResult`. Only
`PROTECTION_ACKNOWLEDGEMENT_APPLIED` is actionable; `NO_PROTECTION_LIFECYCLE` and
`PROTECTION_LIFECYCLE_REJECTED` return `NO_EXIT_FILL_PROCESSING` without requiring an attempt, exit
fill, or observation boundary. A protected-looking attempt cannot bypass that outer status.

Protection acknowledgement is coverage evidence, never exit evidence. An actionable call requires
an explicit provider-neutral `ExitFillEvent`. Entry `FillEvent` and exit `ExitFillEvent` remain
structurally distinct. Task 025B invokes `createExitFillEvent` to validate and normalize the supplied
event and fails closed on missing, malformed, or entry-shaped input.

## Explicit leg and observation boundary

The normalized event's `PROTECTIVE_STOP` or `PROFIT_TARGET` leg is authoritative. Task 025B never
compares `fillPrice` with `stopTriggerPrice`, `targetPrice`, a candle, quote, bid, ask, mark, or market
snapshot. A stop at a target-like price remains a stop, and a target at a stop-like price remains a
target. The fill price is retained solely as execution evidence.

Actionable calls require caller-supplied `observationAsOf`, normalized through `unixMs`. An exit with
`filledAt > observationAsOf` is rejected as `EXIT_FILL_OBSERVED_IN_FUTURE`; equality is accepted. No
clock is read. After this no-lookahead check, `applyExitFill` remains authoritative for event
chronology, and input events are never sorted.

## Current-attempt continuation and domain delegation

The Task 024 execution attempt is the lineage baseline. A supplied current attempt is accepted only
when its complete structure equals that baseline plus an ordered suffix of exit fills that can be
replayed successfully through `applyExitFill`. This preserves immutable plan, intent, candidate,
instrument, side, quantity, price, risk, idempotency, protection-mode, capability, entry-fill, and
acknowledged-protection identity. It also prevents removed history, regressed quantities, changed
provenance, or otherwise fabricated aggregate fields while allowing state produced by prior Task
025B calls.

Task 025B calls `applyExitFill` for the new event. It performs no cumulative quantity arithmetic,
coverage lookup, over-exit logic, duplicate comparison, chronology calculation, or state derivation.
Consequently sequential exits such as 2.5, 3.25, and 4.25 accumulate exactly to 10, preserving
`EXIT_PARTIALLY_FILLED` for the first two and `EXIT_FILLED` for the last when entry exposure can no
longer grow.

An exit equal to all currently filled exposure remains `EXIT_PARTIALLY_FILLED` while the entry order
is `WORKING`. `EXIT_FILLED` is preserved exactly when the domain returns it; Task 025B introduces no
position-closed, win/loss, stopped-out, or target-hit state.

## Duplicates, provenance, coverage, and leg races

`EXECUTION_ATTEMPT_UPDATED` maps to `EXIT_FILL_APPLIED`, `DUPLICATE_EVENT_IGNORED` maps to
`DUPLICATE_EXIT_FILL`, and domain rejection maps to `EXIT_FILL_REJECTED` with its original reason.
An exact replay does not change exited quantity. Reusing a fill ID with changed quantity, price,
time, side, request, or leg remains `DUPLICATE_EXIT_FILL_CONFLICT`.

Every exit retains its acknowledged protection-request provenance. Unknown requests, request
coverage ceilings, total protected/filled ceilings, over-exit, and backward chronology are delegated
unchanged to Task 025A. Stop and target events are applied only in authoritative arrival order. A
full fill by either leg causes a later positive fill on the other leg to meet the existing over-exit
guard; Task 025B does not cancel, modify, or infer the opposite leg. `MANAGED_PROTECTION` and
`NATIVE_BRACKET` use the same transition without provider-specific branches.

## Determinism, immutability, and boundary

Results are frozen, and accepted attempts remain the execution engine's frozen aggregates. The Task
024 result, supplied current attempt, raw input, and normalized event are never mutated. Rejection is
atomic. Identical inputs produce identical outputs across repeated calls and fresh projector
instances; there is no process-local deduplication state.

Task 025B performs no adapter or registry call, entry/protection/exit submission, cancellation,
modification, reconciliation, repository or database access, provider parsing, network activity,
timer, or persistence. It calculates no realized or unrealized PnL, reward, R multiple, fee,
commission, slippage, account balance, or portfolio value and introduces no `Position` aggregate.

Integration coverage drives isolated historical-replay and live-ingestion branches through shared
candles, analysis, decision, preparation, durable entry submission, normalized entry fill, durable
protection submission, Task 024 projection, and equivalent explicit exit evidence. Both branches
produce the same final authoritative attempt and `EXIT_FILLED` state, while Task 025B adds zero
adapter or durable-repository calls. Durable exit ingestion, provider normalization, protection
modification/cancellation, position accounting, PnL, and live exit submission remain deferred.
