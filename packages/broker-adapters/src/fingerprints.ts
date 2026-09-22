import type {
  EntryCancellationRequest,
  EntrySubmissionRequest,
  ProtectionRequest,
} from "@ulte/execution-engine";

declare const requestFingerprintBrand: unique symbol;
export type RequestFingerprint = string & { readonly [requestFingerprintBrand]: "RequestFingerprint" };

function encodeField(value: string): string {
  return `${value.length}:${value}`;
}

function fingerprint(fields: readonly string[]): RequestFingerprint {
  return fields.map(encodeField).join("") as RequestFingerprint;
}

export function fingerprintEntrySubmission(request: EntrySubmissionRequest): RequestFingerprint {
  return fingerprint([
    "ENTRY_REQUEST_V1",
    request.kind,
    request.executionAttemptId,
    request.idempotencyKey,
    request.instrumentId,
    request.side,
    request.quantity,
    request.limitPrice,
  ]);
}

export function fingerprintProtectionRequest(request: ProtectionRequest): RequestFingerprint {
  return fingerprint([
    "PROTECTION_REQUEST_V1",
    request.kind,
    request.executionAttemptId,
    request.protectionRequestId,
    request.idempotencyKey,
    request.instrumentId,
    request.mode,
    request.exitSide,
    request.protectedQuantity,
    request.targetCumulativeProtectedQuantity,
    request.stopTriggerPrice,
    request.targetPrice,
  ]);
}

export function fingerprintEntryCancellation(request: EntryCancellationRequest): RequestFingerprint {
  return fingerprint([
    "ENTRY_CANCELLATION_REQUEST_V1",
    request.kind,
    request.executionAttemptId,
    request.cancellationRequestId,
    request.idempotencyKey,
    request.adapterOrderId,
  ]);
}
