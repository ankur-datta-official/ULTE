import {
  createBrokerAuditEvent,
  createIdempotencyRecord,
  type BrokerAuditEvent,
  type IdempotencyRecord,
} from "@ulte/broker-adapters";
import { PersistenceCorruptionError } from "./errors.js";

export interface IdempotencyRow {
  readonly adapter_id: unknown;
  readonly environment: unknown;
  readonly idempotency_key: unknown;
  readonly execution_attempt_id: unknown;
  readonly operation: unknown;
  readonly request_fingerprint: unknown;
  readonly status: unknown;
  readonly created_at_ms: unknown;
  readonly updated_at_ms: unknown;
  readonly adapter_order_id: unknown;
}

export interface AuditRow {
  readonly event_id: unknown;
  readonly occurred_at_ms: unknown;
  readonly adapter_id: unknown;
  readonly environment: unknown;
  readonly execution_attempt_id: unknown;
  readonly operation: unknown;
  readonly idempotency_key: unknown;
  readonly outcome: unknown;
  readonly adapter_order_id: unknown;
  readonly normalized_failure_category: unknown;
}

function text(value: unknown, field: string): string {
  if (typeof value !== "string") throw new TypeError(`${field} must be text`);
  return value;
}

function optionalText(value: unknown, field: string): string | undefined {
  if (value === null || value === undefined) return undefined;
  return text(value, field);
}

function unixMsValue(value: unknown, field: string): number {
  if (typeof value === "number") return value;
  if (typeof value !== "string" || !/^(0|[1-9]\d*)$/.test(value)) {
    throw new TypeError(`${field} must be a non-negative PostgreSQL BIGINT`);
  }
  const parsed = BigInt(value);
  if (parsed > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError(`${field} exceeds the safe Unix millisecond range`);
  }
  return parseInt(value, 10);
}

export function mapIdempotencyRow(row: IdempotencyRow): IdempotencyRecord {
  try {
    return createIdempotencyRecord({
      adapterId: text(row.adapter_id, "adapter_id"),
      environment: text(row.environment, "environment") as IdempotencyRecord["environment"],
      idempotencyKey: text(row.idempotency_key, "idempotency_key"),
      executionAttemptId: text(row.execution_attempt_id, "execution_attempt_id"),
      operation: text(row.operation, "operation") as IdempotencyRecord["operation"],
      requestFingerprint: text(
        row.request_fingerprint,
        "request_fingerprint",
      ) as IdempotencyRecord["requestFingerprint"],
      status: text(row.status, "status") as IdempotencyRecord["status"],
      createdAt: unixMsValue(row.created_at_ms, "created_at_ms"),
      updatedAt: unixMsValue(row.updated_at_ms, "updated_at_ms"),
      ...(optionalText(row.adapter_order_id, "adapter_order_id") === undefined
        ? {}
        : { adapterOrderId: optionalText(row.adapter_order_id, "adapter_order_id")! }),
    });
  } catch (cause) {
    throw new PersistenceCorruptionError("Invalid broker idempotency row", { cause });
  }
}

export function mapAuditRow(row: AuditRow): BrokerAuditEvent {
  try {
    return createBrokerAuditEvent({
      eventId: text(row.event_id, "event_id"),
      occurredAt: unixMsValue(row.occurred_at_ms, "occurred_at_ms"),
      adapterId: text(row.adapter_id, "adapter_id"),
      environment: text(row.environment, "environment") as BrokerAuditEvent["environment"],
      executionAttemptId: text(row.execution_attempt_id, "execution_attempt_id"),
      operation: text(row.operation, "operation") as BrokerAuditEvent["operation"],
      idempotencyKey: text(row.idempotency_key, "idempotency_key"),
      outcome: text(row.outcome, "outcome") as BrokerAuditEvent["outcome"],
      ...(optionalText(row.adapter_order_id, "adapter_order_id") === undefined
        ? {}
        : { adapterOrderId: optionalText(row.adapter_order_id, "adapter_order_id")! }),
      ...(optionalText(row.normalized_failure_category, "normalized_failure_category") === undefined
        ? {}
        : {
            normalizedFailureCategory: optionalText(
              row.normalized_failure_category,
              "normalized_failure_category",
            ) as NonNullable<BrokerAuditEvent["normalizedFailureCategory"]>,
          }),
    });
  } catch (cause) {
    throw new PersistenceCorruptionError("Invalid broker audit row", { cause });
  }
}
