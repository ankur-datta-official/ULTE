import type { ExecutionAttemptRecoveryIdentity } from "@ulte/execution-engine";
import { instrumentId, type InstrumentId, type UnixMs } from "@ulte/instrument-model";

declare const sessionIdBrand: unique symbol;
declare const revisionBrand: unique symbol;
declare const leaseOwnerIdBrand: unique symbol;
declare const fenceTokenBrand: unique symbol;
declare const leaseDurationBrand: unique symbol;
declare const executionCheckpointBrand: unique symbol;
declare const riskCheckpointBrand: unique symbol;
declare const latestROutcomeBrand: unique symbol;

export type OrchestrationSessionId = string & { readonly [sessionIdBrand]: "OrchestrationSessionId" };
export type OrchestrationRevision = number & { readonly [revisionBrand]: "OrchestrationRevision" };
export type OrchestrationLeaseOwnerId = string & { readonly [leaseOwnerIdBrand]: "OrchestrationLeaseOwnerId" };
export type OrchestrationFenceToken = number & { readonly [fenceTokenBrand]: "OrchestrationFenceToken" };
export type OrchestrationLeaseDurationMs = number & { readonly [leaseDurationBrand]: "OrchestrationLeaseDurationMs" };
export type ExecutionAuthorityCheckpointId = string & { readonly [executionCheckpointBrand]: "ExecutionAuthorityCheckpointId" };
export type RiskBasisCheckpointId = string & { readonly [riskCheckpointBrand]: "RiskBasisCheckpointId" };
export type LatestROutcomeId = string & { readonly [latestROutcomeBrand]: "LatestROutcomeId" };

function identifier(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) {
    throw new TypeError(`${name} must be non-empty and have no surrounding whitespace`);
  }
  return value;
}

export function orchestrationSessionId(value: unknown): OrchestrationSessionId {
  return identifier(value, "sessionId") as OrchestrationSessionId;
}

export function orchestrationLeaseOwnerId(value: unknown): OrchestrationLeaseOwnerId {
  return identifier(value, "leaseOwnerId") as OrchestrationLeaseOwnerId;
}

export function executionAuthorityCheckpointId(value: unknown): ExecutionAuthorityCheckpointId {
  return identifier(value, "executionAuthorityCheckpointRef") as ExecutionAuthorityCheckpointId;
}

export function riskBasisCheckpointId(value: unknown): RiskBasisCheckpointId {
  return identifier(value, "riskBasisCheckpointRef") as RiskBasisCheckpointId;
}

export function latestROutcomeId(value: unknown): LatestROutcomeId {
  return identifier(value, "latestROutcomeRef") as LatestROutcomeId;
}

export function orchestrationRevision(value: unknown): OrchestrationRevision {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new TypeError("revision must be a non-negative safe integer");
  }
  return value as OrchestrationRevision;
}

export function orchestrationFenceToken(value: unknown): OrchestrationFenceToken {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new TypeError("fenceToken must be a positive safe integer");
  }
  return value as OrchestrationFenceToken;
}

export function orchestrationLeaseDurationMs(value: unknown): OrchestrationLeaseDurationMs {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new TypeError("leaseDurationMs must be a positive safe integer");
  }
  return value as OrchestrationLeaseDurationMs;
}

export const ORCHESTRATION_RECOVERY_RECORD_SCHEMA_VERSION = "ORCHESTRATION_RECOVERY_RECORD_V1" as const;

export type OrchestrationRecoveryMode = "DRY_RUN" | "SANDBOX";
export type ExecutionAuthorityIdentity = ExecutionAttemptRecoveryIdentity;

/** Durable session metadata only. References grant no execution, risk, or R authority. */
export interface OrchestrationRecoveryRecord {
  readonly schemaVersion: typeof ORCHESTRATION_RECOVERY_RECORD_SCHEMA_VERSION;
  readonly sessionId: OrchestrationSessionId;
  readonly revision: OrchestrationRevision;
  readonly fenceToken: OrchestrationFenceToken;
  readonly mode: OrchestrationRecoveryMode;
  readonly instrumentId: InstrumentId;
  readonly executionAuthorityCheckpointRef: ExecutionAuthorityCheckpointId | null;
  readonly executionAuthorityIdentity: Readonly<ExecutionAuthorityIdentity> | null;
  readonly riskBasisCheckpointRef: RiskBasisCheckpointId | null;
  readonly latestROutcomeRef: LatestROutcomeId | null;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function exactKeys(value: Readonly<Record<string, unknown>>, keys: readonly string[]): boolean {
  const actual = Reflect.ownKeys(value);
  return actual.length === keys.length && actual.every((key) => typeof key === "string" && keys.includes(key));
}

function isPlainJson(value: unknown, ancestors: ReadonlySet<object> = new Set()): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object" || ancestors.has(value)) return false;
  const next = new Set(ancestors);
  next.add(value);
  if (Array.isArray(value)) {
    if (Reflect.ownKeys(value).length !== value.length + 1) return false;
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, index);
      if (descriptor === undefined || !("value" in descriptor) || !isPlainJson(descriptor.value, next)) return false;
    }
    return true;
  }
  if (!isRecord(value)) return false;
  return Reflect.ownKeys(value).every((key) => {
    if (typeof key !== "string") return false;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor !== undefined && "value" in descriptor && descriptor.enumerable
      && isPlainJson(descriptor.value, next);
  });
}

/** Validate every persisted row before exposing it to a recovery coordinator. */
export function createOrchestrationRecoveryRecord(value: unknown): OrchestrationRecoveryRecord {
  if (!isPlainJson(value) || !isRecord(value) || !exactKeys(value, [
    "schemaVersion", "sessionId", "revision", "fenceToken", "mode", "instrumentId",
    "executionAuthorityCheckpointRef", "executionAuthorityIdentity", "riskBasisCheckpointRef", "latestROutcomeRef",
  ]) || value["schemaVersion"] !== ORCHESTRATION_RECOVERY_RECORD_SCHEMA_VERSION) {
    throw new TypeError("Invalid orchestration recovery record");
  }
  const sessionId = orchestrationSessionId(value["sessionId"]);
  const revision = orchestrationRevision(value["revision"]);
  const fenceToken = orchestrationFenceToken(value["fenceToken"]);
  const mode = value["mode"];
  if (mode !== "DRY_RUN" && mode !== "SANDBOX") throw new TypeError("Invalid orchestration recovery mode");
  const canonicalInstrumentId = instrumentId(value["instrumentId"]);
  const checkpoint = value["executionAuthorityCheckpointRef"];
  const identity = value["executionAuthorityIdentity"];
  const risk = value["riskBasisCheckpointRef"];
  const latestR = value["latestROutcomeRef"];
  if ((checkpoint === null) !== (identity === null)) {
    throw new TypeError("Execution checkpoint and identity must appear together");
  }
  if (risk !== null && checkpoint === null) throw new TypeError("Risk checkpoint requires execution authority");
  if (latestR !== null && (checkpoint === null || risk === null)) {
    throw new TypeError("Latest R outcome requires execution and risk context");
  }
  let executionAuthorityIdentity: Readonly<ExecutionAuthorityIdentity> | null = null;
  if (identity !== null) {
    if (!isRecord(identity) || !exactKeys(identity, [
      "executionAttemptId", "executionPlanId", "tradeIntentId", "candidateId", "instrumentId",
    ])) throw new TypeError("Invalid execution authority identity");
    const identityInstrumentId = instrumentId(identity["instrumentId"]);
    if (identityInstrumentId !== canonicalInstrumentId) throw new TypeError("Execution instrument mismatch");
    executionAuthorityIdentity = Object.freeze({
      executionAttemptId: identifier(identity["executionAttemptId"], "executionAttemptId"),
      executionPlanId: identifier(identity["executionPlanId"], "executionPlanId"),
      tradeIntentId: identifier(identity["tradeIntentId"], "tradeIntentId"),
      candidateId: identifier(identity["candidateId"], "candidateId"),
      instrumentId: identityInstrumentId,
    });
  }
  return Object.freeze({
    schemaVersion: ORCHESTRATION_RECOVERY_RECORD_SCHEMA_VERSION,
    sessionId, revision, fenceToken, mode, instrumentId: canonicalInstrumentId,
    executionAuthorityCheckpointRef: checkpoint === null ? null : executionAuthorityCheckpointId(checkpoint),
    executionAuthorityIdentity,
    riskBasisCheckpointRef: risk === null ? null : riskBasisCheckpointId(risk),
    latestROutcomeRef: latestR === null ? null : latestROutcomeId(latestR),
  });
}

export interface OrchestrationRecoveryState {
  readonly mode: OrchestrationRecoveryMode;
  readonly instrumentId: InstrumentId;
  readonly executionAuthorityCheckpointRef: ExecutionAuthorityCheckpointId | null;
  readonly executionAuthorityIdentity: Readonly<ExecutionAuthorityIdentity> | null;
  readonly riskBasisCheckpointRef: RiskBasisCheckpointId | null;
  readonly latestROutcomeRef: LatestROutcomeId | null;
}

export interface OrchestrationRecoveryWrite {
  readonly sessionId: OrchestrationSessionId;
  readonly expectedRevision: OrchestrationRevision;
  readonly expectedFence: OrchestrationFenceToken;
  readonly state: OrchestrationRecoveryState;
}

export type OrchestrationRecoverySaveResult =
  | Readonly<{ readonly status: "SAVED"; readonly record: OrchestrationRecoveryRecord; readonly newRevision: OrchestrationRevision }>
  | Readonly<{ readonly status: "REVISION_CONFLICT"; readonly currentRevision: OrchestrationRevision }>
  | Readonly<{ readonly status: "FENCE_CONFLICT"; readonly currentFence: OrchestrationFenceToken | null }>
  | Readonly<{ readonly status: "NOT_FOUND" }>;

/** Mutations are atomic CAS operations; expected contention returns a result. */
export interface OrchestrationRecoveryStore {
  loadRecoveryState(sessionId: OrchestrationSessionId): Promise<OrchestrationRecoveryRecord | null>;
  /** expectedRevision must be zero; success creates revision zero. */
  initializeRecoveryState(write: OrchestrationRecoveryWrite): Promise<OrchestrationRecoverySaveResult>;
  /** Success stores a replacement at expectedRevision + 1 with expectedFence. */
  saveRecoveryState(write: OrchestrationRecoveryWrite): Promise<OrchestrationRecoverySaveResult>;
}

export interface OrchestrationLeaseRequest {
  readonly sessionId: OrchestrationSessionId;
  readonly ownerId: OrchestrationLeaseOwnerId;
  readonly leaseDurationMs: OrchestrationLeaseDurationMs;
}

export interface OrchestrationHeldLease {
  readonly sessionId: OrchestrationSessionId;
  readonly ownerId: OrchestrationLeaseOwnerId;
  readonly fenceToken: OrchestrationFenceToken;
  readonly expiresAt: UnixMs;
}

export type OrchestrationLeaseAcquireResult =
  | Readonly<{ readonly status: "ACQUIRED"; readonly lease: OrchestrationHeldLease }>
  | Readonly<{ readonly status: "HELD_BY_OTHER"; readonly expiresAt: UnixMs }>;

export type OrchestrationLeaseRenewResult =
  | Readonly<{ readonly status: "RENEWED"; readonly lease: OrchestrationHeldLease }>
  | Readonly<{ readonly status: "LEASE_LOST" }>;

export type OrchestrationLeaseReleaseResult =
  | Readonly<{ readonly status: "RELEASED" }>
  | Readonly<{ readonly status: "LEASE_LOST" }>
  | Readonly<{ readonly status: "NOT_HELD" }>;

export interface OrchestrationFencedLeaseRequest extends OrchestrationLeaseRequest {
  readonly expectedFence: OrchestrationFenceToken;
}

/** Persistence supplies timestamps from its authoritative clock; PostgreSQL uses DB time. */
export interface OrchestrationRecoveryLeaseStore {
  /** Each new acquisition or takeover must increase the session fence token. */
  acquireRecoveryLease(request: OrchestrationLeaseRequest): Promise<OrchestrationLeaseAcquireResult>;
  renewRecoveryLease(request: OrchestrationFencedLeaseRequest): Promise<OrchestrationLeaseRenewResult>;
  releaseRecoveryLease(request: Omit<OrchestrationFencedLeaseRequest, "leaseDurationMs">): Promise<OrchestrationLeaseReleaseResult>;
}
