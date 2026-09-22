import {
  createBrokerAuditEvent,
  type BrokerAuditEvent,
  type BrokerAuditSink,
} from "@ulte/broker-adapters";
import { PersistenceConflictError, PersistenceCorruptionError } from "./errors.js";
import { mapAuditRow, type AuditRow } from "./mapping.js";
import type { PostgresExecutor } from "./postgres.js";

const AUDIT_COLUMNS = `
  event_id, occurred_at_ms, adapter_id, environment, execution_attempt_id,
  operation, idempotency_key, outcome, adapter_order_id, normalized_failure_category`;

const AUDIT_INSERT_SQL = `/* execution-store-postgres:audit-insert */
INSERT INTO broker_audit_events (
  event_id, occurred_at_ms, adapter_id, environment, execution_attempt_id,
  operation, idempotency_key, outcome, adapter_order_id, normalized_failure_category
) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
ON CONFLICT (adapter_id, environment, event_id) DO NOTHING
RETURNING ${AUDIT_COLUMNS}`;

const AUDIT_SELECT_SQL = `/* execution-store-postgres:audit-select-existing */
SELECT ${AUDIT_COLUMNS}
FROM broker_audit_events
WHERE adapter_id = $1 AND environment = $2 AND event_id = $3
FOR UPDATE`;

function snapshot(event: BrokerAuditEvent): BrokerAuditEvent {
  return createBrokerAuditEvent({
    eventId: event.eventId,
    occurredAt: event.occurredAt,
    adapterId: event.adapterId,
    environment: event.environment,
    executionAttemptId: event.executionAttemptId,
    operation: event.operation,
    idempotencyKey: event.idempotencyKey,
    outcome: event.outcome,
    ...(event.adapterOrderId === undefined ? {} : { adapterOrderId: event.adapterOrderId }),
    ...(event.normalizedFailureCategory === undefined
      ? {}
      : { normalizedFailureCategory: event.normalizedFailureCategory }),
  });
}

function equal(first: BrokerAuditEvent, second: BrokerAuditEvent): boolean {
  return first.eventId === second.eventId
    && first.occurredAt === second.occurredAt
    && first.adapterId === second.adapterId
    && first.environment === second.environment
    && first.executionAttemptId === second.executionAttemptId
    && first.operation === second.operation
    && first.idempotencyKey === second.idempotencyKey
    && first.outcome === second.outcome
    && first.adapterOrderId === second.adapterOrderId
    && first.normalizedFailureCategory === second.normalizedFailureCategory;
}

export class PostgresBrokerAuditSink implements BrokerAuditSink {
  public constructor(private readonly executor: PostgresExecutor) {}

  public append(event: BrokerAuditEvent): Promise<void> {
    const durableEvent = snapshot(event);
    return this.executor.transaction(async (transaction) => {
      const inserted = await transaction.query<AuditRow>(AUDIT_INSERT_SQL, [
        durableEvent.eventId,
        durableEvent.occurredAt,
        durableEvent.adapterId,
        durableEvent.environment,
        durableEvent.executionAttemptId,
        durableEvent.operation,
        durableEvent.idempotencyKey,
        durableEvent.outcome,
        durableEvent.adapterOrderId ?? null,
        durableEvent.normalizedFailureCategory ?? null,
      ]);
      if (inserted.rows.length === 1) {
        mapAuditRow(inserted.rows[0]!);
        return;
      }
      if (inserted.rows.length !== 0) {
        throw new PersistenceCorruptionError("Audit insert returned an unexpected row count");
      }
      const selected = await transaction.query<AuditRow>(AUDIT_SELECT_SQL, [
        durableEvent.adapterId,
        durableEvent.environment,
        durableEvent.eventId,
      ]);
      if (selected.rows.length !== 1) {
        throw new PersistenceCorruptionError("Conflicting audit lookup expected exactly one row");
      }
      if (!equal(mapAuditRow(selected.rows[0]!), durableEvent)) {
        throw new PersistenceConflictError(
          "AUDIT_EVENT_CONFLICT",
          "Audit event identity already exists with a different payload",
        );
      }
    });
  }
}

export function createPostgresBrokerAuditSink(executor: PostgresExecutor): PostgresBrokerAuditSink {
  return new PostgresBrokerAuditSink(executor);
}
