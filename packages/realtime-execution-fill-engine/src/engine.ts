import {
  acknowledgeEntrySubmission,
  applyEntryFill,
  createFillEvent,
  type EntryAcknowledgement,
  type ExecutionAttempt,
  type FillEvent,
  type TransitionRejectedResult,
} from "@ulte/execution-engine";
import { unixMs, type UnixMs } from "@ulte/instrument-model";
import type {
  RealtimeExecutionSubmissionResult,
  SubmissionConfirmedResult,
} from "@ulte/realtime-execution-submission-engine";
import type {
  FillLifecycleInitializationResult,
  FillLifecycleInitializedResult,
  FillOrchestrationRejectionReason,
  FillRejectedResult,
  NoFillProcessingResult,
  RealtimeExecutionFillInput,
  RealtimeExecutionFillResult,
} from "./types.js";

function noFillProcessing(
  submission: Exclude<RealtimeExecutionSubmissionResult, SubmissionConfirmedResult>,
): NoFillProcessingResult {
  return Object.freeze({
    status: "NO_FILL_PROCESSING",
    preparationCycleId: submission.preparationCycleId,
    upstreamStatus: submission.status,
  });
}

function orchestrationRejected(
  preparationCycleId: RealtimeExecutionSubmissionResult["preparationCycleId"],
  reason: FillOrchestrationRejectionReason,
  executionAttempt?: ExecutionAttempt,
  observationAsOf?: UnixMs,
): FillRejectedResult {
  return Object.freeze({
    status: "FILL_REJECTED",
    reason,
    preparationCycleId,
    ...(executionAttempt === undefined ? {} : { executionAttempt }),
    ...(observationAsOf === undefined ? {} : { observationAsOf }),
  });
}

function transitionRejected(
  preparationCycleId: RealtimeExecutionSubmissionResult["preparationCycleId"],
  transitionResult: TransitionRejectedResult,
  observationAsOf?: UnixMs,
): FillRejectedResult {
  return Object.freeze({
    status: "FILL_REJECTED",
    reason: transitionResult.reason,
    preparationCycleId,
    executionAttempt: transitionResult.attempt,
    ...(observationAsOf === undefined ? {} : { observationAsOf }),
    transitionResult,
  });
}

function actualAcknowledgement(submission: SubmissionConfirmedResult): EntryAcknowledgement | undefined {
  const acknowledgement = submission.durableResult.acknowledgement;
  return acknowledgement?.kind === "SUBMISSION_ACCEPTED" ? acknowledgement : undefined;
}

function hasCoherentSubmissionIdentity(
  submission: SubmissionConfirmedResult,
  acknowledgement: EntryAcknowledgement,
): boolean {
  const attempt = submission.executionAttempt;
  const durable = submission.durableResult;
  return attempt.entryOrderStatus === "SUBMISSION_PENDING"
    && attempt.processedFills.length === 0
    && attempt.filledEntryQuantity === "0"
    && acknowledgement.executionAttemptId === attempt.executionAttemptId
    && acknowledgement.idempotencyKey === attempt.submissionIdempotencyKey
    && durable.idempotencyKey === attempt.submissionIdempotencyKey
    && durable.record.executionAttemptId === attempt.executionAttemptId
    && durable.record.idempotencyKey === attempt.submissionIdempotencyKey
    && durable.record.adapterOrderId === acknowledgement.adapterOrderId;
}

function hasSameExecutionIdentity(
  source: ExecutionAttempt,
  current: ExecutionAttempt,
  acknowledgement: EntryAcknowledgement,
): boolean {
  return current.executionAttemptId === source.executionAttemptId
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
    && current.submissionIdempotencyKey === source.submissionIdempotencyKey
    && current.adapterOrderId === acknowledgement.adapterOrderId
    && current.lastExecutionEventAt !== undefined
    && current.lastExecutionEventAt >= acknowledgement.acknowledgedAt;
}

export function initializeRealtimeExecutionFillLifecycle(
  submission: RealtimeExecutionSubmissionResult,
): FillLifecycleInitializationResult {
  if (submission.status !== "SUBMISSION_CONFIRMED") return noFillProcessing(submission);
  const acknowledgement = actualAcknowledgement(submission);
  if (acknowledgement === undefined) {
    return orchestrationRejected(
      submission.preparationCycleId,
      "CONFIRMED_ACKNOWLEDGEMENT_MISSING",
      submission.executionAttempt,
    );
  }
  if (!hasCoherentSubmissionIdentity(submission, acknowledgement)) {
    return orchestrationRejected(
      submission.preparationCycleId,
      "SUBMISSION_STATE_INCOHERENT",
      submission.executionAttempt,
    );
  }
  if (acknowledgement.acknowledgedAt < submission.submissionAsOf) {
    return orchestrationRejected(
      submission.preparationCycleId,
      "ACKNOWLEDGEMENT_CHRONOLOGY_INVALID",
      submission.executionAttempt,
    );
  }
  const transition = acknowledgeEntrySubmission(submission.executionAttempt, acknowledgement);
  if ("reason" in transition) {
    return transitionRejected(submission.preparationCycleId, transition);
  }
  if (transition.status !== "EXECUTION_ATTEMPT_UPDATED") {
    throw new Error("A new acknowledgement cannot be a duplicate transition");
  }
  const result: FillLifecycleInitializedResult = Object.freeze({
    status: "FILL_LIFECYCLE_INITIALIZED",
    preparationCycleId: submission.preparationCycleId,
    submissionAsOf: submission.submissionAsOf,
    acknowledgement,
    executionAttempt: transition.attempt,
  });
  return result;
}

function normalizedFillOrRejection(
  input: RealtimeExecutionFillInput,
  observationAsOf: UnixMs,
): FillEvent | FillRejectedResult {
  if (input.fill.kind !== "FILL") {
    return orchestrationRejected(
      input.submission.preparationCycleId,
      "FILL_EVENT_NOT_NORMALIZED",
      input.executionAttempt,
      observationAsOf,
    );
  }
  try {
    return createFillEvent(input.fill);
  } catch {
    const transition = applyEntryFill(input.executionAttempt, input.fill);
    if (!("reason" in transition)) {
      throw new Error("Execution fill validation contracts disagree");
    }
    return transitionRejected(input.submission.preparationCycleId, transition, observationAsOf);
  }
}

export function applyRealtimeExecutionFill(input: RealtimeExecutionFillInput): RealtimeExecutionFillResult {
  const submission = input.submission;
  if (submission.status !== "SUBMISSION_CONFIRMED") return noFillProcessing(submission);
  const initialized = initializeRealtimeExecutionFillLifecycle(submission);
  if (initialized.status !== "FILL_LIFECYCLE_INITIALIZED") return initialized;

  let observationAsOf: UnixMs;
  try {
    observationAsOf = unixMs(input.observationAsOf);
  } catch {
    return orchestrationRejected(
      submission.preparationCycleId,
      "INVALID_OBSERVATION_TIME",
      input.executionAttempt,
    );
  }
  if (!hasSameExecutionIdentity(
    submission.executionAttempt,
    input.executionAttempt,
    initialized.acknowledgement,
  )) {
    return orchestrationRejected(
      submission.preparationCycleId,
      "CURRENT_ATTEMPT_MISMATCH",
      input.executionAttempt,
      observationAsOf,
    );
  }
  const fill = normalizedFillOrRejection(input, observationAsOf);
  if (!("kind" in fill)) return fill;
  if (fill.filledAt > observationAsOf) {
    return orchestrationRejected(
      submission.preparationCycleId,
      "FILL_OBSERVED_IN_FUTURE",
      input.executionAttempt,
      observationAsOf,
    );
  }
  const transitionResult = applyEntryFill(input.executionAttempt, fill);
  if (transitionResult.status === "TRANSITION_REJECTED" || transitionResult.status === "DATA_REJECTED") {
    return transitionRejected(submission.preparationCycleId, transitionResult, observationAsOf);
  }
  return Object.freeze({
    status: transitionResult.status === "DUPLICATE_EVENT_IGNORED" ? "DUPLICATE_FILL" : "FILL_APPLIED",
    preparationCycleId: submission.preparationCycleId,
    submissionAsOf: submission.submissionAsOf,
    observationAsOf,
    fill,
    executionAttempt: transitionResult.attempt,
    transitionResult,
  });
}
