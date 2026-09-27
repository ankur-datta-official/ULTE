import { fingerprintProtectionRequest } from "@ulte/broker-adapters";
import {
  acknowledgeProtection,
  type AdapterCapabilities,
  type ExecutionAttempt,
  type ProtectionAcknowledgement,
  type ProtectionRequest,
  type TransitionRejectedResult,
} from "@ulte/execution-engine";
import { unixMs, type UnixMs } from "@ulte/instrument-model";
import type {
  ProtectionConfirmedResult,
  RealtimeExecutionProtectionResult,
} from "@ulte/realtime-execution-protection-engine";
import type {
  NoProtectionLifecycleResult,
  ProtectionLifecycleRejectedResult,
  ProtectionLifecycleRejectionReason,
  RealtimeExecutionProtectionLifecycleInput,
  RealtimeExecutionProtectionLifecycleResult,
} from "./types.js";

function noLifecycle(
  result: Exclude<RealtimeExecutionProtectionResult, ProtectionConfirmedResult>,
): NoProtectionLifecycleResult {
  return Object.freeze({
    status: "NO_PROTECTION_LIFECYCLE",
    preparationCycleId: result.preparationCycleId,
    upstreamStatus: result.status,
  });
}

function rejected(
  preparationCycleId: RealtimeExecutionProtectionResult["preparationCycleId"],
  reason: ProtectionLifecycleRejectionReason,
  executionAttempt?: ExecutionAttempt,
  observationAsOf?: UnixMs,
): ProtectionLifecycleRejectedResult {
  return Object.freeze({
    status: "PROTECTION_LIFECYCLE_REJECTED",
    reason,
    preparationCycleId,
    ...(executionAttempt === undefined ? {} : { executionAttempt }),
    ...(observationAsOf === undefined ? {} : { observationAsOf }),
  });
}

function transitionRejected(
  preparationCycleId: RealtimeExecutionProtectionResult["preparationCycleId"],
  transitionResult: TransitionRejectedResult,
  observationAsOf: UnixMs,
): ProtectionLifecycleRejectedResult {
  return Object.freeze({
    status: "PROTECTION_LIFECYCLE_REJECTED",
    reason: transitionResult.reason,
    preparationCycleId,
    executionAttempt: transitionResult.attempt,
    observationAsOf,
    transitionResult,
  });
}

function sameCapabilities(
  left: AdapterCapabilities | undefined,
  right: AdapterCapabilities | undefined,
): boolean {
  if (left === undefined || right === undefined) return left === right;
  return left.supportsClientIdempotency === right.supportsClientIdempotency
    && left.supportsCloseOnlyExit === right.supportsCloseOnlyExit
    && left.supportsNativeBracketProtection === right.supportsNativeBracketProtection
    && left.supportsProtectionModification === right.supportsProtectionModification
    && left.supportsOrderCancellation === right.supportsOrderCancellation
    && left.supportsPartialFillReporting === right.supportsPartialFillReporting;
}

function sameProtectionRequest(
  left: ProtectionRequest | undefined,
  right: ProtectionRequest | undefined,
): boolean {
  if (left === undefined || right === undefined) return left === right;
  return left.kind === right.kind
    && left.executionAttemptId === right.executionAttemptId
    && left.protectionRequestId === right.protectionRequestId
    && left.idempotencyKey === right.idempotencyKey
    && left.instrumentId === right.instrumentId
    && left.mode === right.mode
    && left.exitSide === right.exitSide
    && left.protectedQuantity === right.protectedQuantity
    && left.targetCumulativeProtectedQuantity === right.targetCumulativeProtectedQuantity
    && left.stopTriggerPrice === right.stopTriggerPrice
    && left.targetPrice === right.targetPrice;
}

function sameFillHistory(left: ExecutionAttempt, right: ExecutionAttempt): boolean {
  if (left.processedFills.length !== right.processedFills.length) return false;
  return left.processedFills.every((fill, index) => {
    const other = right.processedFills[index];
    return other !== undefined
      && fill.kind === other.kind
      && fill.executionAttemptId === other.executionAttemptId
      && fill.adapterOrderId === other.adapterOrderId
      && fill.fillId === other.fillId
      && fill.filledQuantity === other.filledQuantity
      && fill.fillPrice === other.fillPrice
      && fill.filledAt === other.filledAt;
  });
}

function sameCurrentAttempt(source: ExecutionAttempt, current: ExecutionAttempt): boolean {
  return current.status === source.status
    && current.schemaVersion === source.schemaVersion
    && current.executionAttemptId === source.executionAttemptId
    && current.executionPlanId === source.executionPlanId
    && current.tradeIntentId === source.tradeIntentId
    && current.candidateId === source.candidateId
    && current.instrumentId === source.instrumentId
    && current.preparedAsOf === source.preparedAsOf
    && current.entrySide === source.entrySide
    && current.exitSide === source.exitSide
    && current.quantity === source.quantity
    && current.quantityUnit === source.quantityUnit
    && current.entryPrice === source.entryPrice
    && current.stopTriggerPrice === source.stopTriggerPrice
    && current.targetPrice === source.targetPrice
    && current.approvedRiskAmount === source.approvedRiskAmount
    && current.actualRiskAmount === source.actualRiskAmount
    && current.netRewardRiskBps === source.netRewardRiskBps
    && current.state === source.state
    && current.entryOrderStatus === source.entryOrderStatus
    && current.submissionIdempotencyKey === source.submissionIdempotencyKey
    && current.protectionMode === source.protectionMode
    && sameCapabilities(current.adapterCapabilities, source.adapterCapabilities)
    && current.adapterOrderId === source.adapterOrderId
    && current.filledEntryQuantity === source.filledEntryQuantity
    && current.protectedQuantity === source.protectedQuantity
    && current.unprotectedFilledQuantity === source.unprotectedFilledQuantity
    && current.lastFillPrice === source.lastFillPrice
    && sameFillHistory(current, source)
    && sameProtectionRequest(current.pendingProtectionRequest, source.pendingProtectionRequest)
    && current.pendingCancellationRequest === source.pendingCancellationRequest
    && current.lastExecutionEventAt === source.lastExecutionEventAt
    && current.entryRejectionReason === source.entryRejectionReason
    && current.protectionFailureReason === source.protectionFailureReason
    && current.cancellationRejectionReason === source.cancellationRejectionReason;
}

function actualAcknowledgement(
  result: ProtectionConfirmedResult,
): ProtectionAcknowledgement | undefined {
  const acknowledgement = result.durableResult.acknowledgement;
  return acknowledgement?.kind === "PROTECTION_ACCEPTED" ? acknowledgement : undefined;
}

function coherentConfirmation(
  result: ProtectionConfirmedResult,
  acknowledgement: ProtectionAcknowledgement,
): boolean {
  const request = result.protectionRequest;
  const attempt = result.executionAttempt;
  const policy = result.executionPolicyResult;
  const durable = result.durableResult;
  const expectedFingerprint = fingerprintProtectionRequest(request);
  return policy.status === "PROTECTION_REQUEST_READY"
    && attempt.state === "PROTECTION_PENDING"
    && sameProtectionRequest(attempt.pendingProtectionRequest, request)
    && sameProtectionRequest(policy.request, request)
    && sameCurrentAttempt(policy.attempt, attempt)
    && request.executionAttemptId === attempt.executionAttemptId
    && request.instrumentId === attempt.instrumentId
    && request.mode === attempt.protectionMode
    && acknowledgement.executionAttemptId === request.executionAttemptId
    && acknowledgement.protectionRequestId === request.protectionRequestId
    && acknowledgement.idempotencyKey === request.idempotencyKey
    && durable.operation === "PROTECTION_SUBMISSION"
    && durable.idempotencyKey === request.idempotencyKey
    && durable.requestFingerprint === expectedFingerprint
    && durable.record.requestFingerprint === expectedFingerprint
    && durable.record.operation === "PROTECTION_SUBMISSION"
    && durable.record.status === "CONFIRMED"
    && durable.record.executionAttemptId === request.executionAttemptId
    && durable.record.idempotencyKey === request.idempotencyKey;
}

export function applyRealtimeExecutionProtectionAcknowledgement(
  input: RealtimeExecutionProtectionLifecycleInput,
): RealtimeExecutionProtectionLifecycleResult {
  const result = input.protectionResult;
  if (result.status !== "PROTECTION_CONFIRMED") return noLifecycle(result);

  const acknowledgement = actualAcknowledgement(result);
  if (acknowledgement === undefined) {
    return rejected(
      result.preparationCycleId,
      "CONFIRMED_PROTECTION_ACKNOWLEDGEMENT_MISSING",
      result.executionAttempt,
    );
  }
  if (!coherentConfirmation(result, acknowledgement)) {
    return rejected(
      result.preparationCycleId,
      "PROTECTION_CONFIRMATION_INCOHERENT",
      result.executionAttempt,
    );
  }
  if (acknowledgement.acknowledgedAt < result.protectionAsOf) {
    return rejected(
      result.preparationCycleId,
      "PROTECTION_ACKNOWLEDGEMENT_CHRONOLOGY_INVALID",
      result.executionAttempt,
    );
  }

  let observationAsOf: UnixMs;
  try {
    observationAsOf = unixMs(input.observationAsOf);
  } catch {
    return rejected(
      result.preparationCycleId,
      "INVALID_OBSERVATION_TIME",
      input.executionAttempt ?? result.executionAttempt,
    );
  }
  const current = input.executionAttempt;
  if (current === undefined || !sameCurrentAttempt(result.executionAttempt, current)) {
    return rejected(
      result.preparationCycleId,
      "CURRENT_ATTEMPT_MISMATCH",
      current ?? result.executionAttempt,
      observationAsOf,
    );
  }
  if (acknowledgement.acknowledgedAt > observationAsOf) {
    return rejected(
      result.preparationCycleId,
      "PROTECTION_ACKNOWLEDGEMENT_OBSERVED_IN_FUTURE",
      current,
      observationAsOf,
    );
  }

  const transitionResult = acknowledgeProtection(current, acknowledgement);
  if (transitionResult.status === "TRANSITION_REJECTED" || transitionResult.status === "DATA_REJECTED") {
    return transitionRejected(result.preparationCycleId, transitionResult, observationAsOf);
  }
  return Object.freeze({
    status: "PROTECTION_ACKNOWLEDGEMENT_APPLIED",
    preparationCycleId: result.preparationCycleId,
    protectionAsOf: result.protectionAsOf,
    observationAsOf,
    acknowledgement,
    executionAttempt: transitionResult.attempt,
    transitionResult,
  });
}

export class RealtimeExecutionProtectionLifecycleEngine {
  apply(input: RealtimeExecutionProtectionLifecycleInput): RealtimeExecutionProtectionLifecycleResult {
    return applyRealtimeExecutionProtectionAcknowledgement(input);
  }
}
