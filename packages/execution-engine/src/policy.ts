import {
  instrumentId,
  nonNegativeDecimalString,
  positiveDecimalString,
  unixMs,
  type NonNegativeDecimalString,
  type UnixMs,
} from "@ulte/instrument-model";
import type {
  ExecutionPreparationResult,
  ReadyExecutionPlan,
} from "@ulte/execution-preparation-engine";
import {
  createAdapterCapabilities,
  createCancellationAcknowledgement,
  createCancellationRejection,
  createEntryAcknowledgement,
  createEntryRejection,
  createFillEvent,
  createProtectionAcknowledgement,
  createProtectionRejection,
} from "./contracts.js";
import { createExecutionAttemptId, createOperationKey } from "./internal/canonical-id.js";
import { addNonNegative, compareDecimal, subtractNonNegative } from "./internal/decimal.js";
import {
  EXECUTION_ATTEMPT_SCHEMA_VERSION,
  type AdapterCapabilities,
  type AdapterCapabilitiesInput,
  type CancellationAcknowledgementInput,
  type CancellationRejectionInput,
  type CancellationRequestTransitionResult,
  type EntryAcknowledgementInput,
  type EntryCancellationRequest,
  type EntryRejectionInput,
  type EntrySubmissionRequest,
  type EntrySubmissionTransitionResult,
  type ExecutionAttempt,
  type ExecutionAttemptCreationResult,
  type ExecutionRejectionReason,
  type ExecutionState,
  type ExecutionUpdateResult,
  type FillEvent,
  type FillEventInput,
  type ProtectionAcknowledgementInput,
  type ProtectionMode,
  type ProtectionModeSelectionResult,
  type ProtectionRejectionInput,
  type ProtectionRequest,
  type ProtectionRequestTransitionResult,
  type TransitionRejectedResult,
} from "./types.js";

const ZERO = nonNegativeDecimalString("0");

function sameCapabilities(left: AdapterCapabilities, right: AdapterCapabilities): boolean {
  return left.supportsClientIdempotency === right.supportsClientIdempotency
    && left.supportsCloseOnlyExit === right.supportsCloseOnlyExit
    && left.supportsNativeBracketProtection === right.supportsNativeBracketProtection
    && left.supportsProtectionModification === right.supportsProtectionModification
    && left.supportsOrderCancellation === right.supportsOrderCancellation
    && left.supportsPartialFillReporting === right.supportsPartialFillReporting;
}

function normalizeCapabilities(input: AdapterCapabilitiesInput): AdapterCapabilities | undefined {
  try {
    return createAdapterCapabilities(input);
  } catch {
    return undefined;
  }
}

export function selectProtectionMode(capabilities: AdapterCapabilitiesInput): ProtectionModeSelectionResult {
  const normalized = normalizeCapabilities(capabilities);
  if (normalized === undefined) {
    return Object.freeze({ status: "EXECUTION_NOT_SUPPORTED", reason: "ADAPTER_NOT_SAFE_FOR_PROTECTION" });
  }
  if (normalized.supportsNativeBracketProtection) {
    return Object.freeze({ status: "PROTECTION_MODE_SELECTED", protectionMode: "NATIVE_BRACKET" });
  }
  if (normalized.supportsCloseOnlyExit && normalized.supportsPartialFillReporting) {
    return Object.freeze({ status: "PROTECTION_MODE_SELECTED", protectionMode: "MANAGED_PROTECTION" });
  }
  return Object.freeze({ status: "EXECUTION_NOT_SUPPORTED", reason: "ADAPTER_NOT_SAFE_FOR_PROTECTION" });
}

function planIsValid(plan: ReadyExecutionPlan): boolean {
  try {
    instrumentId(plan.instrumentId);
    unixMs(plan.preparedAsOf);
    positiveDecimalString(plan.quantity);
    positiveDecimalString(plan.entryInstruction.price);
    positiveDecimalString(plan.protectiveStopInstruction.triggerPrice);
    positiveDecimalString(plan.profitTargetInstruction.price);
    positiveDecimalString(plan.approvedRiskAmount);
    positiveDecimalString(plan.actualRiskAmount);
    const pricesAreCoherent = plan.entrySide === "BUY"
      ? compareDecimal(plan.protectiveStopInstruction.triggerPrice, plan.entryInstruction.price) < 0
        && compareDecimal(plan.entryInstruction.price, plan.profitTargetInstruction.price) < 0
      : compareDecimal(plan.profitTargetInstruction.price, plan.entryInstruction.price) < 0
        && compareDecimal(plan.entryInstruction.price, plan.protectiveStopInstruction.triggerPrice) < 0;
    if (
      plan.schemaVersion !== "EXECUTION_PLAN_V1"
      || plan.executionPlanId.length === 0
      || plan.tradeIntentId.length === 0
      || plan.candidateId.length === 0
      || plan.quantityUnit.length === 0
      || plan.quantityUnit.trim() !== plan.quantityUnit
      || (plan.entrySide !== "BUY" && plan.entrySide !== "SELL")
      || (plan.exitSide !== "BUY" && plan.exitSide !== "SELL")
      || plan.entryInstruction.kind !== "ENTRY_LIMIT"
      || plan.protectiveStopInstruction.kind !== "PROTECTIVE_STOP_TRIGGER"
      || plan.profitTargetInstruction.kind !== "PROFIT_TARGET_LIMIT"
      || plan.entryInstruction.positionEffect !== "OPEN"
      || plan.protectiveStopInstruction.positionEffect !== "CLOSE"
      || plan.profitTargetInstruction.positionEffect !== "CLOSE"
      || plan.entryInstruction.side !== plan.entrySide
      || plan.protectiveStopInstruction.side !== plan.exitSide
      || plan.profitTargetInstruction.side !== plan.exitSide
      || plan.entrySide === plan.exitSide
      || compareDecimal(plan.entryInstruction.quantity, plan.quantity) !== 0
      || compareDecimal(plan.protectiveStopInstruction.quantity, plan.quantity) !== 0
      || compareDecimal(plan.profitTargetInstruction.quantity, plan.quantity) !== 0
      || compareDecimal(plan.actualRiskAmount, plan.approvedRiskAmount) > 0
      || !pricesAreCoherent
    ) return false;
    return true;
  } catch {
    return false;
  }
}

function deriveState(attempt: Omit<ExecutionAttempt, "state" | "unprotectedFilledQuantity">): ExecutionState {
  if (attempt.protectionFailureReason !== undefined) return "FAILED";
  if (attempt.entryOrderStatus === "REJECTED") return "REJECTED";
  if (attempt.pendingCancellationRequest !== undefined) return "CANCEL_PENDING";
  if (attempt.pendingProtectionRequest !== undefined) return "PROTECTION_PENDING";
  if (attempt.entryOrderStatus === "CANCELED") {
    return compareDecimal(attempt.filledEntryQuantity, ZERO) === 0
      ? "CANCELED"
      : "ENTRY_CANCELED_WITH_EXPOSURE";
  }
  if (attempt.entryOrderStatus === "FILLED") {
    return compareDecimal(attempt.protectedQuantity, attempt.filledEntryQuantity) === 0
      ? "PROTECTED"
      : "ENTRY_FILLED";
  }
  if (compareDecimal(attempt.filledEntryQuantity, ZERO) > 0) return "ENTRY_PARTIALLY_FILLED";
  if (attempt.entryOrderStatus === "WORKING") return "ENTRY_WORKING";
  if (attempt.entryOrderStatus === "SUBMISSION_PENDING") return "ENTRY_SUBMISSION_PENDING";
  return "READY_FOR_ENTRY_SUBMISSION";
}

type MutableAttempt = { -readonly [Key in keyof ExecutionAttempt]: ExecutionAttempt[Key] };

function evolve(
  attempt: ExecutionAttempt,
  updates: Partial<ExecutionAttempt>,
  remove: readonly (keyof ExecutionAttempt)[] = [],
): ExecutionAttempt {
  const draft = { ...attempt, ...updates } as MutableAttempt;
  for (const key of remove) Reflect.deleteProperty(draft, key);
  draft.processedFills = Object.freeze([...draft.processedFills]);
  draft.unprotectedFilledQuantity = subtractNonNegative(draft.filledEntryQuantity, draft.protectedQuantity);
  draft.state = deriveState(draft);
  return Object.freeze(draft);
}

function rejected(
  attempt: ExecutionAttempt,
  reason: ExecutionRejectionReason,
  dataRejected = false,
): TransitionRejectedResult {
  return Object.freeze({
    status: dataRejected ? "DATA_REJECTED" : "TRANSITION_REJECTED",
    reason,
    attempt,
  });
}

function updated(attempt: ExecutionAttempt, duplicate = false): ExecutionUpdateResult {
  return Object.freeze({
    status: duplicate ? "DUPLICATE_EVENT_IGNORED" : "EXECUTION_ATTEMPT_UPDATED",
    attempt,
  });
}

function eventTimeAccepted(attempt: ExecutionAttempt, eventAt: UnixMs): boolean {
  return attempt.lastExecutionEventAt === undefined || eventAt >= attempt.lastExecutionEventAt;
}

export function createExecutionAttempt(plan: ExecutionPreparationResult): ExecutionAttemptCreationResult {
  if (plan.status !== "EXECUTION_PLAN_READY") {
    return Object.freeze({
      status: "UPSTREAM_NOT_READY",
      executionPlanStatus: plan.status,
      candidateId: plan.candidateId,
    });
  }
  if (!planIsValid(plan)) {
    return Object.freeze({ status: "DATA_REJECTED", reason: "INVALID_EXECUTION_PLAN", candidateId: plan.candidateId });
  }
  const executionAttemptId = createExecutionAttemptId({
    executionPlanId: plan.executionPlanId,
    tradeIntentId: plan.tradeIntentId,
    instrumentId: plan.instrumentId,
    entrySide: plan.entrySide,
    quantity: plan.quantity,
    entryPrice: plan.entryInstruction.price,
    stopTriggerPrice: plan.protectiveStopInstruction.triggerPrice,
    targetPrice: plan.profitTargetInstruction.price,
  });
  const attempt: ExecutionAttempt = Object.freeze({
    status: "EXECUTION_ATTEMPT_READY",
    schemaVersion: EXECUTION_ATTEMPT_SCHEMA_VERSION,
    executionAttemptId,
    executionPlanId: plan.executionPlanId,
    tradeIntentId: plan.tradeIntentId,
    candidateId: plan.candidateId,
    instrumentId: plan.instrumentId,
    preparedAsOf: plan.preparedAsOf,
    entrySide: plan.entrySide,
    exitSide: plan.exitSide,
    quantity: plan.quantity,
    quantityUnit: plan.quantityUnit,
    entryPrice: plan.entryInstruction.price,
    stopTriggerPrice: plan.protectiveStopInstruction.triggerPrice,
    targetPrice: plan.profitTargetInstruction.price,
    approvedRiskAmount: plan.approvedRiskAmount,
    actualRiskAmount: plan.actualRiskAmount,
    netRewardRiskBps: plan.netRewardRiskBps,
    state: "READY_FOR_ENTRY_SUBMISSION",
    entryOrderStatus: "NOT_SUBMITTED",
    submissionIdempotencyKey: createOperationKey(executionAttemptId, "ENTRY_SUBMISSION"),
    filledEntryQuantity: ZERO,
    protectedQuantity: ZERO,
    unprotectedFilledQuantity: ZERO,
    processedFills: Object.freeze([]),
  });
  return attempt;
}

function entryRequest(attempt: ExecutionAttempt): EntrySubmissionRequest {
  return Object.freeze({
    kind: "ENTRY",
    executionAttemptId: attempt.executionAttemptId,
    idempotencyKey: attempt.submissionIdempotencyKey,
    instrumentId: attempt.instrumentId,
    side: attempt.entrySide,
    quantity: attempt.quantity,
    limitPrice: attempt.entryPrice,
  });
}

export function requestEntrySubmission(
  attempt: ExecutionAttempt,
  capabilitiesInput: AdapterCapabilitiesInput,
): EntrySubmissionTransitionResult {
  const capabilities = normalizeCapabilities(capabilitiesInput);
  if (capabilities === undefined) return rejected(attempt, "INVALID_ADAPTER_CAPABILITIES");
  const selection = selectProtectionMode(capabilities);
  if (selection.status === "EXECUTION_NOT_SUPPORTED") return Object.freeze({ ...selection, attempt });

  if (attempt.entryOrderStatus === "SUBMISSION_PENDING") {
    if (attempt.adapterCapabilities === undefined || !sameCapabilities(attempt.adapterCapabilities, capabilities)) {
      return rejected(attempt, "ADAPTER_CAPABILITIES_MISMATCH");
    }
    return Object.freeze({ status: "ENTRY_SUBMISSION_READY", attempt, request: entryRequest(attempt) });
  }
  if (attempt.entryOrderStatus !== "NOT_SUBMITTED") return rejected(attempt, "INVALID_TRANSITION");

  const next = evolve(attempt, {
    entryOrderStatus: "SUBMISSION_PENDING",
    protectionMode: selection.protectionMode,
    adapterCapabilities: capabilities,
  });
  return Object.freeze({ status: "ENTRY_SUBMISSION_READY", attempt: next, request: entryRequest(next) });
}

export function acknowledgeEntrySubmission(
  attempt: ExecutionAttempt,
  input: EntryAcknowledgementInput,
): ExecutionUpdateResult {
  let event;
  try { event = createEntryAcknowledgement(input); } catch { return rejected(attempt, "INVALID_EVENT", true); }
  if (event.executionAttemptId !== attempt.executionAttemptId) return rejected(attempt, "EVENT_ATTEMPT_MISMATCH");
  if (event.idempotencyKey !== attempt.submissionIdempotencyKey) return rejected(attempt, "IDEMPOTENCY_KEY_MISMATCH");
  if (attempt.entryOrderStatus !== "SUBMISSION_PENDING") return rejected(attempt, "INVALID_TRANSITION");
  if (!eventTimeAccepted(attempt, event.acknowledgedAt)) return rejected(attempt, "OUT_OF_ORDER_EXECUTION_EVENT");
  return updated(evolve(attempt, {
    entryOrderStatus: "WORKING",
    adapterOrderId: event.adapterOrderId,
    lastExecutionEventAt: event.acknowledgedAt,
  }));
}

export function rejectEntrySubmission(attempt: ExecutionAttempt, input: EntryRejectionInput): ExecutionUpdateResult {
  let event;
  try { event = createEntryRejection(input); } catch { return rejected(attempt, "INVALID_EVENT", true); }
  if (event.executionAttemptId !== attempt.executionAttemptId) return rejected(attempt, "EVENT_ATTEMPT_MISMATCH");
  if (event.idempotencyKey !== attempt.submissionIdempotencyKey) return rejected(attempt, "IDEMPOTENCY_KEY_MISMATCH");
  if (attempt.entryOrderStatus !== "SUBMISSION_PENDING") return rejected(attempt, "INVALID_TRANSITION");
  if (!eventTimeAccepted(attempt, event.rejectedAt)) return rejected(attempt, "OUT_OF_ORDER_EXECUTION_EVENT");
  return updated(evolve(attempt, {
    entryOrderStatus: "REJECTED",
    entryRejectionReason: event.adapterReasonCode,
    lastExecutionEventAt: event.rejectedAt,
  }));
}

function sameFill(left: FillEvent, right: FillEvent): boolean {
  return left.executionAttemptId === right.executionAttemptId
    && left.adapterOrderId === right.adapterOrderId
    && left.fillId === right.fillId
    && compareDecimal(left.filledQuantity, right.filledQuantity) === 0
    && compareDecimal(left.fillPrice, right.fillPrice) === 0
    && left.filledAt === right.filledAt;
}

export function applyEntryFill(attempt: ExecutionAttempt, input: FillEventInput): ExecutionUpdateResult {
  let event;
  try { event = createFillEvent(input); } catch { return rejected(attempt, "INVALID_EVENT", true); }
  if (event.executionAttemptId !== attempt.executionAttemptId) return rejected(attempt, "EVENT_ATTEMPT_MISMATCH");
  const prior = attempt.processedFills.find((fill) => fill.fillId === event.fillId);
  if (prior !== undefined) {
    return sameFill(prior, event)
      ? updated(attempt, true)
      : rejected(attempt, "DUPLICATE_FILL_CONFLICT", true);
  }
  if (attempt.entryOrderStatus !== "WORKING") return rejected(attempt, "INVALID_TRANSITION");
  if (attempt.adapterOrderId !== event.adapterOrderId) return rejected(attempt, "ADAPTER_ORDER_ID_MISMATCH");
  if (!eventTimeAccepted(attempt, event.filledAt)) return rejected(attempt, "OUT_OF_ORDER_EXECUTION_EVENT");
  const cumulative = addNonNegative(attempt.filledEntryQuantity, event.filledQuantity);
  if (compareDecimal(cumulative, attempt.quantity) > 0) return rejected(attempt, "OVERFILL_DETECTED", true);
  return updated(evolve(attempt, {
    entryOrderStatus: compareDecimal(cumulative, attempt.quantity) === 0 ? "FILLED" : "WORKING",
    filledEntryQuantity: cumulative,
    lastFillPrice: event.fillPrice,
    processedFills: Object.freeze([...attempt.processedFills, event]),
    lastExecutionEventAt: event.filledAt,
  }));
}

function protectionRequest(attempt: ExecutionAttempt): ProtectionRequest {
  const uncovered = subtractNonNegative(attempt.filledEntryQuantity, attempt.protectedQuantity);
  const protectedQuantity = positiveDecimalString(uncovered);
  const cumulative = positiveDecimalString(attempt.filledEntryQuantity);
  const key = createOperationKey(attempt.executionAttemptId, "PROTECTION", cumulative);
  return Object.freeze({
    kind: "PROTECTION",
    executionAttemptId: attempt.executionAttemptId,
    protectionRequestId: `ulte:protection-request:${key}`,
    idempotencyKey: key,
    instrumentId: attempt.instrumentId,
    mode: attempt.protectionMode as ProtectionMode,
    exitSide: attempt.exitSide,
    protectedQuantity,
    targetCumulativeProtectedQuantity: cumulative,
    stopTriggerPrice: attempt.stopTriggerPrice,
    targetPrice: attempt.targetPrice,
  });
}

export function requestProtection(attempt: ExecutionAttempt): ProtectionRequestTransitionResult {
  if (attempt.pendingProtectionRequest !== undefined) {
    return Object.freeze({
      status: "PROTECTION_REQUEST_READY",
      attempt,
      request: attempt.pendingProtectionRequest,
    });
  }
  const capabilities = attempt.adapterCapabilities;
  if (capabilities === undefined || attempt.protectionMode === undefined) return rejected(attempt, "INVALID_TRANSITION");
  if (attempt.protectionFailureReason !== undefined) return rejected(attempt, "INVALID_TRANSITION");
  const safe = attempt.protectionMode === "NATIVE_BRACKET"
    ? capabilities.supportsNativeBracketProtection
    : capabilities.supportsCloseOnlyExit && capabilities.supportsPartialFillReporting;
  if (!safe) {
    return Object.freeze({ status: "EXECUTION_NOT_SUPPORTED", reason: "ADAPTER_NOT_SAFE_FOR_PROTECTION", attempt });
  }
  if (
    attempt.entryOrderStatus === "NOT_SUBMITTED"
    || attempt.entryOrderStatus === "SUBMISSION_PENDING"
    || attempt.entryOrderStatus === "REJECTED"
  ) return rejected(attempt, "INVALID_TRANSITION");
  if (compareDecimal(attempt.unprotectedFilledQuantity, ZERO) === 0) {
    return rejected(attempt, "NO_UNPROTECTED_FILLED_QUANTITY");
  }
  const request = protectionRequest(attempt);
  const next = evolve(attempt, { pendingProtectionRequest: request });
  return Object.freeze({ status: "PROTECTION_REQUEST_READY", attempt: next, request });
}

export function acknowledgeProtection(
  attempt: ExecutionAttempt,
  input: ProtectionAcknowledgementInput,
): ExecutionUpdateResult {
  let event;
  try { event = createProtectionAcknowledgement(input); } catch { return rejected(attempt, "INVALID_EVENT", true); }
  if (event.executionAttemptId !== attempt.executionAttemptId) return rejected(attempt, "EVENT_ATTEMPT_MISMATCH");
  const pending = attempt.pendingProtectionRequest;
  if (pending === undefined) return rejected(attempt, "INVALID_TRANSITION");
  if (event.protectionRequestId !== pending.protectionRequestId || event.idempotencyKey !== pending.idempotencyKey) {
    return rejected(attempt, "PROTECTION_REQUEST_MISMATCH");
  }
  if (compareDecimal(event.protectedQuantity, pending.targetCumulativeProtectedQuantity) !== 0) {
    return rejected(attempt, "PROTECTION_REQUEST_MISMATCH");
  }
  if (compareDecimal(event.protectedQuantity, attempt.protectedQuantity) < 0
    || compareDecimal(event.protectedQuantity, attempt.filledEntryQuantity) > 0) {
    return rejected(attempt, "PROTECTED_QUANTITY_EXCEEDS_FILLED", true);
  }
  if (!eventTimeAccepted(attempt, event.acknowledgedAt)) return rejected(attempt, "OUT_OF_ORDER_EXECUTION_EVENT");
  return updated(evolve(attempt, {
    protectedQuantity: event.protectedQuantity,
    lastExecutionEventAt: event.acknowledgedAt,
  }, ["pendingProtectionRequest"]));
}

export function rejectProtection(attempt: ExecutionAttempt, input: ProtectionRejectionInput): ExecutionUpdateResult {
  let event;
  try { event = createProtectionRejection(input); } catch { return rejected(attempt, "INVALID_EVENT", true); }
  if (event.executionAttemptId !== attempt.executionAttemptId) return rejected(attempt, "EVENT_ATTEMPT_MISMATCH");
  const pending = attempt.pendingProtectionRequest;
  if (pending === undefined) return rejected(attempt, "INVALID_TRANSITION");
  if (event.protectionRequestId !== pending.protectionRequestId || event.idempotencyKey !== pending.idempotencyKey) {
    return rejected(attempt, "PROTECTION_REQUEST_MISMATCH");
  }
  if (!eventTimeAccepted(attempt, event.rejectedAt)) return rejected(attempt, "OUT_OF_ORDER_EXECUTION_EVENT");
  return updated(evolve(attempt, {
    protectionFailureReason: event.adapterReasonCode,
    lastExecutionEventAt: event.rejectedAt,
  }, ["pendingProtectionRequest"]));
}

function cancellationRequest(attempt: ExecutionAttempt): EntryCancellationRequest {
  const key = createOperationKey(attempt.executionAttemptId, "ENTRY_CANCELLATION");
  return Object.freeze({
    kind: "ENTRY_CANCELLATION",
    executionAttemptId: attempt.executionAttemptId,
    cancellationRequestId: `ulte:cancellation-request:${key}`,
    idempotencyKey: key,
    adapterOrderId: attempt.adapterOrderId as string,
  });
}

export function requestEntryCancellation(attempt: ExecutionAttempt): CancellationRequestTransitionResult {
  if (attempt.pendingCancellationRequest !== undefined) {
    return Object.freeze({
      status: "CANCELLATION_REQUEST_READY",
      attempt,
      request: attempt.pendingCancellationRequest,
    });
  }
  if (attempt.adapterCapabilities?.supportsOrderCancellation !== true) {
    return Object.freeze({ status: "EXECUTION_NOT_SUPPORTED", reason: "ADAPTER_DOES_NOT_SUPPORT_CANCELLATION", attempt });
  }
  if (
    attempt.entryOrderStatus !== "WORKING"
    || attempt.adapterOrderId === undefined
    || compareDecimal(attempt.filledEntryQuantity, attempt.quantity) >= 0
  ) return rejected(attempt, "INVALID_TRANSITION");
  const request = cancellationRequest(attempt);
  const next = evolve(attempt, { pendingCancellationRequest: request });
  return Object.freeze({ status: "CANCELLATION_REQUEST_READY", attempt: next, request });
}

export function acknowledgeCancellation(
  attempt: ExecutionAttempt,
  input: CancellationAcknowledgementInput,
): ExecutionUpdateResult {
  let event;
  try { event = createCancellationAcknowledgement(input); } catch { return rejected(attempt, "INVALID_EVENT", true); }
  if (event.executionAttemptId !== attempt.executionAttemptId) return rejected(attempt, "EVENT_ATTEMPT_MISMATCH");
  const pending = attempt.pendingCancellationRequest;
  if (pending === undefined) return rejected(attempt, "INVALID_TRANSITION");
  if (
    event.cancellationRequestId !== pending.cancellationRequestId
    || event.idempotencyKey !== pending.idempotencyKey
  ) return rejected(attempt, "CANCELLATION_REQUEST_MISMATCH");
  if (event.adapterOrderId !== attempt.adapterOrderId) return rejected(attempt, "ADAPTER_ORDER_ID_MISMATCH");
  if (!eventTimeAccepted(attempt, event.acknowledgedAt)) return rejected(attempt, "OUT_OF_ORDER_EXECUTION_EVENT");
  if (compareDecimal(attempt.filledEntryQuantity, attempt.quantity) === 0) {
    return updated(evolve(attempt, {
      entryOrderStatus: "FILLED",
      lastExecutionEventAt: event.acknowledgedAt,
    }, ["pendingCancellationRequest"]));
  }
  return updated(evolve(attempt, {
    entryOrderStatus: "CANCELED",
    lastExecutionEventAt: event.acknowledgedAt,
  }, ["pendingCancellationRequest"]));
}

export function rejectCancellation(
  attempt: ExecutionAttempt,
  input: CancellationRejectionInput,
): ExecutionUpdateResult {
  let event;
  try { event = createCancellationRejection(input); } catch { return rejected(attempt, "INVALID_EVENT", true); }
  if (event.executionAttemptId !== attempt.executionAttemptId) return rejected(attempt, "EVENT_ATTEMPT_MISMATCH");
  const pending = attempt.pendingCancellationRequest;
  if (pending === undefined) return rejected(attempt, "INVALID_TRANSITION");
  if (
    event.cancellationRequestId !== pending.cancellationRequestId
    || event.idempotencyKey !== pending.idempotencyKey
  ) return rejected(attempt, "CANCELLATION_REQUEST_MISMATCH");
  if (event.adapterOrderId !== attempt.adapterOrderId) return rejected(attempt, "ADAPTER_ORDER_ID_MISMATCH");
  if (!eventTimeAccepted(attempt, event.rejectedAt)) return rejected(attempt, "OUT_OF_ORDER_EXECUTION_EVENT");
  return updated(evolve(attempt, {
    cancellationRejectionReason: event.adapterReasonCode,
    lastExecutionEventAt: event.rejectedAt,
  }, ["pendingCancellationRequest"]));
}
