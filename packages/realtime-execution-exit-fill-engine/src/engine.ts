import {
  applyExitFill,
  createExitFillEvent,
  type AcknowledgedProtection,
  type AdapterCapabilities,
  type EntryCancellationRequest,
  type ExecutionAttempt,
  type ExitFillEvent,
  type FillEvent,
  type ProtectionRequest,
  type TransitionRejectedResult,
} from "@ulte/execution-engine";
import { unixMs, type UnixMs } from "@ulte/instrument-model";
import type {
  ProtectionAcknowledgementAppliedResult,
  RealtimeExecutionProtectionLifecycleResult,
} from "@ulte/realtime-execution-protection-lifecycle-engine";
import type {
  ExitFillProjectionRejectionReason,
  ExitFillRejectedResult,
  NoExitFillProcessingResult,
  RealtimeExecutionExitFillInput,
  RealtimeExecutionExitFillResult,
} from "./types.js";

function noProcessing(
  result: Exclude<RealtimeExecutionProtectionLifecycleResult, ProtectionAcknowledgementAppliedResult>,
): NoExitFillProcessingResult {
  return Object.freeze({
    status: "NO_EXIT_FILL_PROCESSING",
    preparationCycleId: result.preparationCycleId,
    upstreamStatus: result.status,
  });
}

function rejected(
  preparationCycleId: RealtimeExecutionProtectionLifecycleResult["preparationCycleId"],
  reason: ExitFillProjectionRejectionReason,
  executionAttempt?: ExecutionAttempt,
  observationAsOf?: UnixMs,
): ExitFillRejectedResult {
  return Object.freeze({
    status: "EXIT_FILL_REJECTED",
    reason,
    preparationCycleId,
    ...(executionAttempt === undefined ? {} : { executionAttempt }),
    ...(observationAsOf === undefined ? {} : { observationAsOf }),
  });
}

function transitionRejected(
  preparationCycleId: RealtimeExecutionProtectionLifecycleResult["preparationCycleId"],
  result: TransitionRejectedResult,
  observationAsOf: UnixMs,
): ExitFillRejectedResult {
  return Object.freeze({
    status: "EXIT_FILL_REJECTED",
    reason: result.reason,
    preparationCycleId,
    executionAttempt: result.attempt,
    observationAsOf,
    transitionResult: result,
  });
}

function sameCapabilities(left: AdapterCapabilities | undefined, right: AdapterCapabilities | undefined): boolean {
  if (left === undefined || right === undefined) return left === right;
  return left.supportsClientIdempotency === right.supportsClientIdempotency
    && left.supportsCloseOnlyExit === right.supportsCloseOnlyExit
    && left.supportsNativeBracketProtection === right.supportsNativeBracketProtection
    && left.supportsProtectionModification === right.supportsProtectionModification
    && left.supportsOrderCancellation === right.supportsOrderCancellation
    && left.supportsPartialFillReporting === right.supportsPartialFillReporting;
}

function sameFill(left: FillEvent, right: FillEvent): boolean {
  return left.kind === right.kind
    && left.executionAttemptId === right.executionAttemptId
    && left.adapterOrderId === right.adapterOrderId
    && left.fillId === right.fillId
    && left.filledQuantity === right.filledQuantity
    && left.fillPrice === right.fillPrice
    && left.filledAt === right.filledAt;
}

function sameExitFill(left: ExitFillEvent, right: ExitFillEvent): boolean {
  return left.kind === right.kind
    && left.executionAttemptId === right.executionAttemptId
    && left.protectionRequestId === right.protectionRequestId
    && left.exitSide === right.exitSide
    && left.exitLeg === right.exitLeg
    && left.fillId === right.fillId
    && left.filledQuantity === right.filledQuantity
    && left.fillPrice === right.fillPrice
    && left.filledAt === right.filledAt;
}

function sameRequest(left: ProtectionRequest | undefined, right: ProtectionRequest | undefined): boolean {
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

function sameCancellationRequest(
  left: EntryCancellationRequest | undefined,
  right: EntryCancellationRequest | undefined,
): boolean {
  if (left === undefined || right === undefined) return left === right;
  return left.kind === right.kind
    && left.executionAttemptId === right.executionAttemptId
    && left.cancellationRequestId === right.cancellationRequestId
    && left.idempotencyKey === right.idempotencyKey
    && left.adapterOrderId === right.adapterOrderId;
}

function sameAcknowledgedProtection(left: AcknowledgedProtection, right: AcknowledgedProtection): boolean {
  return left.kind === right.kind
    && sameRequest(left.request, right.request)
    && left.acknowledgement.kind === right.acknowledgement.kind
    && left.acknowledgement.executionAttemptId === right.acknowledgement.executionAttemptId
    && left.acknowledgement.protectionRequestId === right.acknowledgement.protectionRequestId
    && left.acknowledgement.idempotencyKey === right.acknowledgement.idempotencyKey
    && left.acknowledgement.protectedQuantity === right.acknowledgement.protectedQuantity
    && left.acknowledgement.acknowledgedAt === right.acknowledgement.acknowledgedAt;
}

function sameAttempt(left: ExecutionAttempt, right: ExecutionAttempt): boolean {
  return left.status === right.status
    && left.schemaVersion === right.schemaVersion
    && left.executionAttemptId === right.executionAttemptId
    && left.executionPlanId === right.executionPlanId
    && left.tradeIntentId === right.tradeIntentId
    && left.candidateId === right.candidateId
    && left.instrumentId === right.instrumentId
    && left.preparedAsOf === right.preparedAsOf
    && left.entrySide === right.entrySide
    && left.exitSide === right.exitSide
    && left.quantity === right.quantity
    && left.quantityUnit === right.quantityUnit
    && left.entryPrice === right.entryPrice
    && left.stopTriggerPrice === right.stopTriggerPrice
    && left.targetPrice === right.targetPrice
    && left.approvedRiskAmount === right.approvedRiskAmount
    && left.actualRiskAmount === right.actualRiskAmount
    && left.netRewardRiskBps === right.netRewardRiskBps
    && left.state === right.state
    && left.entryOrderStatus === right.entryOrderStatus
    && left.submissionIdempotencyKey === right.submissionIdempotencyKey
    && left.protectionMode === right.protectionMode
    && sameCapabilities(left.adapterCapabilities, right.adapterCapabilities)
    && left.adapterOrderId === right.adapterOrderId
    && left.filledEntryQuantity === right.filledEntryQuantity
    && left.protectedQuantity === right.protectedQuantity
    && left.exitedQuantity === right.exitedQuantity
    && left.unprotectedFilledQuantity === right.unprotectedFilledQuantity
    && left.lastFillPrice === right.lastFillPrice
    && left.processedFills.length === right.processedFills.length
    && left.processedFills.every((fill, index) => {
      const other = right.processedFills[index];
      return other !== undefined && sameFill(fill, other);
    })
    && left.processedExitFills.length === right.processedExitFills.length
    && left.processedExitFills.every((fill, index) => {
      const other = right.processedExitFills[index];
      return other !== undefined && sameExitFill(fill, other);
    })
    && left.acknowledgedProtections.length === right.acknowledgedProtections.length
    && left.acknowledgedProtections.every((record, index) => {
      const other = right.acknowledgedProtections[index];
      return other !== undefined && sameAcknowledgedProtection(record, other);
    })
    && sameRequest(left.pendingProtectionRequest, right.pendingProtectionRequest)
    && sameCancellationRequest(left.pendingCancellationRequest, right.pendingCancellationRequest)
    && left.lastExecutionEventAt === right.lastExecutionEventAt
    && left.entryRejectionReason === right.entryRejectionReason
    && left.protectionFailureReason === right.protectionFailureReason
    && left.cancellationRejectionReason === right.cancellationRejectionReason;
}

/** Accepts only the exact Task 024 snapshot plus an ordered suffix reproducible by applyExitFill. */
function coherentContinuation(source: ExecutionAttempt, current: ExecutionAttempt): boolean {
  if (current.processedExitFills.length < source.processedExitFills.length) return false;
  for (let index = 0; index < source.processedExitFills.length; index += 1) {
    const sourceFill = source.processedExitFills[index];
    const currentFill = current.processedExitFills[index];
    if (sourceFill === undefined || currentFill === undefined || !sameExitFill(sourceFill, currentFill)) return false;
  }
  let replayed = source;
  for (const fill of current.processedExitFills.slice(source.processedExitFills.length)) {
    const transition = applyExitFill(replayed, fill);
    if (transition.status !== "EXECUTION_ATTEMPT_UPDATED") return false;
    replayed = transition.attempt;
  }
  return sameAttempt(replayed, current);
}

function normalizeExitFill(
  input: RealtimeExecutionExitFillInput,
  observationAsOf: UnixMs,
): ExitFillEvent | ExitFillRejectedResult {
  if (input.exitFill === undefined) {
    return rejected(
      input.protectionLifecycle.preparationCycleId,
      "EXIT_FILL_MISSING",
      input.executionAttempt,
      observationAsOf,
    );
  }
  if (input.exitFill.kind !== "EXIT_FILL") {
    return rejected(
      input.protectionLifecycle.preparationCycleId,
      "EXIT_FILL_EVENT_NOT_NORMALIZED",
      input.executionAttempt,
      observationAsOf,
    );
  }
  try {
    return createExitFillEvent(input.exitFill);
  } catch {
    return rejected(
      input.protectionLifecycle.preparationCycleId,
      "EXIT_FILL_EVENT_NOT_NORMALIZED",
      input.executionAttempt,
      observationAsOf,
    );
  }
}

export function applyRealtimeExecutionExitFill(
  input: RealtimeExecutionExitFillInput,
): RealtimeExecutionExitFillResult {
  const lifecycle = input.protectionLifecycle;
  if (lifecycle.status !== "PROTECTION_ACKNOWLEDGEMENT_APPLIED") return noProcessing(lifecycle);

  let observationAsOf: UnixMs;
  try {
    observationAsOf = unixMs(input.observationAsOf);
  } catch {
    return rejected(lifecycle.preparationCycleId, "INVALID_OBSERVATION_TIME", input.executionAttempt);
  }
  const current = input.executionAttempt;
  if (current === undefined || !coherentContinuation(lifecycle.executionAttempt, current)) {
    return rejected(
      lifecycle.preparationCycleId,
      "CURRENT_ATTEMPT_MISMATCH",
      current ?? lifecycle.executionAttempt,
      observationAsOf,
    );
  }
  const exitFill = normalizeExitFill(input, observationAsOf);
  if (!("kind" in exitFill)) return exitFill;
  if (exitFill.filledAt > observationAsOf) {
    return rejected(
      lifecycle.preparationCycleId,
      "EXIT_FILL_OBSERVED_IN_FUTURE",
      current,
      observationAsOf,
    );
  }
  const transitionResult = applyExitFill(current, exitFill);
  if (transitionResult.status === "TRANSITION_REJECTED" || transitionResult.status === "DATA_REJECTED") {
    return transitionRejected(lifecycle.preparationCycleId, transitionResult, observationAsOf);
  }
  return Object.freeze({
    status: transitionResult.status === "DUPLICATE_EVENT_IGNORED"
      ? "DUPLICATE_EXIT_FILL"
      : "EXIT_FILL_APPLIED",
    preparationCycleId: lifecycle.preparationCycleId,
    protectionAsOf: lifecycle.protectionAsOf,
    observationAsOf,
    exitFill,
    executionAttempt: transitionResult.attempt,
    transitionResult,
  });
}

export class RealtimeExecutionExitFillEngine {
  apply(input: RealtimeExecutionExitFillInput): RealtimeExecutionExitFillResult {
    return applyRealtimeExecutionExitFill(input);
  }
}
