import { unixMs } from "@ulte/instrument-model";
import {
  IDEMPOTENCY_OPERATIONS,
  brokerAdapterId,
  isExecutionEnvironment,
  type IdempotencyRecord,
} from "@ulte/broker-adapters";
import {
  auditDelivery,
  emitAudit,
  encodeFields,
  identifier,
  snapshotObservation,
  snapshotRecord,
  type AuditContext,
} from "./internal.js";
import type {
  ConfirmedResult,
  DoNotRetryResult,
  IdempotencyConflictResult,
  ReconciliationInput,
  ReconciliationRequest,
  ReconciliationRequestInput,
  ReconciliationRequiredResult,
  ReconciliationResult,
  RejectedResult,
  RetryAuthorizedResult,
} from "./types.js";

function requestId(input: ReconciliationRequestInput): string {
  return encodeFields([
    "RECONCILIATION_REQUEST_V1",
    input.adapterId,
    input.environment,
    input.executionAttemptId,
    input.operation,
    input.idempotencyKey,
    input.requestFingerprint,
    input.adapterOrderId === undefined ? "NO_ADAPTER_ORDER_ID" : "ADAPTER_ORDER_ID_PRESENT",
    input.adapterOrderId ?? "",
  ]);
}

export function createReconciliationRequest(
  input: ReconciliationRequestInput,
): ReconciliationRequest {
  if (!isExecutionEnvironment(input.environment)) throw new TypeError("Invalid execution environment");
  if (!(IDEMPOTENCY_OPERATIONS as readonly string[]).includes(input.operation)) {
    throw new TypeError("Invalid reconciliation operation");
  }
  const normalized: ReconciliationRequestInput = {
    adapterId: brokerAdapterId(input.adapterId),
    environment: input.environment,
    executionAttemptId: identifier(input.executionAttemptId, "executionAttemptId"),
    operation: input.operation,
    idempotencyKey: identifier(input.idempotencyKey, "idempotencyKey"),
    requestFingerprint: identifier(
      input.requestFingerprint,
      "requestFingerprint",
    ) as ReconciliationRequestInput["requestFingerprint"],
    ...(input.adapterOrderId === undefined
      ? {}
      : { adapterOrderId: identifier(input.adapterOrderId, "adapterOrderId") }),
  };
  return Object.freeze({ reconciliationRequestId: requestId(normalized), ...normalized });
}

export function createReconciliationRequestFromRequirement(
  requirement: ReconciliationRequiredResult["requirement"],
): ReconciliationRequest {
  return createReconciliationRequest({
    adapterId: requirement.adapterId,
    environment: requirement.environment,
    executionAttemptId: requirement.executionAttemptId,
    operation: requirement.operation,
    idempotencyKey: requirement.idempotencyKey,
    requestFingerprint: requirement.requestFingerprint,
    ...(requirement.adapterOrderId === undefined
      ? {}
      : { adapterOrderId: requirement.adapterOrderId }),
  });
}

function resultBase(context: AuditContext): Pick<
  ConfirmedResult,
  "operation" | "idempotencyKey" | "requestFingerprint" | "auditDelivery"
> {
  return {
    operation: context.operation,
    idempotencyKey: context.idempotencyKey,
    requestFingerprint: context.requestFingerprint,
    auditDelivery: auditDelivery(context),
  };
}

function mismatch(record: IdempotencyRecord, request: ReconciliationRequest): boolean {
  return record.adapterId !== request.adapterId
    || record.environment !== request.environment
    || record.executionAttemptId !== request.executionAttemptId
    || record.operation !== request.operation
    || record.idempotencyKey !== request.idempotencyKey
    || record.requestFingerprint !== request.requestFingerprint;
}

function requirement(
  context: AuditContext,
  record: IdempotencyRecord,
): ReconciliationRequiredResult["requirement"] {
  return Object.freeze({
    adapterId: context.adapterId,
    environment: context.environment,
    executionAttemptId: context.executionAttemptId,
    operation: context.operation,
    idempotencyKey: context.idempotencyKey,
    requestFingerprint: context.requestFingerprint,
    reason: "RECONCILIATION_STILL_UNKNOWN",
    ...(record.adapterOrderId === undefined ? {} : { adapterOrderId: record.adapterOrderId }),
  });
}

export async function reconcileExecutionOutcome(
  input: ReconciliationInput,
): Promise<ReconciliationResult> {
  const occurredAt = unixMs(input.occurredAt);
  const adapterId = brokerAdapterId(input.request.adapterId);
  const context: AuditContext = {
    sink: input.auditSink,
    adapterId,
    environment: input.request.environment,
    executionAttemptId: input.request.executionAttemptId,
    operation: input.request.operation,
    idempotencyKey: input.request.idempotencyKey,
    requestFingerprint: input.request.requestFingerprint,
    occurredAt,
    failed: false,
  };
  const current = await input.idempotencyRepository.read(adapterId, input.request.idempotencyKey);
  if (current === undefined) throw new RangeError("Reconciliation requires an existing durable record");
  if (mismatch(current, input.request)) {
    await emitAudit(context, "IDEMPOTENCY_CONFLICT");
    const result: IdempotencyConflictResult = Object.freeze({
      status: "IDEMPOTENCY_CONFLICT",
      reason: "IDEMPOTENCY_CONFLICT",
      ...resultBase(context),
      record: snapshotRecord(current),
    });
    return result;
  }
  if (current.status === "CONFIRMED") {
    const result: ConfirmedResult = Object.freeze({
      status: "CONFIRMED",
      ...resultBase(context),
      record: snapshotRecord(current),
    });
    return result;
  }
  if (current.status === "REJECTED") {
    const result: RejectedResult = Object.freeze({
      status: "REJECTED",
      ...resultBase(context),
      record: snapshotRecord(current),
    });
    return result;
  }
  if (current.status === "FAILED_NOT_SUBMITTED") {
    const result: DoNotRetryResult = Object.freeze({
      status: "DO_NOT_RETRY",
      ...resultBase(context),
      record: snapshotRecord(current),
    });
    return result;
  }
  if (current.status === "RETRY_AUTHORIZED") {
    const result: RetryAuthorizedResult = Object.freeze({
      status: "RETRY_SAFE_SAME_KEY",
      ...resultBase(context),
      record: snapshotRecord(current),
      authorization: Object.freeze({
        adapterId: context.adapterId,
        environment: context.environment,
        executionAttemptId: context.executionAttemptId,
        operation: context.operation,
        idempotencyKey: context.idempotencyKey,
        requestFingerprint: context.requestFingerprint,
        source: "RECONCILIATION_CONFIRMED_NOT_SUBMITTED",
      }),
    });
    return result;
  }

  const observation = snapshotObservation(await input.provider.reconcile(input.request));
  if (observation.status === "CONFIRMED_ACCEPTED") {
    const record = await input.idempotencyRepository.recordOutcome({
      adapterId,
      environment: input.request.environment,
      idempotencyKey: input.request.idempotencyKey,
      requestFingerprint: input.request.requestFingerprint,
      status: "CONFIRMED",
      updatedAt: occurredAt,
      ...(observation.adapterOrderId === undefined
        ? current.adapterOrderId === undefined ? {} : { adapterOrderId: current.adapterOrderId }
        : { adapterOrderId: observation.adapterOrderId }),
    });
    await emitAudit(context, "RECONCILED_ACCEPTED", {
      ...(record.adapterOrderId === undefined ? {} : { adapterOrderId: record.adapterOrderId }),
    });
    const result: ConfirmedResult = Object.freeze({
      status: "CONFIRMED",
      ...resultBase(context),
      record: snapshotRecord(record),
    });
    return result;
  }
  if (observation.status === "CONFIRMED_REJECTED") {
    const record = await input.idempotencyRepository.recordOutcome({
      adapterId,
      environment: input.request.environment,
      idempotencyKey: input.request.idempotencyKey,
      requestFingerprint: input.request.requestFingerprint,
      status: "REJECTED",
      updatedAt: occurredAt,
      ...(observation.adapterOrderId === undefined
        ? current.adapterOrderId === undefined ? {} : { adapterOrderId: current.adapterOrderId }
        : { adapterOrderId: observation.adapterOrderId }),
    });
    await emitAudit(context, "RECONCILED_REJECTED", {
      ...(record.adapterOrderId === undefined ? {} : { adapterOrderId: record.adapterOrderId }),
    });
    const result: RejectedResult = Object.freeze({
      status: "REJECTED",
      ...resultBase(context),
      record: snapshotRecord(record),
    });
    return result;
  }
  if (observation.status === "CONFIRMED_NOT_SUBMITTED") {
    const record = await input.idempotencyRepository.recordOutcome({
      adapterId,
      environment: input.request.environment,
      idempotencyKey: input.request.idempotencyKey,
      requestFingerprint: input.request.requestFingerprint,
      status: "RETRY_AUTHORIZED",
      updatedAt: occurredAt,
    });
    await emitAudit(context, "RETRY_AUTHORIZED");
    const result: RetryAuthorizedResult = Object.freeze({
      status: "RETRY_SAFE_SAME_KEY",
      ...resultBase(context),
      record: snapshotRecord(record),
      authorization: Object.freeze({
        adapterId: context.adapterId,
        environment: context.environment,
        executionAttemptId: context.executionAttemptId,
        operation: context.operation,
        idempotencyKey: context.idempotencyKey,
        requestFingerprint: context.requestFingerprint,
        source: "RECONCILIATION_CONFIRMED_NOT_SUBMITTED",
      }),
    });
    return result;
  }
  const record = await input.idempotencyRepository.recordOutcome({
    adapterId,
    environment: input.request.environment,
    idempotencyKey: input.request.idempotencyKey,
    requestFingerprint: input.request.requestFingerprint,
    status: "OUTCOME_UNKNOWN",
    updatedAt: occurredAt,
    ...(observation.adapterOrderId === undefined
      ? current.adapterOrderId === undefined ? {} : { adapterOrderId: current.adapterOrderId }
      : { adapterOrderId: observation.adapterOrderId }),
  });
  await emitAudit(context, "OUTCOME_UNKNOWN", {
    ...(record.adapterOrderId === undefined ? {} : { adapterOrderId: record.adapterOrderId }),
  });
  await emitAudit(context, "RECONCILIATION_REQUIRED", {
    ...(record.adapterOrderId === undefined ? {} : { adapterOrderId: record.adapterOrderId }),
  });
  const result: ReconciliationRequiredResult = Object.freeze({
    status: "RECONCILIATION_REQUIRED",
    ...resultBase(context),
    requirement: requirement(context, record),
    record: snapshotRecord(record),
  });
  return result;
}
