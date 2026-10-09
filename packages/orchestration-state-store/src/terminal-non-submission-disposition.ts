import { BROKER_FAILURE_CATEGORIES, classifyRetryDisposition,
  type BrokerFailureCategory } from "@ulte/broker-adapters";
import { instrumentId, unixMs, type InstrumentId, type UnixMs } from "@ulte/instrument-model";
import { createOrchestrationPendingEffectIdentity,
  type OrchestrationPendingEffectIdentity } from "./pending-effects.js";
import { executionAuthorityCheckpointId, latestROutcomeId, orchestrationFenceToken,
  orchestrationLeaseOwnerId, orchestrationRevision, orchestrationSessionId, riskBasisCheckpointId,
  type ExecutionAuthorityCheckpointId, type ExecutionAuthorityIdentity, type LatestROutcomeId,
  type OrchestrationFenceToken, type OrchestrationLeaseOwnerId, type OrchestrationRecoveryMode,
  type OrchestrationRevision, type OrchestrationSessionId, type RiskBasisCheckpointId,
} from "./recovery-store.js";

export const TERMINAL_NON_SUBMISSION_PROOF_V1 = "TERMINAL_NON_SUBMISSION_PROOF_V1" as const;
export const TERMINAL_NON_SUBMISSION_DISPOSITION_V1 = "TERMINAL_NON_SUBMISSION_DISPOSITION_V1" as const;
export const TERMINAL_NON_SUBMISSION_DISPOSITION_RECEIPT_V1 = "TERMINAL_NON_SUBMISSION_DISPOSITION_RECEIPT_V1" as const;

declare const dispositionRefBrand: unique symbol;
export type TerminalNonSubmissionDispositionRef = string & {
  readonly [dispositionRefBrand]: "TerminalNonSubmissionDispositionRef"
};
export type TerminalNonSubmissionSessionDisposition = "TERMINAL_NON_SUBMISSION";

function exact(value: unknown, keys: readonly string[], optional: readonly string[] = []): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)
      || Object.getPrototypeOf(value) !== Object.prototype) return false;
  const actual = Reflect.ownKeys(value);
  return actual.every((key) => typeof key === "string" && [...keys, ...optional].includes(key)
    && Object.getOwnPropertyDescriptor(value, key)?.enumerable === true
    && "value" in (Object.getOwnPropertyDescriptor(value, key) ?? {}))
    && keys.every((key) => actual.includes(key));
}
function id(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) {
    throw new TypeError(`Invalid ${field}`);
  }
  return value;
}
export function terminalNonSubmissionDispositionRef(value: unknown): TerminalNonSubmissionDispositionRef {
  return id(value, "dispositionRef") as TerminalNonSubmissionDispositionRef;
}
function pendingIdentity(value: unknown): Readonly<OrchestrationPendingEffectIdentity> {
  if (!exact(value, ["adapterId", "environment", "operation", "executionAttemptId",
    "idempotencyKey", "requestFingerprint"])) throw new TypeError("Invalid pending identity data");
  return createOrchestrationPendingEffectIdentity(value);
}

/** Normalized definite non-submission evidence; this grants no retry or execution authority. */
export interface TerminalNonSubmissionProofV1 {
  readonly schemaVersion: typeof TERMINAL_NON_SUBMISSION_PROOF_V1;
  readonly sourceKind: "TRUSTED_ADAPTER_FAILURE" | "REVIEWED_LEGACY_ATTESTATION";
  readonly sourceEventRef: string;
  readonly observedAt: UnixMs;
  readonly category: BrokerFailureCategory;
  readonly certainty: "DEFINITE_FAILURE";
  readonly submissionExposure: "NOT_SUBMITTED";
  readonly retryDisposition: "DO_NOT_RETRY";
  readonly pendingEffectIdentity: Readonly<OrchestrationPendingEffectIdentity>;
  readonly adapterReasonCode?: string;
}

export function createTerminalNonSubmissionProofV1(value: unknown): TerminalNonSubmissionProofV1 {
  if (!exact(value, ["schemaVersion", "sourceKind", "sourceEventRef", "observedAt", "category",
    "certainty", "submissionExposure", "retryDisposition", "pendingEffectIdentity"], ["adapterReasonCode"])
      || value["schemaVersion"] !== TERMINAL_NON_SUBMISSION_PROOF_V1
      || (value["sourceKind"] !== "TRUSTED_ADAPTER_FAILURE"
        && value["sourceKind"] !== "REVIEWED_LEGACY_ATTESTATION")
      || value["certainty"] !== "DEFINITE_FAILURE"
      || value["submissionExposure"] !== "NOT_SUBMITTED"
      || value["retryDisposition"] !== "DO_NOT_RETRY"
      || !BROKER_FAILURE_CATEGORIES.some((category) => category === value["category"])) {
    throw new TypeError("Invalid terminal non-submission proof");
  }
  const category = value["category"] as BrokerFailureCategory;
  if (classifyRetryDisposition({ category, certainty: "DEFINITE_FAILURE",
    submissionExposure: "NOT_SUBMITTED" }) !== "DO_NOT_RETRY") {
    throw new TypeError("Retry-safe evidence cannot prove terminal non-submission");
  }
  return Object.freeze({
    schemaVersion: TERMINAL_NON_SUBMISSION_PROOF_V1,
    sourceKind: value["sourceKind"],
    sourceEventRef: id(value["sourceEventRef"], "sourceEventRef"),
    observedAt: unixMs(value["observedAt"]), category,
    certainty: "DEFINITE_FAILURE", submissionExposure: "NOT_SUBMITTED", retryDisposition: "DO_NOT_RETRY",
    pendingEffectIdentity: pendingIdentity(value["pendingEffectIdentity"]),
    ...("adapterReasonCode" in value
      ? { adapterReasonCode: id(value["adapterReasonCode"], "adapterReasonCode") } : {}),
  });
}

export interface TerminalNonSubmissionPendingCreationRef {
  readonly kind: "PENDING_INTENT_COMMIT" | "ADOPTION_NEXT_PENDING";
  readonly committedCheckpointRef: ExecutionAuthorityCheckpointId;
  readonly committedRevision: OrchestrationRevision;
}
export interface TerminalNonSubmissionResolutionV1 {
  readonly kind: TerminalNonSubmissionSessionDisposition;
  readonly resolvedRevision: OrchestrationRevision;
  readonly resolvedFence: OrchestrationFenceToken;
}

/** A future atomic commit stops this session while retaining the exact execution checkpoint.
 * No canonical broker acknowledgement/rejection exists. No new attempt or lifecycle transition is
 * represented. Constructors validate contract coherence; trusted evidence loading belongs to D2-D4.
 */
export interface TerminalNonSubmissionDispositionV1 {
  readonly schemaVersion: typeof TERMINAL_NON_SUBMISSION_DISPOSITION_V1;
  readonly dispositionRef: TerminalNonSubmissionDispositionRef;
  readonly sessionId: OrchestrationSessionId;
  readonly executionAttemptId: string;
  readonly pendingEffectIdentity: Readonly<OrchestrationPendingEffectIdentity>;
  readonly pendingCreatedRevision: OrchestrationRevision;
  readonly pendingCreatedFence: OrchestrationFenceToken;
  readonly pendingCreationRef: TerminalNonSubmissionPendingCreationRef;
  readonly expectedRecoveryRevision: OrchestrationRevision;
  readonly committedRevision: OrchestrationRevision;
  readonly committedFence: OrchestrationFenceToken;
  /** Historical commit facts only; they cannot authorize a current lease. */
  readonly committingOwnerId: OrchestrationLeaseOwnerId;
  readonly executionAuthorityCheckpointRefBefore: ExecutionAuthorityCheckpointId;
  readonly executionAuthorityCheckpointRefAfter: ExecutionAuthorityCheckpointId;
  readonly executionAuthorityIdentity: Readonly<ExecutionAuthorityIdentity>;
  readonly mode: OrchestrationRecoveryMode;
  readonly instrumentId: InstrumentId;
  readonly riskBasisCheckpointRef: RiskBasisCheckpointId | null;
  readonly latestROutcomeRef: LatestROutcomeId | null;
  readonly proof: TerminalNonSubmissionProofV1;
  readonly sessionDisposition: TerminalNonSubmissionSessionDisposition;
  readonly resolution: TerminalNonSubmissionResolutionV1;
}

const identityFields = ["adapterId", "environment", "operation", "executionAttemptId",
  "idempotencyKey", "requestFingerprint"] as const;
function samePending(a: OrchestrationPendingEffectIdentity, b: OrchestrationPendingEffectIdentity): boolean {
  return identityFields.every((field) => a[field] === b[field]);
}
function authorityIdentity(value: unknown, instrument: InstrumentId, attempt: string): Readonly<ExecutionAuthorityIdentity> {
  if (!exact(value, ["executionAttemptId", "executionPlanId", "tradeIntentId", "candidateId", "instrumentId"])) {
    throw new TypeError("Invalid execution authority identity");
  }
  const result = Object.freeze({ executionAttemptId: id(value["executionAttemptId"], "executionAttemptId"),
    executionPlanId: id(value["executionPlanId"], "executionPlanId"),
    tradeIntentId: id(value["tradeIntentId"], "tradeIntentId"),
    candidateId: id(value["candidateId"], "candidateId"),
    instrumentId: instrumentId(value["instrumentId"]) });
  if (result.executionAttemptId !== attempt || result.instrumentId !== instrument) {
    throw new TypeError("Execution authority identity mismatch");
  }
  return result;
}

const dispositionKeys = ["schemaVersion", "dispositionRef", "sessionId", "executionAttemptId",
  "pendingEffectIdentity", "pendingCreatedRevision", "pendingCreatedFence", "pendingCreationRef",
  "expectedRecoveryRevision", "committedRevision", "committedFence", "committingOwnerId",
  "executionAuthorityCheckpointRefBefore", "executionAuthorityCheckpointRefAfter",
  "executionAuthorityIdentity", "mode", "instrumentId", "riskBasisCheckpointRef",
  "latestROutcomeRef", "proof", "sessionDisposition", "resolution"] as const;

export function createTerminalNonSubmissionDispositionV1(value: unknown): TerminalNonSubmissionDispositionV1 {
  if (!exact(value, dispositionKeys) || value["schemaVersion"] !== TERMINAL_NON_SUBMISSION_DISPOSITION_V1
      || value["sessionDisposition"] !== "TERMINAL_NON_SUBMISSION") {
    throw new TypeError("Invalid terminal non-submission disposition");
  }
  const pendingEffectIdentity = pendingIdentity(value["pendingEffectIdentity"]);
  const proof = createTerminalNonSubmissionProofV1(value["proof"]);
  const attempt = id(value["executionAttemptId"], "executionAttemptId");
  const mode = value["mode"];
  if ((mode !== "DRY_RUN" && mode !== "SANDBOX") || pendingEffectIdentity.environment !== mode
      || pendingEffectIdentity.executionAttemptId !== attempt
      || !samePending(proof.pendingEffectIdentity, pendingEffectIdentity)) {
    throw new TypeError("Pending identity mismatch");
  }
  const pendingCreatedRevision = orchestrationRevision(value["pendingCreatedRevision"]);
  const pendingCreatedFence = orchestrationFenceToken(value["pendingCreatedFence"]);
  const expectedRecoveryRevision = orchestrationRevision(value["expectedRecoveryRevision"]);
  const committedRevision = orchestrationRevision(value["committedRevision"]);
  const committedFence = orchestrationFenceToken(value["committedFence"]);
  if (expectedRecoveryRevision === Number.MAX_SAFE_INTEGER
      || committedRevision !== expectedRecoveryRevision + 1
      || pendingCreatedRevision > expectedRecoveryRevision || pendingCreatedFence > committedFence) {
    throw new TypeError("Invalid terminal disposition revision or fence");
  }
  const before = executionAuthorityCheckpointId(value["executionAuthorityCheckpointRefBefore"]);
  const after = executionAuthorityCheckpointId(value["executionAuthorityCheckpointRefAfter"]);
  if (before !== after) throw new TypeError("Execution checkpoint must remain unchanged");
  const creation = value["pendingCreationRef"];
  if (!exact(creation, ["kind", "committedCheckpointRef", "committedRevision"])
      || (creation["kind"] !== "PENDING_INTENT_COMMIT" && creation["kind"] !== "ADOPTION_NEXT_PENDING")
      || orchestrationRevision(creation["committedRevision"]) !== pendingCreatedRevision) {
    throw new TypeError("Pending creation facts mismatch");
  }
  const pendingCreationRef = Object.freeze({ kind: creation["kind"],
    committedCheckpointRef: executionAuthorityCheckpointId(creation["committedCheckpointRef"]),
    committedRevision: pendingCreatedRevision });
  const resolution = value["resolution"];
  if (!exact(resolution, ["kind", "resolvedRevision", "resolvedFence"])
      || resolution["kind"] !== "TERMINAL_NON_SUBMISSION"
      || orchestrationRevision(resolution["resolvedRevision"]) !== committedRevision
      || orchestrationFenceToken(resolution["resolvedFence"]) !== committedFence) {
    throw new TypeError("Invalid terminal pending resolution");
  }
  const instrument = instrumentId(value["instrumentId"]);
  if (value["latestROutcomeRef"] !== null && value["riskBasisCheckpointRef"] === null) {
    throw new TypeError("Latest R outcome requires preserved risk context");
  }
  return Object.freeze({ schemaVersion: TERMINAL_NON_SUBMISSION_DISPOSITION_V1,
    dispositionRef: terminalNonSubmissionDispositionRef(value["dispositionRef"]),
    sessionId: orchestrationSessionId(value["sessionId"]), executionAttemptId: attempt,
    pendingEffectIdentity, pendingCreatedRevision, pendingCreatedFence, pendingCreationRef,
    expectedRecoveryRevision, committedRevision, committedFence,
    committingOwnerId: orchestrationLeaseOwnerId(value["committingOwnerId"]),
    executionAuthorityCheckpointRefBefore: before, executionAuthorityCheckpointRefAfter: after,
    executionAuthorityIdentity: authorityIdentity(value["executionAuthorityIdentity"], instrument, attempt),
    mode, instrumentId: instrument,
    riskBasisCheckpointRef: value["riskBasisCheckpointRef"] === null ? null : riskBasisCheckpointId(value["riskBasisCheckpointRef"]),
    latestROutcomeRef: value["latestROutcomeRef"] === null ? null : latestROutcomeId(value["latestROutcomeRef"]),
    proof, sessionDisposition: "TERMINAL_NON_SUBMISSION",
    resolution: Object.freeze({ kind: "TERMINAL_NON_SUBMISSION", resolvedRevision: committedRevision,
      resolvedFence: committedFence }),
  });
}

/** Historical commit owner/fence and resolution fence are receipt facts, not logical retry inputs.
 * A future fresh commit must independently check its current lease/fence. No timestamp is generated
 * or requested by this V1 contract: observedAt is solely the caller's evidence observation time.
 */
export type TerminalNonSubmissionDispositionLogicalPayload = Readonly<Omit<TerminalNonSubmissionDispositionV1,
  "schemaVersion" | "committedFence" | "committingOwnerId" | "resolution"> & {
    readonly resolution: Readonly<Pick<TerminalNonSubmissionResolutionV1, "kind" | "resolvedRevision">>;
  }>;

/** The receipt retains the full historical logical commit, including its owner and fence. */
export interface TerminalNonSubmissionDispositionReceiptV1 {
  readonly schemaVersion: typeof TERMINAL_NON_SUBMISSION_DISPOSITION_RECEIPT_V1;
  readonly disposition: TerminalNonSubmissionDispositionV1;
}
export function createTerminalNonSubmissionDispositionReceiptV1(value: unknown): TerminalNonSubmissionDispositionReceiptV1 {
  if (!exact(value, ["schemaVersion", "disposition"])
      || value["schemaVersion"] !== TERMINAL_NON_SUBMISSION_DISPOSITION_RECEIPT_V1) {
    throw new TypeError("Invalid terminal disposition receipt");
  }
  return Object.freeze({ schemaVersion: TERMINAL_NON_SUBMISSION_DISPOSITION_RECEIPT_V1,
    disposition: createTerminalNonSubmissionDispositionV1(value["disposition"]) });
}

/** Exact historical replay comparison only; equality does not validate today's lease or authorize execution. */
export function equivalentTerminalNonSubmissionDispositionRetry(
  receipt: TerminalNonSubmissionDispositionReceiptV1, requested: TerminalNonSubmissionDispositionLogicalPayload,
): boolean {
  const a = receipt.disposition;
  const b = requested;
  return a.dispositionRef === b.dispositionRef
    && a.sessionId === b.sessionId && a.executionAttemptId === b.executionAttemptId
    && samePending(a.pendingEffectIdentity, b.pendingEffectIdentity)
    && a.pendingCreatedRevision === b.pendingCreatedRevision && a.pendingCreatedFence === b.pendingCreatedFence
    && a.pendingCreationRef.kind === b.pendingCreationRef.kind
    && a.pendingCreationRef.committedCheckpointRef === b.pendingCreationRef.committedCheckpointRef
    && a.pendingCreationRef.committedRevision === b.pendingCreationRef.committedRevision
    && a.expectedRecoveryRevision === b.expectedRecoveryRevision && a.committedRevision === b.committedRevision
    && a.executionAuthorityCheckpointRefBefore === b.executionAuthorityCheckpointRefBefore
    && a.executionAuthorityCheckpointRefAfter === b.executionAuthorityCheckpointRefAfter
    && a.executionAuthorityIdentity.executionAttemptId === b.executionAuthorityIdentity.executionAttemptId
    && a.executionAuthorityIdentity.executionPlanId === b.executionAuthorityIdentity.executionPlanId
    && a.executionAuthorityIdentity.tradeIntentId === b.executionAuthorityIdentity.tradeIntentId
    && a.executionAuthorityIdentity.candidateId === b.executionAuthorityIdentity.candidateId
    && a.executionAuthorityIdentity.instrumentId === b.executionAuthorityIdentity.instrumentId
    && a.mode === b.mode && a.instrumentId === b.instrumentId
    && a.riskBasisCheckpointRef === b.riskBasisCheckpointRef && a.latestROutcomeRef === b.latestROutcomeRef
    && a.proof.schemaVersion === b.proof.schemaVersion && a.proof.sourceKind === b.proof.sourceKind
    && a.proof.sourceEventRef === b.proof.sourceEventRef && a.proof.observedAt === b.proof.observedAt
    && a.proof.category === b.proof.category && a.proof.certainty === b.proof.certainty
    && a.proof.submissionExposure === b.proof.submissionExposure
    && a.proof.retryDisposition === b.proof.retryDisposition
    && samePending(a.proof.pendingEffectIdentity, b.proof.pendingEffectIdentity)
    && a.proof.adapterReasonCode === b.proof.adapterReasonCode
    && a.sessionDisposition === b.sessionDisposition && a.resolution.kind === b.resolution.kind
    && a.resolution.resolvedRevision === b.resolution.resolvedRevision;
}
