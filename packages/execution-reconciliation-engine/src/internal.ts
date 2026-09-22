import { unixMs } from "@ulte/instrument-model";
import {
  BROKER_FAILURE_CATEGORIES,
  OUTCOME_CERTAINTIES,
  SUBMISSION_EXPOSURES,
  createBrokerAuditEvent,
  createBrokerFailure,
  createIdempotencyRecord,
  type BrokerAuditOutcome,
  type BrokerFailure,
  type IdempotencyRecord,
  type RequestFingerprint,
} from "@ulte/broker-adapters";
import type {
  ExecutionAcknowledgement,
  ExecutionRejection,
  ReconciliationObservation,
} from "./types.js";

export function identifier(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) {
    throw new TypeError(`${field} must be non-empty and have no surrounding whitespace`);
  }
  return value;
}

export function encodeFields(fields: readonly string[]): string {
  let result = "";
  for (const field of fields) result += `${field.length}:${field}`;
  return result;
}

export function snapshotRecord(record: IdempotencyRecord): IdempotencyRecord {
  return createIdempotencyRecord({
    idempotencyKey: record.idempotencyKey,
    adapterId: record.adapterId,
    environment: record.environment,
    executionAttemptId: record.executionAttemptId,
    operation: record.operation,
    requestFingerprint: record.requestFingerprint,
    status: record.status,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    ...(record.adapterOrderId === undefined ? {} : { adapterOrderId: record.adapterOrderId }),
  });
}

export function isBrokerFailure(value: unknown): value is BrokerFailure {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<BrokerFailure>;
  return typeof candidate.category === "string"
    && (BROKER_FAILURE_CATEGORIES as readonly string[]).includes(candidate.category)
    && typeof candidate.certainty === "string"
    && (OUTCOME_CERTAINTIES as readonly string[]).includes(candidate.certainty)
    && typeof candidate.submissionExposure === "string"
    && (SUBMISSION_EXPOSURES as readonly string[]).includes(candidate.submissionExposure);
}

export function snapshotFailure(failure: BrokerFailure): BrokerFailure {
  return createBrokerFailure({
    category: failure.category,
    certainty: failure.certainty,
    submissionExposure: failure.submissionExposure,
    ...(failure.adapterReasonCode === undefined ? {} : { adapterReasonCode: failure.adapterReasonCode }),
    ...(failure.sanitizedMessage === undefined ? {} : { sanitizedMessage: failure.sanitizedMessage }),
  });
}

export function unknownFailure(): BrokerFailure {
  return createBrokerFailure({
    category: "UNKNOWN",
    certainty: "OUTCOME_UNKNOWN",
    submissionExposure: "MAY_HAVE_BEEN_SUBMITTED",
  });
}

export function snapshotAcknowledgement(value: ExecutionAcknowledgement): ExecutionAcknowledgement {
  return Object.freeze({ ...value });
}

export function snapshotRejection(value: ExecutionRejection): ExecutionRejection {
  return Object.freeze({ ...value });
}

export function snapshotObservation(value: ReconciliationObservation): ReconciliationObservation {
  if (typeof value !== "object" || value === null || typeof value.status !== "string") {
    throw new TypeError("Invalid reconciliation observation");
  }
  if (
    value.status !== "CONFIRMED_ACCEPTED"
    && value.status !== "CONFIRMED_REJECTED"
    && value.status !== "CONFIRMED_NOT_SUBMITTED"
    && value.status !== "STILL_UNKNOWN"
  ) throw new TypeError("Invalid reconciliation observation");
  if (value.status === "CONFIRMED_NOT_SUBMITTED") return Object.freeze({ status: value.status });
  return Object.freeze({
    status: value.status,
    ...(value.adapterOrderId === undefined
      ? {}
      : { adapterOrderId: identifier(value.adapterOrderId, "adapterOrderId") }),
  });
}

export interface AuditContext {
  readonly sink: import("@ulte/broker-adapters").BrokerAuditSink | undefined;
  readonly adapterId: string;
  readonly environment: import("@ulte/broker-adapters").ExecutionEnvironment;
  readonly executionAttemptId: string;
  readonly operation: import("@ulte/broker-adapters").IdempotencyOperation;
  readonly idempotencyKey: string;
  readonly requestFingerprint: RequestFingerprint;
  readonly occurredAt: number;
  failed: boolean;
}

export async function emitAudit(
  context: AuditContext,
  outcome: BrokerAuditOutcome,
  details: { readonly adapterOrderId?: string; readonly failure?: BrokerFailure } = {},
): Promise<void> {
  if (context.sink === undefined) return;
  const eventId = encodeFields([
    "EXECUTION_RECONCILIATION_AUDIT_V1",
    context.adapterId,
    context.environment,
    context.operation,
    context.idempotencyKey,
    context.requestFingerprint,
    outcome,
    String(context.occurredAt),
  ]);
  try {
    await context.sink.append(createBrokerAuditEvent({
      eventId,
      occurredAt: unixMs(context.occurredAt),
      adapterId: context.adapterId,
      environment: context.environment,
      executionAttemptId: context.executionAttemptId,
      operation: context.operation,
      idempotencyKey: context.idempotencyKey,
      outcome,
      ...(details.adapterOrderId === undefined ? {} : { adapterOrderId: details.adapterOrderId }),
      ...(details.failure === undefined
        ? {}
        : { normalizedFailureCategory: details.failure.category }),
    }));
  } catch {
    context.failed = true;
  }
}

export function auditDelivery(context: AuditContext): "NOT_CONFIGURED" | "COMPLETE" | "FAILED" {
  if (context.sink === undefined) return "NOT_CONFIGURED";
  return context.failed ? "FAILED" : "COMPLETE";
}
