import { unixMs, type UnixMs } from "@ulte/instrument-model";
import {
  brokerAdapterId,
  isExecutionEnvironment,
  type BrokerAdapterId,
  type ExecutionEnvironment,
} from "./identity.js";
import type { RequestFingerprint } from "./fingerprints.js";

export const IDEMPOTENCY_OPERATIONS = [
  "ENTRY_SUBMISSION",
  "PROTECTION_SUBMISSION",
  "ENTRY_CANCELLATION",
] as const;
export type IdempotencyOperation = (typeof IDEMPOTENCY_OPERATIONS)[number];

export const IDEMPOTENCY_RECORD_STATUSES = [
  "CLAIMED",
  "SUBMITTED",
  "CONFIRMED",
  "REJECTED",
  "OUTCOME_UNKNOWN",
  "RETRY_AUTHORIZED",
  "FAILED_NOT_SUBMITTED",
] as const;
export type IdempotencyRecordStatus = (typeof IDEMPOTENCY_RECORD_STATUSES)[number];

export interface IdempotencyRecord {
  readonly idempotencyKey: string;
  readonly adapterId: BrokerAdapterId;
  readonly environment: ExecutionEnvironment;
  readonly executionAttemptId: string;
  readonly operation: IdempotencyOperation;
  readonly requestFingerprint: RequestFingerprint;
  readonly status: IdempotencyRecordStatus;
  readonly createdAt: UnixMs;
  readonly updatedAt: UnixMs;
  readonly adapterOrderId?: string;
}

export interface IdempotencyRecordInput extends Omit<IdempotencyRecord,
  "adapterId" | "createdAt" | "updatedAt"> {
  readonly adapterId: string;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface IdempotencyClaimInput {
  readonly idempotencyKey: string;
  readonly adapterId: BrokerAdapterId;
  readonly environment: ExecutionEnvironment;
  readonly executionAttemptId: string;
  readonly operation: IdempotencyOperation;
  readonly requestFingerprint: RequestFingerprint;
  readonly claimedAt: UnixMs;
}

export type IdempotencyClaimResult =
  | { readonly status: "CLAIMED_NEW"; readonly record: IdempotencyRecord }
  | { readonly status: "EXISTING_SAME_REQUEST"; readonly record: IdempotencyRecord }
  | {
      readonly status: "CONFLICT";
      readonly reason: "IDEMPOTENCY_CONFLICT";
      readonly record: IdempotencyRecord;
    };

export interface IdempotencyOutcomeInput {
  readonly adapterId: BrokerAdapterId;
  /** Must equal the environment established by the original atomic claim. */
  readonly environment: ExecutionEnvironment;
  readonly idempotencyKey: string;
  readonly requestFingerprint: RequestFingerprint;
  readonly status: Exclude<IdempotencyRecordStatus, "CLAIMED">;
  readonly updatedAt: UnixMs;
  readonly adapterOrderId?: string;
}

export type IdempotencyOutcomeResult =
  | { readonly status: "APPLIED_TRANSITION" | "APPLIED_ENRICHMENT" | "DUPLICATE_SAME"; readonly record: IdempotencyRecord }
  | { readonly status: "STATUS_CONFLICT"; readonly record: IdempotencyRecord };

export class AdapterOrderIdConflictError extends Error {
  public override readonly name = "AdapterOrderIdConflictError";
  public readonly code = "ADAPTER_ORDER_ID_CONFLICT";
}

const LEGAL_OUTCOME_EDGES: Readonly<Record<IdempotencyRecordStatus, readonly IdempotencyOutcomeInput["status"][]>> = {
  CLAIMED: ["SUBMITTED", "CONFIRMED", "REJECTED", "OUTCOME_UNKNOWN", "RETRY_AUTHORIZED"],
  SUBMITTED: ["CONFIRMED", "REJECTED", "OUTCOME_UNKNOWN", "RETRY_AUTHORIZED", "FAILED_NOT_SUBMITTED"],
  OUTCOME_UNKNOWN: ["CONFIRMED", "REJECTED", "RETRY_AUTHORIZED"],
  RETRY_AUTHORIZED: ["SUBMITTED"],
  CONFIRMED: [],
  REJECTED: [],
  FAILED_NOT_SUBMITTED: [],
};

/** Pure authority for outcome state changes and the one source-proven fact enrichment. */
export function classifyIdempotencyOutcome(
  current: IdempotencyRecord,
  requested: Pick<IdempotencyOutcomeInput, "status" | "updatedAt" | "adapterOrderId">,
): IdempotencyOutcomeResult {
  if (!(IDEMPOTENCY_RECORD_STATUSES as readonly string[]).includes(requested.status)) {
    throw new TypeError("Invalid idempotency outcome status");
  }
  unixMs(requested.updatedAt);
  if (requested.updatedAt < current.updatedAt) throw new RangeError("updatedAt cannot move backwards");
  if (requested.adapterOrderId !== undefined) identifier(requested.adapterOrderId, "adapterOrderId");
  if (current.adapterOrderId !== undefined && requested.adapterOrderId !== undefined
    && current.adapterOrderId !== requested.adapterOrderId) {
    throw new AdapterOrderIdConflictError("adapterOrderId cannot replace an existing durable identifier");
  }
  if (current.status === requested.status) {
    if (current.status === "OUTCOME_UNKNOWN" && current.adapterOrderId === undefined
      && requested.adapterOrderId !== undefined) {
      return Object.freeze({
        status: "APPLIED_ENRICHMENT",
        record: createIdempotencyRecord({ ...current, updatedAt: requested.updatedAt,
          adapterOrderId: requested.adapterOrderId }),
      });
    }
    if (current.adapterOrderId === undefined && requested.adapterOrderId !== undefined) {
      return Object.freeze({ status: "STATUS_CONFLICT", record: current });
    }
    return Object.freeze({ status: "DUPLICATE_SAME", record: current });
  }
  if (!LEGAL_OUTCOME_EDGES[current.status].includes(requested.status)) {
    return Object.freeze({ status: "STATUS_CONFLICT", record: current });
  }
  return Object.freeze({
    status: "APPLIED_TRANSITION",
    record: createIdempotencyRecord({ ...current, status: requested.status,
      updatedAt: requested.updatedAt,
      ...(requested.adapterOrderId === undefined ? {} : { adapterOrderId: requested.adapterOrderId }) }),
  });
}

export type IdempotencyClaimComparison =
  | { readonly status: "CLAIMED_NEW" }
  | { readonly status: "EXISTING_SAME_REQUEST" }
  | { readonly status: "CONFLICT"; readonly reason: "IDEMPOTENCY_CONFLICT" };

/**
 * Persistence contract only. claim MUST atomically create-or-read and must never overwrite a
 * record whose key is paired with a different environment or request fingerprint.
 */
export interface IdempotencyRepository {
  claim(input: IdempotencyClaimInput): Promise<IdempotencyClaimResult>;
  read(adapterId: BrokerAdapterId, idempotencyKey: string): Promise<IdempotencyRecord | undefined>;
  /** MUST reject an update whose environment differs from the originally claimed record. */
  recordOutcome(input: IdempotencyOutcomeInput): Promise<IdempotencyOutcomeResult>;
}

function identifier(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) {
    throw new TypeError(`${field} must be non-empty and have no surrounding whitespace`);
  }
  return value;
}

export function createIdempotencyRecord(input: IdempotencyRecordInput): IdempotencyRecord {
  if (!isExecutionEnvironment(input.environment)) {
    throw new TypeError("Invalid idempotency environment");
  }
  if (!(IDEMPOTENCY_OPERATIONS as readonly string[]).includes(input.operation)) {
    throw new TypeError("Invalid idempotency operation");
  }
  if (!(IDEMPOTENCY_RECORD_STATUSES as readonly string[]).includes(input.status)) {
    throw new TypeError("Invalid idempotency status");
  }
  const createdAt = unixMs(input.createdAt);
  const updatedAt = unixMs(input.updatedAt);
  if (updatedAt < createdAt) throw new RangeError("updatedAt cannot precede createdAt");
  return Object.freeze({
    idempotencyKey: identifier(input.idempotencyKey, "idempotencyKey"),
    adapterId: brokerAdapterId(input.adapterId),
    environment: input.environment,
    executionAttemptId: identifier(input.executionAttemptId, "executionAttemptId"),
    operation: input.operation,
    requestFingerprint: identifier(input.requestFingerprint, "requestFingerprint") as RequestFingerprint,
    status: input.status,
    createdAt,
    updatedAt,
    ...(input.adapterOrderId === undefined
      ? {}
      : { adapterOrderId: identifier(input.adapterOrderId, "adapterOrderId") }),
  });
}

/** Pure model of the comparison an atomic repository claim must perform. */
export function compareIdempotencyClaim(
  existing: IdempotencyRecord | undefined,
  requested: Pick<
    IdempotencyClaimInput,
    "adapterId" | "environment" | "idempotencyKey" | "requestFingerprint"
  >,
): IdempotencyClaimComparison {
  if (existing === undefined) return Object.freeze({ status: "CLAIMED_NEW" });
  if (
    existing.adapterId === requested.adapterId
    && existing.environment === requested.environment
    && existing.idempotencyKey === requested.idempotencyKey
    && existing.requestFingerprint === requested.requestFingerprint
  ) return Object.freeze({ status: "EXISTING_SAME_REQUEST" });
  return Object.freeze({ status: "CONFLICT", reason: "IDEMPOTENCY_CONFLICT" });
}
