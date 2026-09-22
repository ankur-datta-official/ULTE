import { unixMs, type UnixMs } from "@ulte/instrument-model";
import { BROKER_FAILURE_CATEGORIES, type BrokerFailureCategory } from "./failures.js";
import { brokerAdapterId, isExecutionEnvironment, type BrokerAdapterId, type ExecutionEnvironment } from "./identity.js";
import { IDEMPOTENCY_OPERATIONS, type IdempotencyOperation } from "./idempotency.js";

export const BROKER_AUDIT_OUTCOMES = [
  "CLAIMED",
  "SUBMITTED",
  "CONFIRMED",
  "REJECTED",
  "OUTCOME_UNKNOWN",
  "RECONCILIATION_REQUIRED",
  "RECONCILED_ACCEPTED",
  "RECONCILED_REJECTED",
  "RETRY_AUTHORIZED",
  "DO_NOT_RETRY",
  "IDEMPOTENCY_CONFLICT",
] as const;
export type BrokerAuditOutcome = (typeof BROKER_AUDIT_OUTCOMES)[number];

export interface BrokerAuditEvent {
  readonly eventId: string;
  readonly occurredAt: UnixMs;
  readonly adapterId: BrokerAdapterId;
  readonly environment: ExecutionEnvironment;
  readonly executionAttemptId: string;
  readonly operation: IdempotencyOperation;
  readonly idempotencyKey: string;
  readonly outcome: BrokerAuditOutcome;
  readonly adapterOrderId?: string;
  readonly normalizedFailureCategory?: BrokerFailureCategory;
}

export interface BrokerAuditEventInput extends Omit<BrokerAuditEvent, "occurredAt" | "adapterId"> {
  readonly occurredAt: number;
  readonly adapterId: string;
}

export interface BrokerAuditSink {
  append(event: BrokerAuditEvent): Promise<void>;
}

function identifier(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) {
    throw new TypeError(`${field} must be non-empty and have no surrounding whitespace`);
  }
  return value;
}

export function createBrokerAuditEvent(input: BrokerAuditEventInput): BrokerAuditEvent {
  if (!isExecutionEnvironment(input.environment)) throw new TypeError("Invalid execution environment");
  if (!(IDEMPOTENCY_OPERATIONS as readonly string[]).includes(input.operation)) {
    throw new TypeError("Invalid audit operation");
  }
  if (!(BROKER_AUDIT_OUTCOMES as readonly string[]).includes(input.outcome)) {
    throw new TypeError("Invalid audit outcome");
  }
  if (
    input.normalizedFailureCategory !== undefined
    && !(BROKER_FAILURE_CATEGORIES as readonly string[]).includes(input.normalizedFailureCategory)
  ) {
    throw new TypeError("Invalid normalized failure category");
  }
  return Object.freeze({
    eventId: identifier(input.eventId, "eventId"),
    occurredAt: unixMs(input.occurredAt),
    adapterId: brokerAdapterId(input.adapterId),
    environment: input.environment,
    executionAttemptId: identifier(input.executionAttemptId, "executionAttemptId"),
    operation: input.operation,
    idempotencyKey: identifier(input.idempotencyKey, "idempotencyKey"),
    outcome: input.outcome,
    ...(input.adapterOrderId === undefined
      ? {}
      : { adapterOrderId: identifier(input.adapterOrderId, "adapterOrderId") }),
    ...(input.normalizedFailureCategory === undefined
      ? {}
      : { normalizedFailureCategory: input.normalizedFailureCategory }),
  });
}
