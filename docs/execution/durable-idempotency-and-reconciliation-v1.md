# Durable idempotency and reconciliation V1

## Boundary

`@ulte/execution-reconciliation-engine` coordinates safe delivery of execution-engine entry,
protection, and cancellation requests through broker-adapters contracts. It performs no financial
calculation and contains no broker, network, credential, or persistence implementation.

## Claim and crash-window safety

Every operation derives the broker-adapters canonical request fingerprint and atomically claims its
adapter/environment/key identity before any adapter action. Environment is bound in durable
idempotency state rather than broker request fingerprints. A conflicting environment or fingerprint is a hard-stop
`IDEMPOTENCY_CONFLICT`; durable state is never overwritten and the adapter is not called.

For a new claim, or an explicitly authorized retry, orchestration writes `SUBMITTED` before invoking
the adapter. Here `SUBMITTED` conservatively means submission may have started. A crash during or
after broker I/O therefore restarts from an ambiguous state that requires reconciliation rather than
from an apparently unattempted request. False-positive reconciliation is preferable to duplicate
live orders.

`CONFIRMED` and `REJECTED` replay from durable state without I/O. Existing `CLAIMED`, `SUBMITTED`,
and `OUTCOME_UNKNOWN` records never submit blindly and return `RECONCILIATION_REQUIRED`.

## Failure and retry policy

A typed acknowledgement is persisted as `CONFIRMED` before success is returned; a typed rejection
is persisted as `REJECTED`. An unknown outcome or any failure that may have been submitted is
persisted as `OUTCOME_UNKNOWN` and requires reconciliation. There is no internal retry loop.

Retry can be authorized only by a definite, definitely-not-submitted failure classified
`RETRY_SAFE`, or by reconciliation observation `CONFIRMED_NOT_SUBMITTED`. Authorization is persisted
as `RETRY_AUTHORIZED`. A later explicit orchestration call must reuse the exact idempotency key and
request fingerprint; the normal atomic claim detects mutation. Permanent definite non-submission is
`FAILED_NOT_SUBMITTED`, not a fabricated broker rejection.

## Reconciliation

`ReconciliationProvider` is an async broker-neutral contract. Its observations are
`CONFIRMED_ACCEPTED`, `CONFIRMED_REJECTED`, `CONFIRMED_NOT_SUBMITTED`, and `STILL_UNKNOWN`.
Accepted/rejected observations persist their terminal state without submission. Still-unknown
observations remain blocked. Only the explicit non-submission observation authorizes a later
same-key retry; reconciliation itself never submits or creates a new logical key.

Reconciliation request IDs use versioned, fixed-order, length-prefixed non-secret fields. They use
no UUID, randomness, or clock and are stable for identical requests even when identifiers contain
delimiter-like characters.

## Time, immutability, and audit

All operation times are caller-supplied Unix milliseconds. Repository implementations must reject
backward `updatedAt` movement; such failures propagate before any unsafe next step. Public results,
requirements, authorizations, observations copied by the engine, and durable record snapshots are
frozen. Input requests and repository-returned objects are never mutated.

An optional `BrokerAuditSink` receives sanitized deterministic events without raw requests,
credentials, or broker payloads. Audit delivery failures do not change execution/idempotency flow;
the returned `auditDelivery` field reports `FAILED` so loss is not silent.
