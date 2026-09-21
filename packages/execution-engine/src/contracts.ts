import {
  positiveDecimalString,
  unixMs,
} from "@ulte/instrument-model";
import type {
  AdapterCapabilities,
  AdapterCapabilitiesInput,
  CancellationAcknowledgement,
  CancellationAcknowledgementInput,
  CancellationRejection,
  CancellationRejectionInput,
  EntryAcknowledgement,
  EntryAcknowledgementInput,
  EntryRejection,
  EntryRejectionInput,
  FillEvent,
  FillEventInput,
  ProtectionAcknowledgement,
  ProtectionAcknowledgementInput,
  ProtectionRejection,
  ProtectionRejectionInput,
} from "./types.js";

function identifier(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) {
    throw new TypeError(`${field} must be non-empty and have no surrounding whitespace`);
  }
  return value;
}

function opaqueReason(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) throw new TypeError(`${field} must be non-empty`);
  return value;
}

export function createAdapterCapabilities(input: AdapterCapabilitiesInput): AdapterCapabilities {
  const values = Object.values(input);
  if (values.length !== 6 || values.some((value) => typeof value !== "boolean")) {
    throw new TypeError("All adapter capability fields must be explicit booleans");
  }
  return Object.freeze({
    supportsClientIdempotency: input.supportsClientIdempotency,
    supportsCloseOnlyExit: input.supportsCloseOnlyExit,
    supportsNativeBracketProtection: input.supportsNativeBracketProtection,
    supportsProtectionModification: input.supportsProtectionModification,
    supportsOrderCancellation: input.supportsOrderCancellation,
    supportsPartialFillReporting: input.supportsPartialFillReporting,
  });
}

export function createEntryAcknowledgement(input: EntryAcknowledgementInput): EntryAcknowledgement {
  return Object.freeze({
    kind: "SUBMISSION_ACCEPTED",
    executionAttemptId: identifier(input.executionAttemptId, "executionAttemptId"),
    idempotencyKey: identifier(input.idempotencyKey, "idempotencyKey"),
    adapterOrderId: identifier(input.adapterOrderId, "adapterOrderId"),
    acknowledgedAt: unixMs(input.acknowledgedAt),
  });
}

export function createEntryRejection(input: EntryRejectionInput): EntryRejection {
  return Object.freeze({
    kind: "SUBMISSION_REJECTED",
    executionAttemptId: identifier(input.executionAttemptId, "executionAttemptId"),
    idempotencyKey: identifier(input.idempotencyKey, "idempotencyKey"),
    adapterReasonCode: opaqueReason(input.adapterReasonCode, "adapterReasonCode"),
    rejectedAt: unixMs(input.rejectedAt),
  });
}

export function createFillEvent(input: FillEventInput): FillEvent {
  return Object.freeze({
    kind: "FILL",
    executionAttemptId: identifier(input.executionAttemptId, "executionAttemptId"),
    adapterOrderId: identifier(input.adapterOrderId, "adapterOrderId"),
    fillId: identifier(input.fillId, "fillId"),
    filledQuantity: positiveDecimalString(input.filledQuantity),
    fillPrice: positiveDecimalString(input.fillPrice),
    filledAt: unixMs(input.filledAt),
  });
}

export function createProtectionAcknowledgement(
  input: ProtectionAcknowledgementInput,
): ProtectionAcknowledgement {
  return Object.freeze({
    kind: "PROTECTION_ACCEPTED",
    executionAttemptId: identifier(input.executionAttemptId, "executionAttemptId"),
    protectionRequestId: identifier(input.protectionRequestId, "protectionRequestId"),
    idempotencyKey: identifier(input.idempotencyKey, "idempotencyKey"),
    protectedQuantity: positiveDecimalString(input.protectedQuantity),
    acknowledgedAt: unixMs(input.acknowledgedAt),
  });
}

export function createProtectionRejection(input: ProtectionRejectionInput): ProtectionRejection {
  return Object.freeze({
    kind: "PROTECTION_REJECTED",
    executionAttemptId: identifier(input.executionAttemptId, "executionAttemptId"),
    protectionRequestId: identifier(input.protectionRequestId, "protectionRequestId"),
    idempotencyKey: identifier(input.idempotencyKey, "idempotencyKey"),
    adapterReasonCode: opaqueReason(input.adapterReasonCode, "adapterReasonCode"),
    rejectedAt: unixMs(input.rejectedAt),
  });
}

export function createCancellationAcknowledgement(
  input: CancellationAcknowledgementInput,
): CancellationAcknowledgement {
  return Object.freeze({
    kind: "CANCEL_ACCEPTED",
    executionAttemptId: identifier(input.executionAttemptId, "executionAttemptId"),
    cancellationRequestId: identifier(input.cancellationRequestId, "cancellationRequestId"),
    idempotencyKey: identifier(input.idempotencyKey, "idempotencyKey"),
    adapterOrderId: identifier(input.adapterOrderId, "adapterOrderId"),
    acknowledgedAt: unixMs(input.acknowledgedAt),
  });
}

export function createCancellationRejection(input: CancellationRejectionInput): CancellationRejection {
  return Object.freeze({
    kind: "CANCEL_REJECTED",
    executionAttemptId: identifier(input.executionAttemptId, "executionAttemptId"),
    cancellationRequestId: identifier(input.cancellationRequestId, "cancellationRequestId"),
    idempotencyKey: identifier(input.idempotencyKey, "idempotencyKey"),
    adapterOrderId: identifier(input.adapterOrderId, "adapterOrderId"),
    adapterReasonCode: opaqueReason(input.adapterReasonCode, "adapterReasonCode"),
    rejectedAt: unixMs(input.rejectedAt),
  });
}
