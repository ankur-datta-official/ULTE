import { brokerAdapterId, IDEMPOTENCY_OPERATIONS,
  type BrokerAdapterId, type IdempotencyOperation,
  type RequestFingerprint } from "@ulte/broker-adapters";
import { createCancellationAcknowledgement, createCancellationRejection,
  createEntryAcknowledgement, createEntryRejection, createExitFillEvent, createFillEvent,
  createProtectionAcknowledgement, createProtectionRejection,
  type ExecutionAttemptRecoveryTransition } from "@ulte/execution-engine";
import type { ReconciliationObservation } from "@ulte/execution-reconciliation-engine";
import { unixMs, type UnixMs } from "@ulte/instrument-model";
import { orchestrationFenceToken, orchestrationRevision, orchestrationSessionId,
  type OrchestrationFenceToken, type OrchestrationRecoveryMode, type OrchestrationRevision,
  type OrchestrationSessionId } from "./recovery-store.js";

declare const outcomeKeyBrand: unique symbol;
export type OrchestrationOutcomeKey = string & { readonly [outcomeKeyBrand]: "OrchestrationOutcomeKey" };
export const ORCHESTRATION_PENDING_EFFECT_SCHEMA_VERSION = "ORCHESTRATION_PENDING_EFFECT_V1" as const;
export const ORCHESTRATION_PENDING_EFFECT_V2 = "ORCHESTRATION_PENDING_EFFECT_V2" as const;
export const ORCHESTRATION_EXTERNAL_OUTCOME_SCHEMA_VERSION = "ORCHESTRATION_EXTERNAL_OUTCOME_V1" as const;

/** The durable lookup key is (adapterId, idempotencyKey); all other fields detect conflicting reuse. */
export interface OrchestrationPendingEffectIdentity {
  readonly adapterId: BrokerAdapterId;
  readonly environment: OrchestrationRecoveryMode;
  readonly operation: IdempotencyOperation;
  readonly executionAttemptId: string;
  readonly idempotencyKey: string;
  readonly requestFingerprint: RequestFingerprint;
}

type PendingBase = Readonly<OrchestrationPendingEffectIdentity & {
  readonly sessionId: OrchestrationSessionId;
  readonly createdRevision: OrchestrationRevision;
  readonly createdFence: OrchestrationFenceToken;
  readonly state: "PENDING" | "RESOLVED";
  readonly resolvedOutcomeKey: OrchestrationOutcomeKey | null;
  readonly resolvedRevision: OrchestrationRevision | null;
  readonly resolvedFence: OrchestrationFenceToken | null;
}>;
export type OrchestrationPendingEffect =
  | Readonly<PendingBase & { readonly schemaVersion: typeof ORCHESTRATION_PENDING_EFFECT_SCHEMA_VERSION;
      readonly resolutionKind?: "EXTERNAL_OUTCOME" | null; readonly resolvedAuthorityRef?: OrchestrationOutcomeKey | null }>
  | Readonly<PendingBase & { readonly schemaVersion: typeof ORCHESTRATION_PENDING_EFFECT_V2;
      readonly resolutionKind: "EXTERNAL_OUTCOME" | "TERMINAL_NON_SUBMISSION" | null;
      readonly resolvedAuthorityRef: string | null }>;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}
function exact(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Reflect.ownKeys(value);
  return actual.length === keys.length && actual.every((key) => typeof key === "string" && keys.includes(key));
}
function id(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) {
    throw new TypeError(`Invalid ${field}`);
  }
  return value;
}
export function orchestrationOutcomeKey(value: unknown): OrchestrationOutcomeKey {
  return id(value, "outcomeKey") as OrchestrationOutcomeKey;
}
export function createOrchestrationPendingEffectIdentity(value: unknown): Readonly<OrchestrationPendingEffectIdentity> {
  if (!record(value) || !exact(value, ["adapterId", "environment", "operation", "executionAttemptId", "idempotencyKey", "requestFingerprint"])) {
    throw new TypeError("Invalid pending effect identity");
  }
  if ((value["environment"] !== "DRY_RUN" && value["environment"] !== "SANDBOX")
      || !IDEMPOTENCY_OPERATIONS.some((operation) => operation === value["operation"])) {
    throw new TypeError("Invalid pending effect environment or operation");
  }
  return Object.freeze({
    adapterId: brokerAdapterId(value["adapterId"]),
    environment: value["environment"],
    operation: value["operation"] as IdempotencyOperation,
    executionAttemptId: id(value["executionAttemptId"], "executionAttemptId"),
    idempotencyKey: id(value["idempotencyKey"], "idempotencyKey"),
    requestFingerprint: id(value["requestFingerprint"], "requestFingerprint") as RequestFingerprint,
  });
}
const identityKeys = ["adapterId", "environment", "operation", "executionAttemptId", "idempotencyKey", "requestFingerprint"];
export function createOrchestrationPendingEffect(value: unknown): OrchestrationPendingEffect {
  const version = record(value) ? value["schemaVersion"] : undefined;
  const v2 = version === ORCHESTRATION_PENDING_EFFECT_V2;
  if (!record(value) || !exact(value, ["schemaVersion", "sessionId", ...identityKeys,
    "createdRevision", "createdFence", "state", "resolvedOutcomeKey", "resolvedRevision", "resolvedFence",
    ...(v2 ? ["resolutionKind", "resolvedAuthorityRef"] : [])])
      || (!v2 && version !== ORCHESTRATION_PENDING_EFFECT_SCHEMA_VERSION)) {
    throw new TypeError("Invalid pending effect record");
  }
  const identity = createOrchestrationPendingEffectIdentity(Object.fromEntries(identityKeys.map((key) => [key, value[key]])));
  const createdRevision = orchestrationRevision(value["createdRevision"]);
  const createdFence = orchestrationFenceToken(value["createdFence"]);
  const state = value["state"];
  if (state !== "PENDING" && state !== "RESOLVED") throw new TypeError("Invalid pending state");
  const resolution = [value["resolvedOutcomeKey"], value["resolvedRevision"], value["resolvedFence"]];
  if (v2) {
    const kind = value["resolutionKind"], ref = value["resolvedAuthorityRef"];
    if (state === "PENDING" && (kind !== null || ref !== null || resolution.some((field) => field !== null))
        || state === "RESOLVED" && (kind !== "EXTERNAL_OUTCOME" && kind !== "TERMINAL_NON_SUBMISSION"
          || typeof ref !== "string" || !ref || ref.trim() !== ref
          || value["resolvedRevision"] === null || value["resolvedFence"] === null
          || kind === "TERMINAL_NON_SUBMISSION" && value["resolvedOutcomeKey"] !== null
          || kind === "EXTERNAL_OUTCOME" && value["resolvedOutcomeKey"] !== ref)) {
      throw new TypeError("Pending resolution authority disagrees with state");
    }
  } else if (state === "PENDING" && resolution.some((field) => field !== null)
      || state === "RESOLVED" && resolution.some((field) => field === null)) {
    throw new TypeError("Pending resolution fields disagree with state");
  }
  const resolvedRevision = state === "RESOLVED" ? orchestrationRevision(value["resolvedRevision"]) : null;
  if (resolvedRevision !== null && resolvedRevision < createdRevision) throw new TypeError("Resolution precedes creation");
  return Object.freeze({
    schemaVersion: v2 ? ORCHESTRATION_PENDING_EFFECT_V2 : ORCHESTRATION_PENDING_EFFECT_SCHEMA_VERSION,
    sessionId: orchestrationSessionId(value["sessionId"]), ...identity,
    createdRevision, createdFence, state,
    resolvedOutcomeKey: state === "RESOLVED" && (!v2 || value["resolutionKind"] === "EXTERNAL_OUTCOME")
      ? orchestrationOutcomeKey(value["resolvedOutcomeKey"]) : null,
    resolvedRevision,
    resolvedFence: state === "RESOLVED" ? orchestrationFenceToken(value["resolvedFence"]) : null,
    ...(v2 ? { resolutionKind: value["resolutionKind"] as "EXTERNAL_OUTCOME" | "TERMINAL_NON_SUBMISSION" | null,
      resolvedAuthorityRef: value["resolvedAuthorityRef"] as string | null } : {}),
  }) as OrchestrationPendingEffect;
}

type ExternalTransition = Exclude<ExecutionAttemptRecoveryTransition,
  { readonly kind: "ENTRY_SUBMISSION_REQUESTED" | "PROTECTION_REQUESTED" | "ENTRY_CANCELLATION_REQUESTED" }>;
export type OrchestrationExternalObservation =
  | Readonly<{ readonly kind: "CANONICAL_EXECUTION_TRANSITION"; readonly transition: ExternalTransition }>
  | Readonly<{ readonly kind: "BROKER_DISPOSITION"; readonly disposition: ReconciliationObservation }>;
export interface OrchestrationExternalOutcome {
  readonly schemaVersion: typeof ORCHESTRATION_EXTERNAL_OUTCOME_SCHEMA_VERSION;
  readonly outcomeKey: OrchestrationOutcomeKey;
  readonly sessionId: OrchestrationSessionId;
  readonly executionAttemptId: string;
  readonly observedAt: UnixMs;
  /** Observer epoch; independent of createdFence and the eventual resolving owner's fence. */
  readonly observedFence: OrchestrationFenceToken;
  readonly pendingEffectIdentity: Readonly<OrchestrationPendingEffectIdentity> | null;
  readonly observation: OrchestrationExternalObservation;
}

function frozenPlain(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) {
    if (Reflect.ownKeys(value).length !== value.length + 1) throw new TypeError("Invalid observation array");
    return Object.freeze(value.map(frozenPlain));
  }
  if (!record(value)) throw new TypeError("Invalid observation data");
  const copy: Record<string, unknown> = {};
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") throw new TypeError("Invalid observation key");
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) throw new TypeError("Invalid observation property");
    copy[key] = frozenPlain(descriptor.value);
  }
  return Object.freeze(copy);
}
function transitionOperation(kind: ExternalTransition["kind"]): IdempotencyOperation | null {
  if (kind.startsWith("ENTRY_SUBMISSION_")) return "ENTRY_SUBMISSION";
  if (kind.startsWith("PROTECTION_")) return "PROTECTION_SUBMISSION";
  if (kind.startsWith("ENTRY_CANCELLATION_")) return "ENTRY_CANCELLATION";
  return null;
}
function canonicalTransition(value: unknown): ExternalTransition {
  if (!record(value) || !exact(value, ["kind", value["kind"] === "ENTRY_FILL_APPLIED" || value["kind"] === "EXIT_FILL_APPLIED" ? "fill"
    : typeof value["kind"] === "string" && value["kind"].endsWith("ACKNOWLEDGED") ? "acknowledgement" : "rejection"])) {
    throw new TypeError("Invalid external transition");
  }
  const kind = value["kind"];
  const payload = value["fill"] ?? value["acknowledgement"] ?? value["rejection"];
  if (!record(payload)) throw new TypeError("Invalid transition payload");
  const validators = {
    ENTRY_SUBMISSION_ACKNOWLEDGED: createEntryAcknowledgement,
    ENTRY_SUBMISSION_REJECTED: createEntryRejection,
    ENTRY_FILL_APPLIED: createFillEvent,
    PROTECTION_ACKNOWLEDGED: createProtectionAcknowledgement,
    PROTECTION_REJECTED: createProtectionRejection,
    ENTRY_CANCELLATION_ACKNOWLEDGED: createCancellationAcknowledgement,
    ENTRY_CANCELLATION_REJECTED: createCancellationRejection,
    EXIT_FILL_APPLIED: createExitFillEvent,
  };
  if (typeof kind !== "string" || !(kind in validators)) throw new TypeError("Unsupported external transition");
  const validate = validators[kind as keyof typeof validators] as (input: never) => unknown;
  const canonical = validate(payload as never);
  if (!record(canonical) || !exact(payload, Object.keys(canonical).filter((key) => key !== "kind"))
      || Object.keys(payload).some((key) => payload[key] !== canonical[key])) {
    throw new TypeError("Noncanonical external transition payload");
  }
  return frozenPlain(value) as ExternalTransition;
}
function disposition(value: unknown): ReconciliationObservation {
  if (!record(value)) throw new TypeError("Invalid broker disposition");
  const status = value["status"];
  if (status === "CONFIRMED_NOT_SUBMITTED") {
    if (!exact(value, ["status"])) throw new TypeError("Invalid broker disposition");
  } else if (status === "CONFIRMED_ACCEPTED" || status === "CONFIRMED_REJECTED" || status === "STILL_UNKNOWN") {
    if (!exact(value, value["adapterOrderId"] === undefined ? ["status"] : ["status", "adapterOrderId"])) {
      throw new TypeError("Invalid broker disposition");
    }
    if (value["adapterOrderId"] !== undefined) id(value["adapterOrderId"], "adapterOrderId");
  } else throw new TypeError("Invalid broker disposition");
  return frozenPlain(value) as ReconciliationObservation;
}
export function createOrchestrationExternalOutcome(value: unknown): Readonly<OrchestrationExternalOutcome> {
  if (!record(value) || !exact(value, ["schemaVersion", "outcomeKey", "sessionId", "executionAttemptId",
    "observedAt", "observedFence", "pendingEffectIdentity", "observation"])
      || value["schemaVersion"] !== ORCHESTRATION_EXTERNAL_OUTCOME_SCHEMA_VERSION || !record(value["observation"])) {
    throw new TypeError("Invalid external outcome");
  }
  const attemptId = id(value["executionAttemptId"], "executionAttemptId");
  const pending = value["pendingEffectIdentity"] === null ? null : createOrchestrationPendingEffectIdentity(value["pendingEffectIdentity"]);
  if (pending !== null && pending.executionAttemptId !== attemptId) throw new TypeError("Pending attempt mismatch");
  const raw = value["observation"];
  let observation: OrchestrationExternalObservation;
  if (raw["kind"] === "CANONICAL_EXECUTION_TRANSITION" && exact(raw, ["kind", "transition"])) {
    const transition = canonicalTransition(raw["transition"]);
    const payload = "fill" in transition ? transition.fill : "acknowledgement" in transition ? transition.acknowledgement : transition.rejection;
    if (payload.executionAttemptId !== attemptId) throw new TypeError("Transition attempt mismatch");
    const operation = transitionOperation(transition.kind);
    if (pending !== null && (operation === null || pending.operation !== operation
        || ("idempotencyKey" in payload && payload.idempotencyKey !== pending.idempotencyKey))) {
      throw new TypeError("Impossible pending transition linkage");
    }
    observation = Object.freeze({ kind: "CANONICAL_EXECUTION_TRANSITION", transition });
  } else if (raw["kind"] === "BROKER_DISPOSITION" && exact(raw, ["kind", "disposition"])) {
    if (pending === null) throw new TypeError("Broker disposition requires pending identity");
    observation = Object.freeze({ kind: "BROKER_DISPOSITION", disposition: disposition(raw["disposition"]) });
  } else throw new TypeError("Invalid external observation");
  return Object.freeze({
    schemaVersion: ORCHESTRATION_EXTERNAL_OUTCOME_SCHEMA_VERSION,
    outcomeKey: orchestrationOutcomeKey(value["outcomeKey"]),
    sessionId: orchestrationSessionId(value["sessionId"]), executionAttemptId: attemptId,
    observedAt: unixMs(value["observedAt"]), observedFence: orchestrationFenceToken(value["observedFence"]),
    pendingEffectIdentity: pending, observation,
  });
}

/** Implementations return DUPLICATE_SAME only when session, the complete identity, and
 * createdRevision/createdFence equal the existing row under (adapterId, idempotencyKey).
 * Any disagreement is EFFECT_CONFLICT; creation never overwrites. */
export type OrchestrationPendingEffectCreateResult =
  | Readonly<{ readonly status: "CREATED" | "DUPLICATE_SAME"; readonly effect: OrchestrationPendingEffect }>
  | Readonly<{ readonly status: "EFFECT_CONFLICT"; readonly existing: OrchestrationPendingEffect }>;
/** Same outcomeKey and every immutable observation field equal is DUPLICATE_SAME;
 * contradictory reuse is OUTCOME_CONFLICT. Appending never overwrites. */
export type OrchestrationOutcomeAppendResult =
  | Readonly<{ readonly status: "APPENDED" | "DUPLICATE_SAME"; readonly outcome: OrchestrationExternalOutcome }>
  | Readonly<{ readonly status: "OUTCOME_CONFLICT"; readonly existing: OrchestrationExternalOutcome }>;
export interface OrchestrationPendingEffectResolutionRequest {
  readonly sessionId: OrchestrationSessionId;
  readonly pendingEffectIdentity: Readonly<OrchestrationPendingEffectIdentity>;
  readonly outcomeKey: OrchestrationOutcomeKey;
  readonly expectedRevision: OrchestrationRevision;
  /** Current owner's fence, which may be newer than the effect's creation fence. */
  readonly expectedFence: OrchestrationFenceToken;
}
/** Resolution must compare the current session revision and current owner fence,
 * confirm the named outcome, and link/apply it exactly once. */
export type OrchestrationPendingEffectResolutionResult =
  | Readonly<{ readonly status: "RESOLVED" | "ALREADY_RESOLVED"; readonly effect: OrchestrationPendingEffect }>
  | Readonly<{ readonly status: "NOT_FOUND" | "OUTCOME_NOT_FOUND" }>
  | Readonly<{ readonly status: "REVISION_CONFLICT"; readonly currentRevision: OrchestrationRevision }>
  | Readonly<{ readonly status: "FENCE_CONFLICT"; readonly currentFence: OrchestrationFenceToken | null }>;

/** A pending effect is valid only if createdRevision durably contains its canonical Phase33A
 * *_REQUESTED transition. Before I/O or retry, restore that revision, regenerate the request,
 * recompute the existing RequestFingerprint, and require equality with the pending fingerprint.
 * Storage alone does not restore execution authority. B1E must atomically compose creation with
 * the requested transition, and resolution with outcome application. The mutation methods below
 * are transaction-capable primitives, never a safe multi-step workflow by themselves. */
export interface OrchestrationPendingEffectStore {
  loadPendingEffect(identity: Readonly<OrchestrationPendingEffectIdentity>): Promise<OrchestrationPendingEffect | null>;
  listUnresolvedEffects(sessionId: OrchestrationSessionId): Promise<readonly OrchestrationPendingEffect[]>;
  createPendingEffect(effect: OrchestrationPendingEffect): Promise<OrchestrationPendingEffectCreateResult>;
  resolvePendingEffect(request: OrchestrationPendingEffectResolutionRequest): Promise<OrchestrationPendingEffectResolutionResult>;
}
export interface OrchestrationExternalOutcomeStore {
  loadOutcome(outcomeKey: OrchestrationOutcomeKey): Promise<OrchestrationExternalOutcome | null>;
  listExecutionOutcomes(sessionId: OrchestrationSessionId, executionAttemptId: string): Promise<readonly OrchestrationExternalOutcome[]>;
  appendOutcome(outcome: OrchestrationExternalOutcome): Promise<OrchestrationOutcomeAppendResult>;
}
