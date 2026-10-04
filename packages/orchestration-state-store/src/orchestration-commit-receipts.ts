import {
  fingerprintEntryCancellation, fingerprintEntrySubmission, fingerprintProtectionRequest,
  type IdempotencyOperation,
} from "@ulte/broker-adapters";
import {
  requestEntryCancellation, requestEntrySubmission, requestProtection,
  restoreExecutionAttemptFromEvidence,
  type ExecutionAttempt, type ExecutionAttemptRecoveryTransition,
} from "@ulte/execution-engine";
import { createExecutionAuthorityCheckpoint, type ExecutionAuthorityCheckpoint } from "./execution-authority-checkpoint.js";
import {
  createOrchestrationExternalOutcome, createOrchestrationPendingEffect,
  createOrchestrationPendingEffectIdentity, orchestrationOutcomeKey,
  type OrchestrationExternalOutcome, type OrchestrationOutcomeKey,
  type OrchestrationPendingEffect, type OrchestrationPendingEffectIdentity,
} from "./pending-effects.js";
import {
  createOrchestrationRecoveryRecord,
  orchestrationFenceToken, orchestrationLeaseOwnerId, orchestrationRevision,
  orchestrationSessionId, ORCHESTRATION_RECOVERY_RECORD_SCHEMA_VERSION,
  type ExecutionAuthorityCheckpointId, type OrchestrationFenceToken,
  type OrchestrationLeaseOwnerId, type OrchestrationRecoveryRecord, type OrchestrationRecoveryState,
  type OrchestrationRevision, type OrchestrationSessionId,
} from "./recovery-store.js";

export const ORCHESTRATION_CHECKPOINT_ADVANCE_PROOF_V1 = "ORCHESTRATION_CHECKPOINT_ADVANCE_PROOF_V1" as const;
export const ORCHESTRATION_PENDING_INTENT_COMMIT_RECEIPT_V1 = "ORCHESTRATION_PENDING_INTENT_COMMIT_RECEIPT_V1" as const;
export const ORCHESTRATION_EXTERNAL_OUTCOME_ADOPTION_RECEIPT_V1 = "ORCHESTRATION_EXTERNAL_OUTCOME_ADOPTION_RECEIPT_V1" as const;

type Transition = ExecutionAttemptRecoveryTransition;
type Requested = Extract<Transition, { readonly kind: "ENTRY_SUBMISSION_REQUESTED" | "PROTECTION_REQUESTED" | "ENTRY_CANCELLATION_REQUESTED" }>;

function plain(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}
function exact(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!plain(value)) return false;
  const actual = Reflect.ownKeys(value);
  return actual.length === keys.length && actual.every((key) => typeof key === "string"
    && keys.includes(key) && Object.getOwnPropertyDescriptor(value, key)?.enumerable === true
    && "value" in (Object.getOwnPropertyDescriptor(value, key) ?? {}));
}
function copy(value: unknown, ancestors: ReadonlySet<object> = new Set()): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "object" || ancestors.has(value)) throw new TypeError("Invalid receipt JSON data");
  const next = new Set(ancestors); next.add(value);
  if (Array.isArray(value)) {
    if (Reflect.ownKeys(value).length !== value.length + 1) throw new TypeError("Invalid receipt array");
    const result: unknown[] = [];
    for (let i = 0; i < value.length; i += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, i);
      if (!descriptor || !("value" in descriptor)) throw new TypeError("Invalid receipt array element");
      result.push(copy(descriptor.value, next));
    }
    return Object.freeze(result);
  }
  if (!plain(value)) throw new TypeError("Invalid receipt object");
  const result: Record<string, unknown> = {};
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") throw new TypeError("Invalid receipt key");
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) throw new TypeError("Invalid receipt property");
    Object.defineProperty(result, key, { value: copy(descriptor.value, next), enumerable: true,
      configurable: true, writable: true });
  }
  return Object.freeze(result);
}
/** Deep structural equality, independent of object key order and reference identity. */
export function equalCanonicalJson(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || a === null || typeof b !== "object" || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) return Array.isArray(a) && Array.isArray(b)
    && a.length === b.length && a.every((item, index) => equalCanonicalJson(item, b[index]));
  const left = Reflect.ownKeys(a), right = Reflect.ownKeys(b);
  return left.length === right.length && left.every((key) => right.includes(key)
    && equalCanonicalJson((a as Record<PropertyKey, unknown>)[key], (b as Record<PropertyKey, unknown>)[key]));
}
const equal = equalCanonicalJson;
function checkpoint(value: unknown): ExecutionAuthorityCheckpoint {
  return createExecutionAuthorityCheckpoint(value);
}
function restored(value: ExecutionAuthorityCheckpoint): ExecutionAttempt {
  const result = restoreExecutionAttemptFromEvidence(value.evidence);
  if (result.status !== "EXECUTION_ATTEMPT_RESTORED") throw new TypeError("Checkpoint cannot restore");
  return result.executionAttempt;
}

export interface CheckpointAdvanceProof {
  readonly schemaVersion: typeof ORCHESTRATION_CHECKPOINT_ADVANCE_PROOF_V1;
  readonly previousCheckpointRef: ExecutionAuthorityCheckpointId;
  readonly committedCheckpointRef: ExecutionAuthorityCheckpointId;
  readonly executionAttemptId: string;
  readonly transitionKinds: readonly Transition["kind"][];
}

/** Both checkpoints must restore, and the only change in evidence is the exact authorized suffix. */
export function proveExecutionCheckpointAdvance(input: {
  readonly previousCheckpoint: ExecutionAuthorityCheckpoint;
  readonly committedCheckpoint: ExecutionAuthorityCheckpoint;
  readonly allowedSuffix: readonly Transition[];
}): CheckpointAdvanceProof {
  const previous = checkpoint(input.previousCheckpoint), committed = checkpoint(input.committedCheckpoint);
  if (!Array.isArray(input.allowedSuffix) || input.allowedSuffix.length === 0
      || previous.checkpointRef === committed.checkpointRef) throw new TypeError("Invalid checkpoint advance");
  const before = previous.evidence, after = committed.evidence;
  if (before.schemaVersion !== after.schemaVersion || !equal(before.identity, after.identity)
      || !equal(before.initialization, after.initialization)
      || after.transitions.length !== before.transitions.length + input.allowedSuffix.length
      || !before.transitions.every((transition, index) => equal(transition, after.transitions[index]))
      || !input.allowedSuffix.every((transition, index) => equal(transition, after.transitions[before.transitions.length + index]))) {
    throw new TypeError("Checkpoint history is not an authorized append");
  }
  restored(previous); restored(committed);
  return Object.freeze({
    schemaVersion: ORCHESTRATION_CHECKPOINT_ADVANCE_PROOF_V1,
    previousCheckpointRef: previous.checkpointRef,
    committedCheckpointRef: committed.checkpointRef,
    executionAttemptId: before.identity.executionAttemptId,
    transitionKinds: Object.freeze(input.allowedSuffix.map((transition) => transition.kind)),
  });
}

function requestedKind(operation: IdempotencyOperation): Requested["kind"] {
  switch (operation) {
    case "ENTRY_SUBMISSION": return "ENTRY_SUBMISSION_REQUESTED";
    case "PROTECTION_SUBMISSION": return "PROTECTION_REQUESTED";
    case "ENTRY_CANCELLATION": return "ENTRY_CANCELLATION_REQUESTED";
  }
}
function proveRequest(previous: ExecutionAttempt, transition: Requested, pendingValue: unknown): ExecutionAttempt {
  const pending = createOrchestrationPendingEffect(copy(pendingValue));
  if (pending.state !== "PENDING" || transition.kind !== requestedKind(pending.operation)
      || pending.executionAttemptId !== previous.executionAttemptId) throw new TypeError("Pending request identity mismatch");
  const result = transition.kind === "ENTRY_SUBMISSION_REQUESTED"
    ? requestEntrySubmission(previous, transition.adapterCapabilities)
    : transition.kind === "PROTECTION_REQUESTED" ? requestProtection(previous) : requestEntryCancellation(previous);
  const ready = transition.kind === "ENTRY_SUBMISSION_REQUESTED" ? "ENTRY_SUBMISSION_READY"
    : transition.kind === "PROTECTION_REQUESTED" ? "PROTECTION_REQUEST_READY" : "CANCELLATION_REQUEST_READY";
  if (result.status !== ready || !("request" in result) || equal(previous, result.attempt)) {
    throw new TypeError("Requested transition cannot create a new request");
  }
  const fingerprint = result.request.kind === "ENTRY" ? fingerprintEntrySubmission(result.request)
    : result.request.kind === "PROTECTION" ? fingerprintProtectionRequest(result.request)
      : fingerprintEntryCancellation(result.request);
  if (result.request.executionAttemptId !== pending.executionAttemptId
      || result.request.idempotencyKey !== pending.idempotencyKey
      || fingerprint !== pending.requestFingerprint) throw new TypeError("Pending request fingerprint mismatch");
  return result.attempt;
}
export function provePendingIntentCheckpointAdvance(input: {
  readonly previousCheckpoint: ExecutionAuthorityCheckpoint;
  readonly committedCheckpoint: ExecutionAuthorityCheckpoint;
  readonly pendingEffect: OrchestrationPendingEffect;
}): CheckpointAdvanceProof {
  const previous = checkpoint(input.previousCheckpoint), committed = checkpoint(input.committedCheckpoint);
  const suffix = committed.evidence.transitions.slice(previous.evidence.transitions.length);
  if (suffix.length !== 1 || !isRequested(suffix[0])) throw new TypeError("Exactly one requested transition required");
  const proof = proveExecutionCheckpointAdvance({ previousCheckpoint: previous, committedCheckpoint: committed, allowedSuffix: suffix });
  const regenerated = proveRequest(restored(previous), suffix[0], input.pendingEffect);
  if (!equal(regenerated, restored(committed))) throw new TypeError("Committed request authority mismatch");
  return proof;
}
function isRequested(value: Transition | undefined): value is Requested {
  return value?.kind === "ENTRY_SUBMISSION_REQUESTED" || value?.kind === "PROTECTION_REQUESTED"
    || value?.kind === "ENTRY_CANCELLATION_REQUESTED";
}
export type OutcomeAdoptionProofResult =
  | Readonly<{ readonly status: "PROVEN"; readonly proof: CheckpointAdvanceProof }>
  | Readonly<{ readonly status: "OUTCOME_NOT_ADOPTABLE" }>;

export function proveOutcomeAdoptionCheckpointAdvance(input: {
  readonly previousCheckpoint: ExecutionAuthorityCheckpoint;
  readonly committedCheckpoint: ExecutionAuthorityCheckpoint;
  readonly outcome: OrchestrationExternalOutcome;
  readonly nextPendingEffect: OrchestrationPendingEffect | null;
}): OutcomeAdoptionProofResult {
  const outcome = createOrchestrationExternalOutcome(copy(input.outcome));
  if (outcome.observation.kind === "BROKER_DISPOSITION") return Object.freeze({ status: "OUTCOME_NOT_ADOPTABLE" });
  const previous = checkpoint(input.previousCheckpoint), committed = checkpoint(input.committedCheckpoint);
  if (outcome.executionAttemptId !== previous.evidence.identity.executionAttemptId) throw new TypeError("Outcome attempt mismatch");
  const transition = outcome.observation.transition;
  const suffix = committed.evidence.transitions.slice(previous.evidence.transitions.length);
  if (suffix.length !== (input.nextPendingEffect === null ? 1 : 2)
      || !equal(suffix[0], transition)
      || (input.nextPendingEffect !== null && !isRequested(suffix[1]))) throw new TypeError("Invalid outcome suffix");
  const proof = proveExecutionCheckpointAdvance({ previousCheckpoint: previous, committedCheckpoint: committed, allowedSuffix: suffix });
  const intermediateEvidence = { ...previous.evidence, transitions: [...previous.evidence.transitions, transition] };
  const intermediate = restoreExecutionAttemptFromEvidence(intermediateEvidence);
  if (intermediate.status !== "EXECUTION_ATTEMPT_RESTORED" || equal(intermediate.executionAttempt, restored(previous))) {
    throw new TypeError("Outcome cannot advance authority");
  }
  if (input.nextPendingEffect === null) {
    if (!equal(intermediate.executionAttempt, restored(committed))) throw new TypeError("Adopted authority mismatch");
  } else {
    const regenerated = proveRequest(intermediate.executionAttempt, suffix[1] as Requested, input.nextPendingEffect);
    if (!equal(regenerated, restored(committed))) throw new TypeError("Next pending authority mismatch");
  }
  return Object.freeze({ status: "PROVEN", proof });
}

/** Outcome adoption consumes canonical execution lifecycle evidence. It creates neither risk-basis
 * nor latest-R authority: both references remain session-stable across this transaction. A dedicated
 * risk/R evidence workflow may update them under its own proof contract; recovery references grant no authority.
 */
export function createOutcomeAdoptionRecoveryState(input: {
  readonly currentRecovery: OrchestrationRecoveryRecord;
  readonly committedCheckpoint: ExecutionAuthorityCheckpoint;
}): OrchestrationRecoveryState {
  if (!exact(input, ["currentRecovery", "committedCheckpoint"])) {
    throw new TypeError("Invalid outcome adoption recovery input");
  }
  const current = createOrchestrationRecoveryRecord(input.currentRecovery);
  const committed = createExecutionAuthorityCheckpoint(input.committedCheckpoint);
  if (committed.evidence.identity.instrumentId !== current.instrumentId) {
    throw new TypeError("Outcome adoption instrument mismatch");
  }
  return Object.freeze({
    mode: current.mode,
    instrumentId: current.instrumentId,
    executionAuthorityCheckpointRef: committed.checkpointRef,
    executionAuthorityIdentity: committed.evidence.identity,
    riskBasisCheckpointRef: current.riskBasisCheckpointRef,
    latestROutcomeRef: current.latestROutcomeRef,
  });
}

function state(value: unknown, sessionId: OrchestrationSessionId, revision: OrchestrationRevision,
  fence: OrchestrationFenceToken, committed: ExecutionAuthorityCheckpoint): OrchestrationRecoveryState {
  if (!exact(value, ["mode", "instrumentId", "executionAuthorityCheckpointRef", "executionAuthorityIdentity",
    "riskBasisCheckpointRef", "latestROutcomeRef"])) throw new TypeError("Invalid recovery state");
  const safe = copy(value) as OrchestrationRecoveryState;
  const record = createOrchestrationRecoveryRecord({ schemaVersion: ORCHESTRATION_RECOVERY_RECORD_SCHEMA_VERSION,
    sessionId, revision, fenceToken: fence, ...safe });
  if (record.executionAuthorityCheckpointRef !== committed.checkpointRef
      || !equal(record.executionAuthorityIdentity, committed.evidence.identity)
      || record.instrumentId !== committed.evidence.identity.instrumentId) throw new TypeError("Recovery checkpoint identity mismatch");
  return Object.freeze({ mode: record.mode, instrumentId: record.instrumentId,
    executionAuthorityCheckpointRef: record.executionAuthorityCheckpointRef,
    executionAuthorityIdentity: record.executionAuthorityIdentity,
    riskBasisCheckpointRef: record.riskBasisCheckpointRef, latestROutcomeRef: record.latestROutcomeRef });
}
function nextRevision(value: unknown): OrchestrationRevision {
  const current = orchestrationRevision(value);
  return orchestrationRevision(current + 1);
}
function proofMatches(value: unknown, expected: CheckpointAdvanceProof): CheckpointAdvanceProof {
  if (!exact(value, ["schemaVersion", "previousCheckpointRef", "committedCheckpointRef",
    "executionAttemptId", "transitionKinds"]) || !equal(value, expected)) throw new TypeError("Advance proof mismatch");
  return expected;
}
function pendingAt(value: unknown, sessionId: OrchestrationSessionId, revision: OrchestrationRevision,
  fence: OrchestrationFenceToken, attemptId: string): OrchestrationPendingEffect {
  const effect = createOrchestrationPendingEffect(value);
  if (effect.state !== "PENDING" || effect.sessionId !== sessionId
      || effect.createdRevision !== revision || effect.createdFence !== fence
      || effect.executionAttemptId !== attemptId) throw new TypeError("Pending creation facts mismatch");
  return effect;
}

export interface PendingIntentLogicalPayload {
  readonly sessionId: OrchestrationSessionId;
  readonly expectedRevision: OrchestrationRevision;
  readonly previousCheckpointRef: ExecutionAuthorityCheckpointId;
  readonly committedCheckpointRef: ExecutionAuthorityCheckpointId;
  readonly resultingRecoveryState: OrchestrationRecoveryState;
  readonly pendingEffect: OrchestrationPendingEffect;
  readonly advanceProof: CheckpointAdvanceProof;
}
export interface CommitPendingIntentRequest {
  readonly sessionId: OrchestrationSessionId;
  readonly ownerId: OrchestrationLeaseOwnerId;
  readonly expectedRevision: OrchestrationRevision;
  readonly expectedFence: OrchestrationFenceToken;
  readonly previousCheckpointRef: ExecutionAuthorityCheckpointId;
  readonly committedCheckpoint: ExecutionAuthorityCheckpoint;
  readonly resultingRecoveryState: OrchestrationRecoveryState;
  readonly pendingEffect: OrchestrationPendingEffect;
}
/** Next pending identity is creation intent; lifecycle facts are derived by the transaction owner. */
export interface AdoptOutcomeRequest {
  readonly sessionId: OrchestrationSessionId;
  readonly ownerId: OrchestrationLeaseOwnerId;
  readonly expectedRevision: OrchestrationRevision;
  readonly expectedFence: OrchestrationFenceToken;
  readonly previousCheckpointRef: ExecutionAuthorityCheckpointId;
  readonly outcomeKey: OrchestrationOutcomeKey;
  readonly committedCheckpoint: ExecutionAuthorityCheckpoint;
  readonly resultingRecoveryState: OrchestrationRecoveryState;
  readonly nextPendingEffectIdentity: OrchestrationPendingEffectIdentity | null;
}
export interface PendingIntentCommitReceipt extends PendingIntentLogicalPayload {
  readonly schemaVersion: typeof ORCHESTRATION_PENDING_INTENT_COMMIT_RECEIPT_V1;
  readonly committedRevision: OrchestrationRevision;
  readonly committedFence: OrchestrationFenceToken;
  readonly committingOwnerId: OrchestrationLeaseOwnerId;
}
const pendingKeys = ["schemaVersion", "sessionId", "expectedRevision", "committedRevision", "committedFence",
  "committingOwnerId", "previousCheckpointRef", "committedCheckpointRef", "resultingRecoveryState",
  "pendingEffect", "advanceProof"];
export function createPendingIntentCommitReceipt(value: unknown, previousValue: ExecutionAuthorityCheckpoint,
  committedValue: ExecutionAuthorityCheckpoint): PendingIntentCommitReceipt {
  if (!exact(value, pendingKeys) || value["schemaVersion"] !== ORCHESTRATION_PENDING_INTENT_COMMIT_RECEIPT_V1) {
    throw new TypeError("Invalid pending receipt");
  }
  copy(value);
  const previous = checkpoint(previousValue), committed = checkpoint(committedValue);
  const sessionId = orchestrationSessionId(value["sessionId"]), expectedRevision = orchestrationRevision(value["expectedRevision"]);
  const committedRevision = nextRevision(expectedRevision), committedFence = orchestrationFenceToken(value["committedFence"]);
  if (value["committedRevision"] !== committedRevision || value["previousCheckpointRef"] !== previous.checkpointRef
      || value["committedCheckpointRef"] !== committed.checkpointRef) throw new TypeError("Pending receipt revision or ref mismatch");
  const pendingEffect = pendingAt(value["pendingEffect"], sessionId, committedRevision, committedFence,
    committed.evidence.identity.executionAttemptId);
  const advanceProof = proofMatches(value["advanceProof"], provePendingIntentCheckpointAdvance({
    previousCheckpoint: previous, committedCheckpoint: committed, pendingEffect }));
  return Object.freeze({ schemaVersion: ORCHESTRATION_PENDING_INTENT_COMMIT_RECEIPT_V1,
    sessionId, expectedRevision, committedRevision, committedFence,
    committingOwnerId: orchestrationLeaseOwnerId(value["committingOwnerId"]),
    previousCheckpointRef: previous.checkpointRef, committedCheckpointRef: committed.checkpointRef,
    resultingRecoveryState: state(value["resultingRecoveryState"], sessionId, committedRevision, committedFence, committed),
    pendingEffect, advanceProof });
}
export function equivalentPendingIntentRetry(receipt: PendingIntentCommitReceipt,
  logical: PendingIntentLogicalPayload): boolean {
  return equal(pendingLogical(receipt), pendingLogical(logical));
}
function pendingLogical(value: PendingIntentLogicalPayload): PendingIntentLogicalPayload {
  const { sessionId, expectedRevision, previousCheckpointRef, committedCheckpointRef,
    resultingRecoveryState, pendingEffect, advanceProof } = value;
  return { sessionId, expectedRevision, previousCheckpointRef, committedCheckpointRef,
    resultingRecoveryState, pendingEffect, advanceProof };
}

export interface LinkedPendingResolution {
  readonly pendingEffectIdentity: Readonly<OrchestrationPendingEffectIdentity>;
  readonly outcomeKey: OrchestrationOutcomeKey;
  readonly resolvedRevision: OrchestrationRevision;
  readonly resolvedFence: OrchestrationFenceToken;
}
export interface AdoptionLogicalPayload {
  readonly outcomeKey: OrchestrationOutcomeKey;
  readonly sessionId: OrchestrationSessionId;
  readonly executionAttemptId: string;
  readonly expectedRevision: OrchestrationRevision;
  readonly previousCheckpointRef: ExecutionAuthorityCheckpointId;
  readonly committedCheckpointRef: ExecutionAuthorityCheckpointId;
  readonly resultingRecoveryState: OrchestrationRecoveryState;
  readonly linkedPendingResolution: LinkedPendingResolution | null;
  readonly nextPendingEffect: OrchestrationPendingEffect | null;
  readonly nextPendingCommit: PendingIntentLogicalPayload | null;
  readonly advanceProof: CheckpointAdvanceProof;
}
export interface ExternalOutcomeAdoptionReceipt extends AdoptionLogicalPayload {
  readonly schemaVersion: typeof ORCHESTRATION_EXTERNAL_OUTCOME_ADOPTION_RECEIPT_V1;
  readonly adoptedRevision: OrchestrationRevision;
  readonly adoptedFence: OrchestrationFenceToken;
  readonly adoptingOwnerId: OrchestrationLeaseOwnerId;
}
const adoptionKeys = ["schemaVersion", "outcomeKey", "sessionId", "executionAttemptId", "expectedRevision",
  "adoptedRevision", "adoptedFence", "adoptingOwnerId", "previousCheckpointRef", "committedCheckpointRef",
  "resultingRecoveryState", "linkedPendingResolution", "nextPendingEffect", "nextPendingCommit", "advanceProof"];
export function createExternalOutcomeAdoptionReceipt(value: unknown, previousValue: ExecutionAuthorityCheckpoint,
  committedValue: ExecutionAuthorityCheckpoint, outcomeValue: OrchestrationExternalOutcome): ExternalOutcomeAdoptionReceipt {
  if (!exact(value, adoptionKeys) || value["schemaVersion"] !== ORCHESTRATION_EXTERNAL_OUTCOME_ADOPTION_RECEIPT_V1) {
    throw new TypeError("Invalid adoption receipt");
  }
  copy(value);
  const previous = checkpoint(previousValue), committed = checkpoint(committedValue);
  const outcome = createOrchestrationExternalOutcome(outcomeValue);
  const sessionId = orchestrationSessionId(value["sessionId"]), expectedRevision = orchestrationRevision(value["expectedRevision"]);
  const adoptedRevision = nextRevision(expectedRevision), adoptedFence = orchestrationFenceToken(value["adoptedFence"]);
  if (value["adoptedRevision"] !== adoptedRevision || value["previousCheckpointRef"] !== previous.checkpointRef
      || value["committedCheckpointRef"] !== committed.checkpointRef || value["outcomeKey"] !== outcome.outcomeKey
      || outcome.sessionId !== sessionId || value["executionAttemptId"] !== outcome.executionAttemptId
      || outcome.executionAttemptId !== committed.evidence.identity.executionAttemptId) throw new TypeError("Adoption identity mismatch");
  const nextPendingEffect = value["nextPendingEffect"] === null ? null : pendingAt(value["nextPendingEffect"], sessionId,
    adoptedRevision, adoptedFence, outcome.executionAttemptId);
  const proofResult = proveOutcomeAdoptionCheckpointAdvance({ previousCheckpoint: previous,
    committedCheckpoint: committed, outcome, nextPendingEffect });
  if (proofResult.status !== "PROVEN") throw new TypeError("Outcome is not adoptable");
  const advanceProof = proofMatches(value["advanceProof"], proofResult.proof);
  let linkedPendingResolution: LinkedPendingResolution | null = null;
  if (outcome.pendingEffectIdentity === null) {
    if (value["linkedPendingResolution"] !== null) throw new TypeError("Unexpected pending resolution");
  } else {
    const resolution = value["linkedPendingResolution"];
    if (!exact(resolution, ["pendingEffectIdentity", "outcomeKey", "resolvedRevision", "resolvedFence"])
        || !equal(createOrchestrationPendingEffectIdentity(resolution["pendingEffectIdentity"]), outcome.pendingEffectIdentity)
        || resolution["outcomeKey"] !== outcome.outcomeKey || resolution["resolvedRevision"] !== adoptedRevision
        || resolution["resolvedFence"] !== adoptedFence) throw new TypeError("Linked pending resolution mismatch");
    linkedPendingResolution = Object.freeze({ pendingEffectIdentity: outcome.pendingEffectIdentity,
      outcomeKey: outcome.outcomeKey, resolvedRevision: adoptedRevision, resolvedFence: adoptedFence });
  }
  if ((nextPendingEffect === null) !== (value["nextPendingCommit"] === null)) throw new TypeError("Next pending payload mismatch");
  let nextPendingCommit: PendingIntentLogicalPayload | null = null;
  if (nextPendingEffect !== null) {
    const nested = value["nextPendingCommit"];
    if (!exact(nested, ["sessionId", "expectedRevision", "previousCheckpointRef", "committedCheckpointRef",
      "resultingRecoveryState", "pendingEffect", "advanceProof"])) throw new TypeError("Invalid next pending payload");
    // The next effect is created by this adoption transaction, so its logical payload
    // shares the outer checkpoint advance (outcome followed by requested transition).
    if (nested["sessionId"] !== sessionId || nested["expectedRevision"] !== expectedRevision
        || nested["previousCheckpointRef"] !== previous.checkpointRef
        || nested["committedCheckpointRef"] !== committed.checkpointRef
        || !equal(nested["pendingEffect"], nextPendingEffect)) throw new TypeError("Next pending facts mismatch");
    nextPendingCommit = Object.freeze({ sessionId, expectedRevision,
      previousCheckpointRef: previous.checkpointRef, committedCheckpointRef: committed.checkpointRef,
      resultingRecoveryState: state(nested["resultingRecoveryState"], sessionId, adoptedRevision, adoptedFence, committed),
      pendingEffect: nextPendingEffect, advanceProof: proofMatches(nested["advanceProof"], advanceProof) });
    if (!equal(nextPendingCommit.resultingRecoveryState, value["resultingRecoveryState"])) {
      throw new TypeError("Next pending recovery target mismatch");
    }
  }
  return Object.freeze({ schemaVersion: ORCHESTRATION_EXTERNAL_OUTCOME_ADOPTION_RECEIPT_V1,
    outcomeKey: orchestrationOutcomeKey(value["outcomeKey"]), sessionId, executionAttemptId: outcome.executionAttemptId,
    expectedRevision, adoptedRevision, adoptedFence, adoptingOwnerId: orchestrationLeaseOwnerId(value["adoptingOwnerId"]),
    previousCheckpointRef: previous.checkpointRef, committedCheckpointRef: committed.checkpointRef,
    resultingRecoveryState: state(value["resultingRecoveryState"], sessionId, adoptedRevision, adoptedFence, committed),
    linkedPendingResolution, nextPendingEffect, nextPendingCommit, advanceProof });
}
export function equivalentOutcomeAdoptionRetry(receipt: ExternalOutcomeAdoptionReceipt,
  logical: AdoptionLogicalPayload): boolean {
  const fields: readonly (keyof AdoptionLogicalPayload)[] = ["outcomeKey", "sessionId", "executionAttemptId",
    "expectedRevision", "previousCheckpointRef", "committedCheckpointRef", "resultingRecoveryState",
    "linkedPendingResolution", "nextPendingEffect", "nextPendingCommit", "advanceProof"];
  return fields.every((field) => equal(receipt[field], logical[field]));
}

/** Fresh mutation precedence: lease, locked recovery existence/revision, lease/recovery fence
 * coherence, caller prior checkpoint, then immutable committed-checkpoint binding. An exact
 * existing receipt is checked before current lease/recovery authorization on an unknown-COMMIT retry.
 * CHECKPOINT_CONFLICT means one immutable checkpoint key has different canonical evidence.
 * PRIOR_CHECKPOINT_CONFLICT means coherent current recovery authority differs from the caller's prior ref.
 * Missing or internally contradictory durable authority remains corruption, not a typed conflict.
 */
type CheckpointTransactionConflict =
  | Readonly<{ readonly status: "CHECKPOINT_CONFLICT"; readonly checkpointRef: ExecutionAuthorityCheckpointId }>
  | Readonly<{ readonly status: "PRIOR_CHECKPOINT_CONFLICT";
    readonly requestedPreviousCheckpointRef: ExecutionAuthorityCheckpointId;
    readonly currentCheckpointRef: ExecutionAuthorityCheckpointId | null }>;

export type PendingIntentTransactionResult =
  | Readonly<{ readonly status: "COMMITTED" | "ALREADY_COMMITTED"; readonly receipt: PendingIntentCommitReceipt }>
  | Readonly<{ readonly status: "REVISION_CONFLICT"; readonly currentRevision: OrchestrationRevision }>
  | Readonly<{ readonly status: "FENCE_CONFLICT"; readonly currentFence: OrchestrationFenceToken | null }>
  | Readonly<{ readonly status: "LEASE_LOST" | "NOT_FOUND" | "EFFECT_CONFLICT" }>
  | CheckpointTransactionConflict;
export type OutcomeAdoptionTransactionResult =
  | Readonly<{ readonly status: "ADOPTED" | "ALREADY_ADOPTED"; readonly receipt: ExternalOutcomeAdoptionReceipt }>
  | Readonly<{ readonly status: "REVISION_CONFLICT"; readonly currentRevision: OrchestrationRevision }>
  | Readonly<{ readonly status: "FENCE_CONFLICT"; readonly currentFence: OrchestrationFenceToken | null }>
  | Readonly<{ readonly status: "LEASE_LOST" | "NOT_FOUND" | "OUTCOME_NOT_FOUND" | "OUTCOME_NOT_ADOPTABLE"
    | "EFFECT_CONFLICT" | "ADOPTION_CONFLICT" }>
  | CheckpointTransactionConflict;
