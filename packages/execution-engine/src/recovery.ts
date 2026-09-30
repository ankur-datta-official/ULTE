import { instrumentId } from "@ulte/instrument-model";
import {
  restoreReadyExecutionPlan,
  type ReadyExecutionPlan,
} from "@ulte/execution-preparation-engine";
import {
  createAdapterCapabilities,
  createCancellationAcknowledgement,
  createCancellationRejection,
  createEntryAcknowledgement,
  createEntryRejection,
  createExitFillEvent,
  createFillEvent,
  createProtectionAcknowledgement,
  createProtectionRejection,
} from "./contracts.js";
import {
  acknowledgeCancellation,
  acknowledgeEntrySubmission,
  acknowledgeProtection,
  applyEntryFill,
  applyExitFill,
  createExecutionAttempt,
  rejectCancellation,
  rejectEntrySubmission,
  rejectProtection,
  requestEntryCancellation,
  requestEntrySubmission,
  requestProtection,
} from "./policy.js";
import {
  EXECUTION_ATTEMPT_RECOVERY_EVIDENCE_SCHEMA_VERSION,
  type AdapterCapabilitiesInput,
  type CancellationAcknowledgementInput,
  type CancellationRejectionInput,
  type EntryAcknowledgementInput,
  type EntryRejectionInput,
  type ExecutionAttempt,
  type ExecutionAttemptRecoveryEvidenceV1,
  type ExecutionAttemptRecoveryEvidenceValidationResult,
  type ExecutionAttemptRecoveryTransition,
  type ExecutionAttemptRestorationResult,
  type ExitFillEventInput,
  type FillEventInput,
  type ProtectionAcknowledgementInput,
  type ProtectionRejectionInput,
} from "./types.js";

type DataRecord = Readonly<Record<string, unknown>>;

function isRecord(value: unknown): value is DataRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: DataRecord, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
}

function isDenseArray(value: unknown): value is readonly unknown[] {
  if (!Array.isArray(value)
      || Object.keys(value).length !== value.length
      || Reflect.ownKeys(value).length !== value.length + 1) return false;
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.prototype.hasOwnProperty.call(value, index)) return false;
  }
  return true;
}

function isCanonicalId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.trim() === value;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isPlainJsonData(value: unknown, ancestors: ReadonlySet<object> = new Set()): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object") return false;
  if (ancestors.has(value)) return false;
  if (Object.getPrototypeOf(value) !== Object.prototype && !Array.isArray(value)) return false;
  const nextAncestors = new Set(ancestors);
  nextAncestors.add(value);
  if (Array.isArray(value)) {
    return isDenseArray(value) && value.every((item) => isPlainJsonData(item, nextAncestors));
  }
  return Object.values(value).every((item) => isPlainJsonData(item, nextAncestors));
}

function isAdapterCapabilitiesInput(value: unknown): value is AdapterCapabilitiesInput {
  if (!isRecord(value)) return false;
  const keys = [
    "supportsClientIdempotency",
    "supportsCloseOnlyExit",
    "supportsNativeBracketProtection",
    "supportsProtectionModification",
    "supportsOrderCancellation",
    "supportsPartialFillReporting",
  ] as const;
  return hasExactKeys(value, keys) && keys.every((key) => typeof value[key] === "boolean");
}

function isEntryAcknowledgementInput(value: unknown): value is EntryAcknowledgementInput {
  return isRecord(value)
    && hasExactKeys(value, ["executionAttemptId", "idempotencyKey", "adapterOrderId", "acknowledgedAt"])
    && isCanonicalId(value["executionAttemptId"])
    && isCanonicalId(value["idempotencyKey"]) && isCanonicalId(value["adapterOrderId"])
    && isFiniteNumber(value["acknowledgedAt"]);
}

function isEntryRejectionInput(value: unknown): value is EntryRejectionInput {
  return isRecord(value)
    && hasExactKeys(value, ["executionAttemptId", "idempotencyKey", "adapterReasonCode", "rejectedAt"])
    && isCanonicalId(value["executionAttemptId"])
    && isCanonicalId(value["idempotencyKey"]) && isCanonicalId(value["adapterReasonCode"])
    && isFiniteNumber(value["rejectedAt"]);
}

function isFillInput(value: unknown): value is FillEventInput {
  return isRecord(value)
    && hasExactKeys(value, [
      "executionAttemptId", "adapterOrderId", "fillId", "filledQuantity", "fillPrice", "filledAt",
    ])
    && isCanonicalId(value["executionAttemptId"])
    && isCanonicalId(value["adapterOrderId"]) && isCanonicalId(value["fillId"])
    && typeof value["filledQuantity"] === "string" && typeof value["fillPrice"] === "string"
    && isFiniteNumber(value["filledAt"]);
}

function isProtectionAcknowledgementInput(value: unknown): value is ProtectionAcknowledgementInput {
  return isRecord(value)
    && hasExactKeys(value, [
      "executionAttemptId", "protectionRequestId", "idempotencyKey", "protectedQuantity", "acknowledgedAt",
    ])
    && isCanonicalId(value["executionAttemptId"])
    && isCanonicalId(value["protectionRequestId"]) && isCanonicalId(value["idempotencyKey"])
    && typeof value["protectedQuantity"] === "string" && isFiniteNumber(value["acknowledgedAt"]);
}

function isProtectionRejectionInput(value: unknown): value is ProtectionRejectionInput {
  return isRecord(value)
    && hasExactKeys(value, [
      "executionAttemptId", "protectionRequestId", "idempotencyKey", "adapterReasonCode", "rejectedAt",
    ])
    && isCanonicalId(value["executionAttemptId"])
    && isCanonicalId(value["protectionRequestId"]) && isCanonicalId(value["idempotencyKey"])
    && isCanonicalId(value["adapterReasonCode"]) && isFiniteNumber(value["rejectedAt"]);
}

function isCancellationAcknowledgementInput(value: unknown): value is CancellationAcknowledgementInput {
  return isRecord(value)
    && hasExactKeys(value, [
      "executionAttemptId", "cancellationRequestId", "idempotencyKey", "adapterOrderId", "acknowledgedAt",
    ])
    && isCanonicalId(value["executionAttemptId"])
    && isCanonicalId(value["cancellationRequestId"]) && isCanonicalId(value["idempotencyKey"])
    && isCanonicalId(value["adapterOrderId"]) && isFiniteNumber(value["acknowledgedAt"]);
}

function isCancellationRejectionInput(value: unknown): value is CancellationRejectionInput {
  return isRecord(value)
    && hasExactKeys(value, [
      "executionAttemptId", "cancellationRequestId", "idempotencyKey", "adapterOrderId", "adapterReasonCode",
      "rejectedAt",
    ])
    && isCanonicalId(value["executionAttemptId"])
    && isCanonicalId(value["cancellationRequestId"]) && isCanonicalId(value["idempotencyKey"])
    && isCanonicalId(value["adapterOrderId"]) && isCanonicalId(value["adapterReasonCode"])
    && isFiniteNumber(value["rejectedAt"]);
}

function isExitFillInput(value: unknown): value is ExitFillEventInput {
  return isRecord(value)
    && hasExactKeys(value, [
      "executionAttemptId", "protectionRequestId", "exitSide", "exitLeg", "fillId", "filledQuantity",
      "fillPrice", "filledAt",
    ])
    && isCanonicalId(value["executionAttemptId"])
    && isCanonicalId(value["protectionRequestId"]) && isCanonicalId(value["fillId"])
    && (value["exitSide"] === "BUY" || value["exitSide"] === "SELL")
    && (value["exitLeg"] === "PROTECTIVE_STOP" || value["exitLeg"] === "PROFIT_TARGET")
    && typeof value["filledQuantity"] === "string" && typeof value["fillPrice"] === "string"
    && isFiniteNumber(value["filledAt"]);
}

function canonicalTransition(value: unknown): value is ExecutionAttemptRecoveryTransition {
  if (!isRecord(value) || typeof value["kind"] !== "string") return false;
  try {
    switch (value["kind"]) {
      case "ENTRY_SUBMISSION_REQUESTED":
        if (!hasExactKeys(value, ["kind", "adapterCapabilities"])) return false;
        if (!isAdapterCapabilitiesInput(value["adapterCapabilities"])) return false;
        createAdapterCapabilities(value["adapterCapabilities"]);
        return true;
      case "ENTRY_SUBMISSION_ACKNOWLEDGED":
        if (!hasExactKeys(value, ["kind", "acknowledgement"])) return false;
        if (!isEntryAcknowledgementInput(value["acknowledgement"])) return false;
        createEntryAcknowledgement(value["acknowledgement"]);
        return true;
      case "ENTRY_SUBMISSION_REJECTED":
        if (!hasExactKeys(value, ["kind", "rejection"])) return false;
        if (!isEntryRejectionInput(value["rejection"])) return false;
        createEntryRejection(value["rejection"]);
        return true;
      case "ENTRY_FILL_APPLIED":
        if (!hasExactKeys(value, ["kind", "fill"])) return false;
        if (!isFillInput(value["fill"])) return false;
        createFillEvent(value["fill"]);
        return true;
      case "PROTECTION_REQUESTED":
      case "ENTRY_CANCELLATION_REQUESTED":
        return hasExactKeys(value, ["kind"]);
      case "PROTECTION_ACKNOWLEDGED":
        if (!hasExactKeys(value, ["kind", "acknowledgement"])) return false;
        if (!isProtectionAcknowledgementInput(value["acknowledgement"])) return false;
        createProtectionAcknowledgement(value["acknowledgement"]);
        return true;
      case "PROTECTION_REJECTED":
        if (!hasExactKeys(value, ["kind", "rejection"])) return false;
        if (!isProtectionRejectionInput(value["rejection"])) return false;
        createProtectionRejection(value["rejection"]);
        return true;
      case "ENTRY_CANCELLATION_ACKNOWLEDGED":
        if (!hasExactKeys(value, ["kind", "acknowledgement"])) return false;
        if (!isCancellationAcknowledgementInput(value["acknowledgement"])) return false;
        createCancellationAcknowledgement(value["acknowledgement"]);
        return true;
      case "ENTRY_CANCELLATION_REJECTED":
        if (!hasExactKeys(value, ["kind", "rejection"])) return false;
        if (!isCancellationRejectionInput(value["rejection"])) return false;
        createCancellationRejection(value["rejection"]);
        return true;
      case "EXIT_FILL_APPLIED":
        if (!hasExactKeys(value, ["kind", "fill"])) return false;
        if (!isExitFillInput(value["fill"])) return false;
        createExitFillEvent(value["fill"]);
        return true;
      default:
        return false;
    }
  } catch {
    return false;
  }
}

function transitionAttemptId(transition: ExecutionAttemptRecoveryTransition): string | undefined {
  switch (transition.kind) {
    case "ENTRY_SUBMISSION_ACKNOWLEDGED":
    case "PROTECTION_ACKNOWLEDGED":
    case "ENTRY_CANCELLATION_ACKNOWLEDGED":
      return transition.acknowledgement.executionAttemptId;
    case "ENTRY_SUBMISSION_REJECTED":
    case "PROTECTION_REJECTED":
    case "ENTRY_CANCELLATION_REJECTED":
      return transition.rejection.executionAttemptId;
    case "ENTRY_FILL_APPLIED":
    case "EXIT_FILL_APPLIED":
      return transition.fill.executionAttemptId;
    case "ENTRY_SUBMISSION_REQUESTED":
    case "PROTECTION_REQUESTED":
    case "ENTRY_CANCELLATION_REQUESTED":
      return undefined;
  }
}

function invalidEvidence(
  reason: "INVALID_RECOVERY_EVIDENCE" | "UNSUPPORTED_RECOVERY_SCHEMA" | "RECOVERY_IDENTITY_INCOHERENT",
): InvalidRecoveryEnvelope {
  return Object.freeze({ status: "EXECUTION_ATTEMPT_RECOVERY_EVIDENCE_INVALID", reason });
}

type InitializedRecoveryEnvelope = Readonly<{
  readonly status: "EXECUTION_ATTEMPT_RECOVERY_EVIDENCE_VALID";
  readonly evidence: ExecutionAttemptRecoveryEvidenceV1;
  readonly executionPlan: ReadyExecutionPlan;
  readonly initialAttempt: ExecutionAttempt;
}>;

type InvalidRecoveryEnvelope = Extract<ExecutionAttemptRecoveryEvidenceValidationResult, {
  readonly status: "EXECUTION_ATTEMPT_RECOVERY_EVIDENCE_INVALID";
}>;

function isRecoveryEvidenceShape(value: unknown): value is ExecutionAttemptRecoveryEvidenceV1 {
  if (!isRecord(value) || !isRecord(value["identity"]) || !isRecord(value["initialization"])
      || !isDenseArray(value["transitions"])) return false;
  const identity = value["identity"];
  const initialization = value["initialization"];
  if (!hasExactKeys(value, ["schemaVersion", "identity", "initialization", "transitions"])
      || value["schemaVersion"] !== EXECUTION_ATTEMPT_RECOVERY_EVIDENCE_SCHEMA_VERSION
      || !hasExactKeys(identity, [
        "executionAttemptId", "executionPlanId", "tradeIntentId", "candidateId", "instrumentId",
      ])
      || !hasExactKeys(initialization, ["executionPlanRecoveryData"])
      || !isCanonicalId(identity["executionAttemptId"]) || !isCanonicalId(identity["executionPlanId"])
      || !isCanonicalId(identity["tradeIntentId"]) || !isCanonicalId(identity["candidateId"])
      || typeof identity["instrumentId"] !== "string"
      || !value["transitions"].every(canonicalTransition)) return false;
  try {
    instrumentId(identity["instrumentId"]);
  } catch {
    return false;
  }
  return true;
}

function validateAndInitializeExecutionRecovery(
  evidence: unknown,
): InvalidRecoveryEnvelope | InitializedRecoveryEnvelope {
  if (!isRecord(evidence)) return invalidEvidence("INVALID_RECOVERY_EVIDENCE");
  if (evidence["schemaVersion"] !== EXECUTION_ATTEMPT_RECOVERY_EVIDENCE_SCHEMA_VERSION) {
    return typeof evidence["schemaVersion"] === "string"
      ? invalidEvidence("UNSUPPORTED_RECOVERY_SCHEMA")
      : invalidEvidence("INVALID_RECOVERY_EVIDENCE");
  }
  if (!isPlainJsonData(evidence) || !isRecoveryEvidenceShape(evidence)) {
    return invalidEvidence("INVALID_RECOVERY_EVIDENCE");
  }
  const planRestoration = restoreReadyExecutionPlan(evidence.initialization.executionPlanRecoveryData);
  if (planRestoration.status !== "READY_EXECUTION_PLAN_RESTORED") {
    return invalidEvidence("INVALID_RECOVERY_EVIDENCE");
  }
  const plan = planRestoration.executionPlan;
  const initialAttempt = createExecutionAttempt(plan);
  if (initialAttempt.status !== "EXECUTION_ATTEMPT_READY") {
    return invalidEvidence("INVALID_RECOVERY_EVIDENCE");
  }
  if (initialAttempt.executionAttemptId !== evidence.identity.executionAttemptId
      || plan.executionPlanId !== evidence.identity.executionPlanId
      || plan.tradeIntentId !== evidence.identity.tradeIntentId
      || plan.candidateId !== evidence.identity.candidateId
      || plan.instrumentId !== evidence.identity.instrumentId
      || evidence.transitions.some((transition) => {
        const attemptId = transitionAttemptId(transition);
        return attemptId !== undefined && attemptId !== evidence.identity.executionAttemptId;
      })) {
    return invalidEvidence("RECOVERY_IDENTITY_INCOHERENT");
  }
  return Object.freeze({
    status: "EXECUTION_ATTEMPT_RECOVERY_EVIDENCE_VALID",
    evidence,
    executionPlan: plan,
    initialAttempt,
  });
}

export function validateExecutionAttemptRecoveryEvidence(
  evidence: unknown,
): ExecutionAttemptRecoveryEvidenceValidationResult {
  const validation = validateAndInitializeExecutionRecovery(evidence);
  if (validation.status === "EXECUTION_ATTEMPT_RECOVERY_EVIDENCE_INVALID") return validation;
  return Object.freeze({
    status: "EXECUTION_ATTEMPT_RECOVERY_EVIDENCE_VALID",
    evidence: validation.evidence,
  });
}

function restorationRejected(
  reason: "INVALID_RECOVERY_EVIDENCE" | "UNSUPPORTED_RECOVERY_SCHEMA" |
    "RECOVERY_IDENTITY_INCOHERENT" | "EXECUTION_TRANSITION_REJECTED",
  transitionIndex?: number,
  transitionKind?: ExecutionAttemptRecoveryTransition["kind"],
  authorityReason?: string,
): ExecutionAttemptRestorationResult {
  return Object.freeze({
    status: "EXECUTION_ATTEMPT_RESTORATION_REJECTED",
    reason,
    ...(transitionIndex === undefined ? {} : { transitionIndex }),
    ...(transitionKind === undefined ? {} : { transitionKind }),
    ...(authorityReason === undefined ? {} : { authorityReason }),
  });
}

function rejectedTransition(
  index: number,
  transition: ExecutionAttemptRecoveryTransition,
  status: string,
  authorityReason?: string,
): ExecutionAttemptRestorationResult {
  return restorationRejected(
    "EXECUTION_TRANSITION_REJECTED",
    index,
    transition.kind,
    authorityReason ?? status,
  );
}

export function restoreExecutionAttemptFromEvidence(evidence: unknown): ExecutionAttemptRestorationResult {
  const validation = validateAndInitializeExecutionRecovery(evidence);
  if (validation.status === "EXECUTION_ATTEMPT_RECOVERY_EVIDENCE_INVALID") {
    return restorationRejected(validation.reason);
  }
  let attempt = validation.initialAttempt;

  for (const [index, transition] of validation.evidence.transitions.entries()) {
    switch (transition.kind) {
      case "ENTRY_SUBMISSION_REQUESTED": {
        const result = requestEntrySubmission(attempt, transition.adapterCapabilities);
        if (result.status !== "ENTRY_SUBMISSION_READY") {
          return rejectedTransition(index, transition, result.status, "reason" in result ? result.reason : undefined);
        }
        attempt = result.attempt;
        break;
      }
      case "PROTECTION_REQUESTED": {
        const result = requestProtection(attempt);
        if (result.status !== "PROTECTION_REQUEST_READY") {
          return rejectedTransition(index, transition, result.status, "reason" in result ? result.reason : undefined);
        }
        attempt = result.attempt;
        break;
      }
      case "ENTRY_CANCELLATION_REQUESTED": {
        const result = requestEntryCancellation(attempt);
        if (result.status !== "CANCELLATION_REQUEST_READY") {
          return rejectedTransition(index, transition, result.status, "reason" in result ? result.reason : undefined);
        }
        attempt = result.attempt;
        break;
      }
      default: {
        const result = transition.kind === "ENTRY_SUBMISSION_ACKNOWLEDGED"
          ? acknowledgeEntrySubmission(attempt, transition.acknowledgement)
          : transition.kind === "ENTRY_SUBMISSION_REJECTED"
            ? rejectEntrySubmission(attempt, transition.rejection)
            : transition.kind === "ENTRY_FILL_APPLIED"
              ? applyEntryFill(attempt, transition.fill)
              : transition.kind === "PROTECTION_ACKNOWLEDGED"
                ? acknowledgeProtection(attempt, transition.acknowledgement)
                : transition.kind === "PROTECTION_REJECTED"
                  ? rejectProtection(attempt, transition.rejection)
                  : transition.kind === "ENTRY_CANCELLATION_ACKNOWLEDGED"
                    ? acknowledgeCancellation(attempt, transition.acknowledgement)
                    : transition.kind === "ENTRY_CANCELLATION_REJECTED"
                      ? rejectCancellation(attempt, transition.rejection)
                      : applyExitFill(attempt, transition.fill);
        if (result.status !== "EXECUTION_ATTEMPT_UPDATED" && result.status !== "DUPLICATE_EVENT_IGNORED") {
          return rejectedTransition(
            index,
            transition,
            result.status,
            "reason" in result ? result.reason : undefined,
          );
        }
        attempt = result.attempt;
      }
    }
  }
  return Object.freeze({
    status: "EXECUTION_ATTEMPT_RESTORED",
    executionPlan: validation.executionPlan,
    executionAttempt: attempt,
  });
}
