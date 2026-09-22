# Broker adapter infrastructure V1

## Purpose and boundary

`@ulte/broker-adapters` is the infrastructure boundary between the broker-neutral contracts in `@ulte/execution-engine` and future concrete venue integrations. It adds adapter identity, configuration metadata, registration, durable-idempotency contracts, normalized failures, retry guidance, and sanitized auditing. It contains no concrete integration, network client, credential resolver, persistence implementation, retry loop, or reconciliation workflow.

The package extends the execution engine's `ExecutionAdapter` contract and reuses its capabilities, entry, protection, cancellation, acknowledgement, and rejection types. Execution lifecycle state remains owned by the execution engine.

## Adapter identity, environment, and credentials

Every immutable descriptor has a validated adapter ID, an explicitly selected `DRY_RUN`, `SANDBOX`, or `LIVE` environment, an opaque credential-profile reference, and frozen execution-engine capabilities. There is no environment default and especially no implicit `LIVE` mode. A runtime conformance handshake verifies immutable descriptor shape, explicit environment, and agreement between declared and exposed capabilities before registration. The registry preserves explicit registration order, exact adapter instances, and returns `undefined` for unknown IDs; duplicate IDs are rejected and no global registry exists.

The credential-profile reference is only a secure-infrastructure lookup reference. Raw credentials are not accepted by execution requests, idempotency records, failures, audit events, or deterministic identifiers. Secrets must never enter IDs, logs, broker payload diagnostics, or thrown error messages. Future integrations are responsible for resolving references outside these domain contracts and sanitizing messages and opaque reason codes before construction.

## Durable idempotency and request fingerprints

Execution-engine idempotency keys identify stable logical operations. A future repository implementation must durably protect those keys across retry, timeout, crash, duplicate delivery, and process restart. Its asynchronous `claim` operation must atomically create-or-read: the same adapter/key and fingerprint is `EXISTING_SAME_REQUEST`, while any different fingerprint is `CONFLICT / IDEMPOTENCY_CONFLICT` and must never overwrite the existing record or trigger submission. `read` and `recordOutcome` complete the persistence contract; this phase provides no storage.

Entry, protection, and cancellation fingerprints use versioned, fixed-order, length-prefixed encoding over every material public request field. They preserve authoritative decimal strings without numeric conversion and exclude credential references. If venue client idempotency is supported, a future integration may map the logical key to venue client identity. Otherwise it must use durable local idempotency plus reconciliation.

## Failure, retry, and reconciliation safety

Normalized failures separate broker-neutral category, outcome certainty, and submission exposure. Authentication, authorization, invalid request, insufficient funds, explicit order rejection, and idempotency conflict are never retryable. A definite transient rate-limit, network, timeout, or adapter-unavailable failure is retry-safe only when submission is known not to have occurred.

`OUTCOME_UNKNOWN`, or any failure where submission may have occurred, is `REQUIRES_RECONCILIATION`. Losing an acknowledgement after possible submission must never produce a second independent logical order: the same idempotency key must be reconciled first. Classification is advisory; this package performs no retry or reconciliation.

## Audit contract

Audit event IDs and Unix-millisecond times are caller supplied. Frozen audit events contain only adapter identity, explicit environment, execution attempt and operation identity, idempotency key, outcome, and optional order/failure metadata. Credential-profile references, raw requests, authorization material, and raw venue payloads are deliberately absent. `BrokerAuditSink` is asynchronous and storage-neutral.
