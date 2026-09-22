import { unixMs } from "@ulte/instrument-model";
import {
  classifyRetryDisposition,
  fingerprintEntryCancellation,
  fingerprintEntrySubmission,
  fingerprintProtectionRequest,
  type BrokerFailure,
  type IdempotencyOperation,
  type IdempotencyRecord,
  type RequestFingerprint,
} from "@ulte/broker-adapters";
import type {
  CancellationAcknowledgement,
  CancellationRejection,
  EntryAcknowledgement,
  EntryCancellationRequest,
  EntryRejection,
  EntrySubmissionRequest,
  ProtectionAcknowledgement,
  ProtectionRejection,
  ProtectionRequest,
} from "@ulte/execution-engine";
import {
  auditDelivery,
  emitAudit,
  isBrokerFailure,
  snapshotAcknowledgement,
  snapshotFailure,
  snapshotRecord,
  snapshotRejection,
  unknownFailure,
  type AuditContext,
} from "./internal.js";
import type {
  CancellationOrchestrationResult,
  ConfirmedResult,
  DoNotRetryResult,
  EntryOrchestrationResult,
  ExecutionAcknowledgement,
  ExecutionRejection,
  ExecutionRequest,
  IdempotencyConflictResult,
  OrchestrationInput,
  OrchestrationResult,
  ProtectionOrchestrationResult,
  ReconciliationReason,
  ReconciliationRequiredResult,
  RejectedResult,
  RetryAuthorizedResult,
} from "./types.js";

interface OperationDefinition<
  Request extends ExecutionRequest,
  Acknowledgement extends ExecutionAcknowledgement,
  Rejection extends ExecutionRejection,
> {
  readonly operation: IdempotencyOperation;
  fingerprint(request: Request): RequestFingerprint;
  invoke(input: OrchestrationInput<Request>): Promise<Acknowledgement | Rejection>;
  classifyResponse(
    response: Acknowledgement | Rejection,
    request: Request,
  ): { readonly type: "ACKNOWLEDGEMENT"; readonly adapterOrderId?: string }
    | { readonly type: "REJECTION"; readonly adapterOrderId?: string };
}

function base(
  context: AuditContext,
): Pick<ConfirmedResult, "operation" | "idempotencyKey" | "requestFingerprint" | "auditDelivery"> {
  return {
    operation: context.operation,
    idempotencyKey: context.idempotencyKey,
    requestFingerprint: context.requestFingerprint,
    auditDelivery: auditDelivery(context),
  };
}

function requirement(
  context: AuditContext,
  reason: ReconciliationReason,
  adapterOrderId?: string,
): ReconciliationRequiredResult["requirement"] {
  return Object.freeze({
    adapterId: context.adapterId,
    environment: context.environment,
    executionAttemptId: context.executionAttemptId,
    operation: context.operation,
    idempotencyKey: context.idempotencyKey,
    requestFingerprint: context.requestFingerprint,
    reason,
    ...(adapterOrderId === undefined ? {} : { adapterOrderId }),
  });
}

async function reconciliationRequired(
  context: AuditContext,
  record: IdempotencyRecord,
  reason: ReconciliationReason,
): Promise<ReconciliationRequiredResult> {
  await emitAudit(context, "RECONCILIATION_REQUIRED", {
    ...(record.adapterOrderId === undefined ? {} : { adapterOrderId: record.adapterOrderId }),
  });
  return Object.freeze({
    status: "RECONCILIATION_REQUIRED",
    ...base(context),
    requirement: requirement(context, reason, record.adapterOrderId),
    record: snapshotRecord(record),
  });
}

function conflict(context: AuditContext, record: IdempotencyRecord): IdempotencyConflictResult {
  return Object.freeze({
    status: "IDEMPOTENCY_CONFLICT",
    reason: "IDEMPOTENCY_CONFLICT",
    ...base(context),
    record: snapshotRecord(record),
  });
}

async function handleExisting<
  Acknowledgement extends ExecutionAcknowledgement,
  Rejection extends ExecutionRejection,
>(
  context: AuditContext,
  record: IdempotencyRecord,
): Promise<OrchestrationResult<Acknowledgement, Rejection> | undefined> {
  if (
    record.operation !== context.operation
    || record.environment !== context.environment
    || record.executionAttemptId !== context.executionAttemptId
    || record.requestFingerprint !== context.requestFingerprint
  ) {
    await emitAudit(context, "IDEMPOTENCY_CONFLICT");
    return conflict(context, record);
  }
  if (record.status === "CONFIRMED") {
    return Object.freeze({ status: "CONFIRMED", ...base(context), record: snapshotRecord(record) });
  }
  if (record.status === "REJECTED") {
    return Object.freeze({ status: "REJECTED", ...base(context), record: snapshotRecord(record) });
  }
  if (record.status === "FAILED_NOT_SUBMITTED") {
    return Object.freeze({ status: "DO_NOT_RETRY", ...base(context), record: snapshotRecord(record) });
  }
  if (record.status === "CLAIMED") {
    return reconciliationRequired(context, record, "EXISTING_CLAIMED");
  }
  if (record.status === "SUBMITTED") {
    return reconciliationRequired(context, record, "EXISTING_SUBMITTED");
  }
  if (record.status === "OUTCOME_UNKNOWN") {
    return reconciliationRequired(context, record, "EXISTING_OUTCOME_UNKNOWN");
  }
  await emitAudit(context, "RETRY_AUTHORIZED");
  return undefined;
}

function failureResult(
  context: AuditContext,
  record: IdempotencyRecord,
  failure: BrokerFailure,
): DoNotRetryResult {
  return Object.freeze({
    status: "DO_NOT_RETRY",
    ...base(context),
    record: snapshotRecord(record),
    failure: snapshotFailure(failure),
  });
}

async function handleAdapterFailure(
  input: OrchestrationInput<ExecutionRequest>,
  context: AuditContext,
  fingerprint: RequestFingerprint,
  thrown: unknown,
): Promise<ReconciliationRequiredResult | RetryAuthorizedResult | DoNotRetryResult> {
  const failure = isBrokerFailure(thrown) ? snapshotFailure(thrown) : unknownFailure();
  const disposition = classifyRetryDisposition(failure);
  if (disposition === "REQUIRES_RECONCILIATION") {
    const record = await input.idempotencyRepository.recordOutcome({
      adapterId: input.adapter.descriptor.adapterId,
      environment: input.adapter.descriptor.environment,
      idempotencyKey: input.request.idempotencyKey,
      requestFingerprint: fingerprint,
      status: "OUTCOME_UNKNOWN",
      updatedAt: unixMs(input.occurredAt),
    });
    await emitAudit(context, "OUTCOME_UNKNOWN", { failure });
    return reconciliationRequired(
      context,
      record,
      failure.certainty === "OUTCOME_UNKNOWN"
        ? "ADAPTER_OUTCOME_UNKNOWN"
        : "ADAPTER_MAY_HAVE_SUBMITTED",
    );
  }
  if (disposition === "RETRY_SAFE") {
    const record = await input.idempotencyRepository.recordOutcome({
      adapterId: input.adapter.descriptor.adapterId,
      environment: input.adapter.descriptor.environment,
      idempotencyKey: input.request.idempotencyKey,
      requestFingerprint: fingerprint,
      status: "RETRY_AUTHORIZED",
      updatedAt: unixMs(input.occurredAt),
    });
    await emitAudit(context, "RETRY_AUTHORIZED", { failure });
    return Object.freeze({
      status: "RETRY_SAFE_SAME_KEY",
      ...base(context),
      record: snapshotRecord(record),
      authorization: Object.freeze({
        adapterId: context.adapterId,
        environment: context.environment,
        executionAttemptId: context.executionAttemptId,
        operation: context.operation,
        idempotencyKey: context.idempotencyKey,
        requestFingerprint: context.requestFingerprint,
        source: "DEFINITE_NOT_SUBMITTED",
      }),
      failure,
    });
  }
  const durableStatus = failure.category === "ORDER_REJECTED" ? "REJECTED" : "FAILED_NOT_SUBMITTED";
  const record = await input.idempotencyRepository.recordOutcome({
    adapterId: input.adapter.descriptor.adapterId,
    environment: input.adapter.descriptor.environment,
    idempotencyKey: input.request.idempotencyKey,
    requestFingerprint: fingerprint,
    status: durableStatus,
    updatedAt: unixMs(input.occurredAt),
  });
  await emitAudit(context, durableStatus === "REJECTED" ? "REJECTED" : "DO_NOT_RETRY", { failure });
  return failureResult(context, record, failure);
}

async function orchestrate<
  Request extends ExecutionRequest,
  Acknowledgement extends ExecutionAcknowledgement,
  Rejection extends ExecutionRejection,
>(
  input: OrchestrationInput<Request>,
  definition: OperationDefinition<Request, Acknowledgement, Rejection>,
): Promise<OrchestrationResult<Acknowledgement, Rejection>> {
  const occurredAt = unixMs(input.occurredAt);
  const fingerprint = definition.fingerprint(input.request);
  const context: AuditContext = {
    sink: input.auditSink,
    adapterId: input.adapter.descriptor.adapterId,
    environment: input.adapter.descriptor.environment,
    executionAttemptId: input.request.executionAttemptId,
    operation: definition.operation,
    idempotencyKey: input.request.idempotencyKey,
    requestFingerprint: fingerprint,
    occurredAt,
    failed: false,
  };
  const claim = await input.idempotencyRepository.claim({
    adapterId: input.adapter.descriptor.adapterId,
    environment: input.adapter.descriptor.environment,
    idempotencyKey: input.request.idempotencyKey,
    executionAttemptId: input.request.executionAttemptId,
    operation: definition.operation,
    requestFingerprint: fingerprint,
    claimedAt: occurredAt,
  });
  if (claim.status === "CONFLICT") {
    await emitAudit(context, "IDEMPOTENCY_CONFLICT");
    return conflict(context, claim.record);
  }
  if (claim.status === "EXISTING_SAME_REQUEST") {
    const existing = await handleExisting<Acknowledgement, Rejection>(context, claim.record);
    if (existing !== undefined) return existing;
  } else {
    await emitAudit(context, "CLAIMED");
  }

  await input.idempotencyRepository.recordOutcome({
    adapterId: input.adapter.descriptor.adapterId,
    environment: input.adapter.descriptor.environment,
    idempotencyKey: input.request.idempotencyKey,
    requestFingerprint: fingerprint,
    status: "SUBMITTED",
    updatedAt: occurredAt,
  });
  await emitAudit(context, "SUBMITTED");

  let response: Acknowledgement | Rejection;
  let classification: ReturnType<OperationDefinition<Request, Acknowledgement, Rejection>["classifyResponse"]>;
  try {
    response = await definition.invoke(input);
    classification = definition.classifyResponse(response, input.request);
  } catch (thrown) {
    return handleAdapterFailure(
      input as OrchestrationInput<ExecutionRequest>,
      context,
      fingerprint,
      thrown,
    );
  }
  if (classification.type === "ACKNOWLEDGEMENT") {
    const record = await input.idempotencyRepository.recordOutcome({
      adapterId: input.adapter.descriptor.adapterId,
      environment: input.adapter.descriptor.environment,
      idempotencyKey: input.request.idempotencyKey,
      requestFingerprint: fingerprint,
      status: "CONFIRMED",
      updatedAt: occurredAt,
      ...(classification.adapterOrderId === undefined
        ? {}
        : { adapterOrderId: classification.adapterOrderId }),
    });
    await emitAudit(context, "CONFIRMED", {
      ...(classification.adapterOrderId === undefined
        ? {}
        : { adapterOrderId: classification.adapterOrderId }),
    });
    return Object.freeze({
      status: "CONFIRMED",
      ...base(context),
      record: snapshotRecord(record),
      acknowledgement: snapshotAcknowledgement(response as Acknowledgement) as Acknowledgement,
    });
  }
  const record = await input.idempotencyRepository.recordOutcome({
      adapterId: input.adapter.descriptor.adapterId,
      environment: input.adapter.descriptor.environment,
      idempotencyKey: input.request.idempotencyKey,
      requestFingerprint: fingerprint,
      status: "REJECTED",
      updatedAt: occurredAt,
      ...(classification.adapterOrderId === undefined
        ? {}
        : { adapterOrderId: classification.adapterOrderId }),
  });
  await emitAudit(context, "REJECTED", {
    ...(classification.adapterOrderId === undefined
      ? {}
      : { adapterOrderId: classification.adapterOrderId }),
  });
  return Object.freeze({
    status: "REJECTED",
    ...base(context),
    record: snapshotRecord(record),
    rejection: snapshotRejection(response as Rejection) as Rejection,
  });
}

function matchesBase(
  response: ExecutionAcknowledgement | ExecutionRejection,
  request: ExecutionRequest,
): boolean {
  return response.executionAttemptId === request.executionAttemptId
    && response.idempotencyKey === request.idempotencyKey;
}

export function orchestrateEntrySubmission(
  input: OrchestrationInput<EntrySubmissionRequest>,
): Promise<EntryOrchestrationResult> {
  return orchestrate<EntrySubmissionRequest, EntryAcknowledgement, EntryRejection>(input, {
    operation: "ENTRY_SUBMISSION",
    fingerprint: fingerprintEntrySubmission,
    invoke: ({ adapter, request }) => adapter.submitEntry(request),
    classifyResponse: (response, request) => {
      if (!matchesBase(response, request)) throw new TypeError("Adapter response identity mismatch");
      if (response.kind === "SUBMISSION_ACCEPTED") {
        return { type: "ACKNOWLEDGEMENT", adapterOrderId: response.adapterOrderId };
      }
      if (response.kind === "SUBMISSION_REJECTED") return { type: "REJECTION" };
      throw new TypeError("Invalid entry adapter response");
    },
  });
}

export function orchestrateProtectionSubmission(
  input: OrchestrationInput<ProtectionRequest>,
): Promise<ProtectionOrchestrationResult> {
  return orchestrate<ProtectionRequest, ProtectionAcknowledgement, ProtectionRejection>(input, {
    operation: "PROTECTION_SUBMISSION",
    fingerprint: fingerprintProtectionRequest,
    invoke: ({ adapter, request }) => adapter.submitProtection(request),
    classifyResponse: (response, request) => {
      if (!matchesBase(response, request) || response.protectionRequestId !== request.protectionRequestId) {
        throw new TypeError("Adapter response identity mismatch");
      }
      if (response.kind === "PROTECTION_ACCEPTED") return { type: "ACKNOWLEDGEMENT" };
      if (response.kind === "PROTECTION_REJECTED") return { type: "REJECTION" };
      throw new TypeError("Invalid protection adapter response");
    },
  });
}

export function orchestrateEntryCancellation(
  input: OrchestrationInput<EntryCancellationRequest>,
): Promise<CancellationOrchestrationResult> {
  return orchestrate<EntryCancellationRequest, CancellationAcknowledgement, CancellationRejection>(input, {
    operation: "ENTRY_CANCELLATION",
    fingerprint: fingerprintEntryCancellation,
    invoke: ({ adapter, request }) => adapter.cancelEntry(request),
    classifyResponse: (response, request) => {
      if (
        !matchesBase(response, request)
        || response.cancellationRequestId !== request.cancellationRequestId
        || response.adapterOrderId !== request.adapterOrderId
      ) throw new TypeError("Adapter response identity mismatch");
      if (response.kind === "CANCEL_ACCEPTED") {
        return { type: "ACKNOWLEDGEMENT", adapterOrderId: response.adapterOrderId };
      }
      if (response.kind === "CANCEL_REJECTED") {
        return { type: "REJECTION", adapterOrderId: response.adapterOrderId };
      }
      throw new TypeError("Invalid cancellation adapter response");
    },
  });
}
