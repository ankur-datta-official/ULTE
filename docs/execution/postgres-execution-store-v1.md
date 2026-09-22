# PostgreSQL execution store V1

## Purpose and boundary

`@ulte/execution-store-postgres` implements the durable `IdempotencyRepository` and sanitized
`BrokerAuditSink` contracts from `@ulte/broker-adapters`. Durability is required before a live venue
adapter because process memory cannot protect against duplicate submission after a crash, timeout,
redelivery, or restart. This package contains no broker calls, trading calculations, retry policy,
credential resolution, or connection management.

Applications inject a narrow `PostgresExecutor` that provides parameterized queries and managed
transactions. A future `pg.Pool` adapter can implement that interface without making this package
own pools, configuration, or process environment access. Database errors propagate; there is no
automatic retry, delay, or backoff.

## Durable identity and atomic claim

The idempotency primary key is `(adapter_id, environment, idempotency_key)`. The explicit environment
keeps `DRY_RUN`, `SANDBOX`, and `LIVE` in separate durable namespaces, while adapter ID prevents
cross-adapter aliasing. Claim is insert-first inside a transaction: `INSERT ... ON CONFLICT DO
NOTHING RETURNING` creates the winner, and only a conflict triggers a locked read and full immutable
identity comparison. PostgreSQL's unique constraint serializes competing processes for a key; there
is no unsafe read-before-insert window.

Adapter ID, environment, idempotency key, execution-attempt ID, operation, request fingerprint, and
creation time are immutable. A database trigger enforces this independently of application code.
Outcome updates lock and validate the existing row, preserve all identity fields, and use a
conditional update that repeats the immutable identity predicates. A different request is rejected,
never overwritten. The legacy repository `read(adapterId, idempotencyKey)` contract cannot choose an
environment, so it returns the only matching namespace and rejects an ambiguous multi-environment
lookup; outcome updates and claims are fully environment-bound.

## Time, outcomes, and recovery

All timestamps are caller-supplied Unix milliseconds. The schema has no database-generated current
time. Both the repository and database enforce `updated_at_ms >=` its previous value. Equal
timestamps are allowed because the public contract forbids backward movement, not same-time state
changes. Every public broker-adapters status is persisted unchanged. Writing `SUBMITTED` before
adapter I/O and loading it unchanged after restart supports conservative crash recovery. A stored
adapter order ID may be set once and repeated, but cannot be replaced or removed.

## Sanitized append-only audit

Audit storage has explicit columns for exactly the public `BrokerAuditEvent` fields. Its identity is
`(adapter_id, environment, event_id)`, allowing the same deterministic event ID in separate execution
namespaces. Append uses insert-first conflict handling: an identical duplicate succeeds, while a
different payload for the same namespaced ID raises a conflict. No update or delete method is
exposed, and a database trigger rejects either operation.

All dynamic SQL values are positional parameters. Neither table contains credential references,
raw requests, raw venue payloads, connection data, or authentication material. Row mappers validate
stored values with the existing domain constructors and raise `PersistenceCorruptionError` rather
than coercing, repairing, or fabricating invalid data.

Default tests use a deterministic in-memory `PostgresExecutor` test double and require no live
database. Applying the migration and exercising concurrency against real PostgreSQL is deferred to
the deployment/integration phase.
