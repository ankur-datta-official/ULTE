import {
  IDEMPOTENCY_OPERATIONS,
  brokerAdapterId,
  createIdempotencyRecord,
  isExecutionEnvironment,
  type BrokerAdapterId,
  type IdempotencyClaimInput,
  type IdempotencyClaimResult,
  type IdempotencyOperation,
  type IdempotencyOutcomeInput,
  type IdempotencyRecord,
  type IdempotencyRepository,
} from "@ulte/broker-adapters";
import { unixMs } from "@ulte/instrument-model";
import { PersistenceConflictError, PersistenceCorruptionError } from "./errors.js";
import { mapIdempotencyRow, type IdempotencyRow } from "./mapping.js";
import type { PostgresExecutor, PostgresTransaction } from "./postgres.js";

const RETURNING_COLUMNS = `
  adapter_id, environment, idempotency_key, execution_attempt_id, operation,
  request_fingerprint, status, created_at_ms, updated_at_ms, adapter_order_id`;

const CLAIM_INSERT_SQL = `/* execution-store-postgres:claim-insert */
INSERT INTO broker_idempotency_records (
  adapter_id, environment, idempotency_key, execution_attempt_id, operation,
  request_fingerprint, status, created_at_ms, updated_at_ms, adapter_order_id
) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
ON CONFLICT (adapter_id, environment, idempotency_key) DO NOTHING
RETURNING ${RETURNING_COLUMNS}`;

const CLAIM_SELECT_SQL = `/* execution-store-postgres:claim-select-existing */
SELECT ${RETURNING_COLUMNS}
FROM broker_idempotency_records
WHERE adapter_id = $1 AND environment = $2 AND idempotency_key = $3
FOR UPDATE`;

const READ_SQL = `/* execution-store-postgres:read */
SELECT ${RETURNING_COLUMNS}
FROM broker_idempotency_records
WHERE adapter_id = $1 AND idempotency_key = $2
LIMIT 2`;

const OUTCOME_SELECT_SQL = `/* execution-store-postgres:outcome-select */
SELECT ${RETURNING_COLUMNS}
FROM broker_idempotency_records
WHERE adapter_id = $1 AND environment = $2 AND idempotency_key = $3
FOR UPDATE`;

const OUTCOME_UPDATE_SQL = `/* execution-store-postgres:outcome-update */
UPDATE broker_idempotency_records
SET status = $7,
    updated_at_ms = $8,
    adapter_order_id = COALESCE(adapter_order_id, $9)
WHERE adapter_id = $1
  AND environment = $2
  AND idempotency_key = $3
  AND execution_attempt_id = $4
  AND operation = $5
  AND request_fingerprint = $6
  AND updated_at_ms <= $8
  AND (adapter_order_id IS NULL OR $9 IS NULL OR adapter_order_id = $9)
RETURNING ${RETURNING_COLUMNS}`;

type OutcomeWithIdentityAssertions = IdempotencyOutcomeInput & {
  readonly executionAttemptId?: string;
  readonly operation?: IdempotencyOperation;
};

const OUTCOME_STATUSES: readonly IdempotencyOutcomeInput["status"][] = Object.freeze([
  "SUBMITTED",
  "CONFIRMED",
  "REJECTED",
  "OUTCOME_UNKNOWN",
  "RETRY_AUTHORIZED",
  "FAILED_NOT_SUBMITTED",
]);

function identifier(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) {
    throw new TypeError(`${field} must be non-empty and have no surrounding whitespace`);
  }
  return value;
}

function oneRow(rows: readonly IdempotencyRow[], context: string): IdempotencyRecord {
  if (rows.length !== 1) {
    throw new PersistenceCorruptionError(`${context} expected exactly one durable row`);
  }
  return mapIdempotencyRow(rows[0]!);
}

function sameClaimIdentity(record: IdempotencyRecord, input: IdempotencyClaimInput): boolean {
  return record.adapterId === input.adapterId
    && record.environment === input.environment
    && record.idempotencyKey === input.idempotencyKey
    && record.executionAttemptId === input.executionAttemptId
    && record.operation === input.operation
    && record.requestFingerprint === input.requestFingerprint;
}

function validateClaim(input: IdempotencyClaimInput): IdempotencyRecord {
  return createIdempotencyRecord({
    adapterId: input.adapterId,
    environment: input.environment,
    idempotencyKey: input.idempotencyKey,
    executionAttemptId: input.executionAttemptId,
    operation: input.operation,
    requestFingerprint: input.requestFingerprint,
    status: "CLAIMED",
    createdAt: input.claimedAt,
    updatedAt: input.claimedAt,
  });
}

function validateOutcome(input: OutcomeWithIdentityAssertions): void {
  brokerAdapterId(input.adapterId);
  if (!isExecutionEnvironment(input.environment)) throw new TypeError("Invalid idempotency environment");
  identifier(input.idempotencyKey, "idempotencyKey");
  identifier(input.requestFingerprint, "requestFingerprint");
  unixMs(input.updatedAt);
  if (!OUTCOME_STATUSES.includes(input.status)) {
    throw new TypeError("Invalid idempotency outcome status");
  }
  if (input.executionAttemptId !== undefined) identifier(input.executionAttemptId, "executionAttemptId");
  if (
    input.operation !== undefined
    && !(IDEMPOTENCY_OPERATIONS as readonly string[]).includes(input.operation)
  ) throw new TypeError("Invalid idempotency operation");
}

export class PostgresIdempotencyRepository implements IdempotencyRepository {
  public constructor(private readonly executor: PostgresExecutor) {}

  public claim(input: IdempotencyClaimInput): Promise<IdempotencyClaimResult> {
    const candidate = validateClaim(input);
    return this.executor.transaction(async (transaction) => {
      const inserted = await transaction.query<IdempotencyRow>(CLAIM_INSERT_SQL, [
        candidate.adapterId,
        candidate.environment,
        candidate.idempotencyKey,
        candidate.executionAttemptId,
        candidate.operation,
        candidate.requestFingerprint,
        candidate.status,
        candidate.createdAt,
        candidate.updatedAt,
        null,
      ]);
      if (inserted.rows.length === 1) {
        return Object.freeze({ status: "CLAIMED_NEW", record: mapIdempotencyRow(inserted.rows[0]!) });
      }
      if (inserted.rows.length !== 0) {
        throw new PersistenceCorruptionError("Claim insert returned an unexpected row count");
      }
      const selected = await transaction.query<IdempotencyRow>(CLAIM_SELECT_SQL, [
        candidate.adapterId,
        candidate.environment,
        candidate.idempotencyKey,
      ]);
      const existing = oneRow(selected.rows, "Conflicting claim lookup");
      if (sameClaimIdentity(existing, input)) {
        return Object.freeze({ status: "EXISTING_SAME_REQUEST", record: existing });
      }
      return Object.freeze({
        status: "CONFLICT",
        reason: "IDEMPOTENCY_CONFLICT",
        record: existing,
      });
    });
  }

  public async read(
    adapterId: BrokerAdapterId,
    idempotencyKey: string,
  ): Promise<IdempotencyRecord | undefined> {
    const validAdapterId = brokerAdapterId(adapterId);
    const validKey = identifier(idempotencyKey, "idempotencyKey");
    const result = await this.executor.query<IdempotencyRow>(READ_SQL, [validAdapterId, validKey]);
    if (result.rows.length === 0) return undefined;
    if (result.rows.length > 1) {
      throw new PersistenceConflictError(
        "AMBIGUOUS_ENVIRONMENT",
        "read(adapterId, idempotencyKey) is ambiguous across execution environments",
      );
    }
    return mapIdempotencyRow(result.rows[0]!);
  }

  public recordOutcome(input: OutcomeWithIdentityAssertions): Promise<IdempotencyRecord> {
    validateOutcome(input);
    return this.executor.transaction(async (transaction: PostgresTransaction) => {
      const selected = await transaction.query<IdempotencyRow>(OUTCOME_SELECT_SQL, [
        input.adapterId,
        input.environment,
        input.idempotencyKey,
      ]);
      if (selected.rows.length === 0) {
        throw new RangeError("Cannot record an outcome for an unclaimed durable identity");
      }
      const current = oneRow(selected.rows, "Outcome lookup");
      if (
        current.adapterId !== input.adapterId
        || current.environment !== input.environment
        || current.idempotencyKey !== input.idempotencyKey
        || current.requestFingerprint !== input.requestFingerprint
        || (input.executionAttemptId !== undefined
          && current.executionAttemptId !== input.executionAttemptId)
        || (input.operation !== undefined && current.operation !== input.operation)
      ) {
        throw new PersistenceConflictError(
          "IMMUTABLE_IDENTITY_CONFLICT",
          "Outcome identity does not match the claimed durable request",
        );
      }
      if (input.updatedAt < current.updatedAt) {
        throw new PersistenceConflictError(
          "MONOTONIC_TIME_VIOLATION",
          "updatedAt cannot move backwards",
        );
      }
      if (
        current.adapterOrderId !== undefined
        && input.adapterOrderId !== undefined
        && current.adapterOrderId !== input.adapterOrderId
      ) {
        throw new PersistenceConflictError(
          "ADAPTER_ORDER_ID_CONFLICT",
          "adapterOrderId cannot replace an existing durable identifier",
        );
      }
      const updated = await transaction.query<IdempotencyRow>(OUTCOME_UPDATE_SQL, [
        current.adapterId,
        current.environment,
        current.idempotencyKey,
        current.executionAttemptId,
        current.operation,
        current.requestFingerprint,
        input.status,
        input.updatedAt,
        input.adapterOrderId ?? null,
      ]);
      if (updated.rows.length !== 1) {
        throw new PersistenceConflictError(
          "IMMUTABLE_IDENTITY_CONFLICT",
          "Conditional outcome update rejected a concurrent identity or monotonicity change",
        );
      }
      return mapIdempotencyRow(updated.rows[0]!);
    });
  }
}

export function createPostgresIdempotencyRepository(
  executor: PostgresExecutor,
): PostgresIdempotencyRepository {
  return new PostgresIdempotencyRepository(executor);
}
