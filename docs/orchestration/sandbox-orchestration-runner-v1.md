# Serialized sandbox orchestration runner V1

## Purpose and relationship to Task033A

`@ulte/sandbox-orchestration-runner` is the thin imperative half of the Phase32 Option-D boundary.
Task033A remains the pure deterministic command-selection authority. One runner instance owns the
current exact Task033A session reference for one instrument and at most one active execution-attempt
identity, plus an ephemeral single-flight flag and configured references to existing ULTE APIs.

Each accepted `dispatch(input)` calls `planLiveTradingStep(currentSession, input)` exactly once and
adopts the exact returned session reference before command execution. A no-action, needs-context, or
orchestration-rejected result invokes no downstream API and is preserved by exact reference. A
planned command invokes exactly one configured public API and returns that API's exact domain result
reference. Domain rejection and duplicate statuses remain normal authoritative results.

## Explicit progression and serialization

One dispatch executes at most one command. The runner does not call the planner a second time, feed
an execution result back automatically, or drain a command graph. The caller may use
`suggestNextOrchestrationInput` where an exact mapping requires no invented context, then explicitly
dispatch that input. Context such as account state, preparation inputs, submission inputs,
protection inputs, valuation marks, and cost checkpoints remains caller-owned.

Dispatch is single-session and single-flight. A concurrent call receives a frozen `RUNNER_BUSY`
result without planner or operation invocation. There is no promise tail, dispatch queue, event
queue, or command queue. The busy flag clears after success or failure. An unexpected thrown or
rejected operation returns `COMMAND_EXECUTION_FAILED`; the runner never retries.

## Modes and side-effect ownership

Only `DRY_RUN` and `SANDBOX` are representable. Production `LIVE` mode is unsupported. As defense in
depth, entry- and protection-submission commands are rejected in DRY_RUN. In SANDBOX, those commands
are executed only when their existing command context also names `SANDBOX`; absent, mismatched, or
LIVE context invokes no coordinator.

Configured stateful engine instances may retain their legitimate domain history outside the session.
The existing realtime submission and protection coordinators continue to own broker I/O,
idempotency, repository interaction, and durable submission semantics. The runner imports no broker
adapter or PostgreSQL store and constructs neither.

## V1 limitations

- No production LIVE mode, multi-instrument session, or concurrent dispatch support.
- No automatic result feedback, hidden retries, generated IDs, or wall-clock reads.
- No runner-owned persistence, hydration, reconciliation, or restart recovery; Phase33 owns durable
  recovery.
- No market subscription, polling, provider transport, or market cache.
- No financial, quantity, risk, exposure, PnL, cost, or R arithmetic.
- No exit submission, cancellation, replacement, flattening, or inferred close. Only Task033A's
  authoritative exit-fill projection command is executable.

Task033A command selection remains deterministic for equivalent sessions and inputs. Task033B itself
does not claim full determinism: configured operations may perform side effects and their results may
depend on external systems.
