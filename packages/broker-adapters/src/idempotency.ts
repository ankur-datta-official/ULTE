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
  recordOutcome(input: IdempotencyOutcomeInput): Promise<IdempotencyRecord>;
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
