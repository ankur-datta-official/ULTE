import { unixMs, type UnixMs } from "@ulte/instrument-model";
import {
  orchestrationFenceToken,
  orchestrationLeaseDurationMs,
  orchestrationLeaseOwnerId,
  orchestrationSessionId,
  type OrchestrationFenceToken,
  type OrchestrationFencedLeaseRequest,
  type OrchestrationHeldLease,
  type OrchestrationLeaseAcquireResult,
  type OrchestrationLeaseReleaseResult,
  type OrchestrationLeaseRenewResult,
  type OrchestrationLeaseRequest,
  type OrchestrationRecoveryLeaseStore,
  type OrchestrationSessionId,
} from "@ulte/orchestration-state-store";
import { PersistenceConflictError, PersistenceCorruptionError, PersistenceInfrastructureError } from "./errors.js";
import { mapLeaseRow, safeLeaseBigint, type LeaseRow, type MappedLeaseRow } from "./lease-mapping.js";
import type { PostgresExecutor, PostgresQueryResult, PostgresTransaction } from "./postgres.js";

const COLUMNS = "session_id, owner_id, fence_token, expires_at_ms";
const CLOCK_SQL = `/* orchestration-state-store-postgres:lease-clock */
SELECT floor(extract(epoch from clock_timestamp()) * 1000)::bigint AS now_ms`;
const INSERT_SQL = `/* orchestration-state-store-postgres:lease-insert */
INSERT INTO orchestration_recovery_lease (${COLUMNS}) VALUES ($1, $2, 1, 0)
ON CONFLICT (session_id) DO NOTHING RETURNING ${COLUMNS}`;
const LOCK_SQL = `/* orchestration-state-store-postgres:lease-lock */
SELECT ${COLUMNS} FROM orchestration_recovery_lease WHERE session_id = $1 FOR UPDATE`;
const STATE_LOCK_SQL = `/* orchestration-state-store-postgres:lease-state-lock */
SELECT session_id, fence_token FROM orchestration_recovery_state WHERE session_id = $1 FOR UPDATE`;
const ACQUIRE_UPDATE_SQL = `/* orchestration-state-store-postgres:lease-acquire-update */
UPDATE orchestration_recovery_lease SET owner_id = $5, fence_token = $6, expires_at_ms = $7
WHERE session_id = $1 AND fence_token = $2
  AND owner_id IS NOT DISTINCT FROM $3 AND expires_at_ms IS NOT DISTINCT FROM $4
  AND (owner_id IS NULL OR expires_at_ms <= $8)
RETURNING ${COLUMNS}`;
const FIRST_FENCE_SQL = `/* orchestration-state-store-postgres:lease-first-fence */
UPDATE orchestration_recovery_lease SET fence_token = $3, expires_at_ms = $4
WHERE session_id = $1 AND owner_id = $2 AND fence_token = 1 AND expires_at_ms = 0
RETURNING ${COLUMNS}`;
const STATE_FENCE_SQL = `/* orchestration-state-store-postgres:lease-state-fence */
UPDATE orchestration_recovery_state SET fence_token = $3
WHERE session_id = $1 AND fence_token = $2
RETURNING session_id, fence_token`;
const RENEW_SQL = `/* orchestration-state-store-postgres:lease-renew */
UPDATE orchestration_recovery_lease SET expires_at_ms = $5
WHERE session_id = $1 AND owner_id = $2 AND fence_token = $3
  AND expires_at_ms > $4
RETURNING ${COLUMNS}`;
const RELEASE_SQL = `/* orchestration-state-store-postgres:lease-release */
UPDATE orchestration_recovery_lease SET owner_id = NULL, expires_at_ms = NULL
WHERE session_id = $1 AND owner_id = $2 AND fence_token = $3
  AND expires_at_ms > $4
RETURNING ${COLUMNS}`;

interface ClockRow { readonly now_ms: unknown }
interface StateFenceRow { readonly session_id: unknown; readonly fence_token: unknown }

function one<Row>(result: PostgresQueryResult<Row>, context: string): Row {
  if (result.rowCount !== 1 || result.rows.length !== 1) {
    throw new PersistenceCorruptionError(`${context} expected one row`);
  }
  return result.rows[0]!;
}

function atMostOne<Row>(result: PostgresQueryResult<Row>, context: string): Row | null {
  if (result.rowCount !== result.rows.length || result.rows.length > 1) {
    throw new PersistenceCorruptionError(`${context} returned an impossible row count`);
  }
  return result.rows[0] ?? null;
}

function matchingLease(row: LeaseRow, sessionId: OrchestrationSessionId): MappedLeaseRow {
  const lease = mapLeaseRow(row);
  if (lease.sessionId !== sessionId) throw new PersistenceCorruptionError("Lease session mismatch");
  return lease;
}

function held(lease: MappedLeaseRow): OrchestrationHeldLease {
  if (lease.ownerId === null || lease.expiresAt === null) {
    throw new PersistenceCorruptionError("Expected held recovery lease");
  }
  return Object.freeze({ sessionId: lease.sessionId, ownerId: lease.ownerId,
    fenceToken: lease.fenceToken, expiresAt: lease.expiresAt });
}

function nextFence(current: number): OrchestrationFenceToken {
  if (current === Number.MAX_SAFE_INTEGER) {
    throw new PersistenceConflictError("LEASE_FENCE_OVERFLOW", "Recovery lease fence cannot exceed MAX_SAFE_INTEGER");
  }
  return orchestrationFenceToken(current + 1);
}

function expiry(now: UnixMs, duration: number): UnixMs {
  const value = now + duration;
  if (!Number.isSafeInteger(value)) throw new PersistenceCorruptionError("Recovery lease expiry exceeds safe UnixMs");
  return unixMs(value);
}

async function dbNow(transaction: PostgresTransaction): Promise<UnixMs> {
  const row = one(await transaction.query<ClockRow>(CLOCK_SQL, []), "Lease clock");
  try {
    return unixMs(safeLeaseBigint(row.now_ms, "now_ms"));
  } catch (cause) {
    throw new PersistenceCorruptionError("Invalid PostgreSQL lease clock", { cause });
  }
}

async function lockedLease(transaction: PostgresTransaction, sessionId: OrchestrationSessionId): Promise<MappedLeaseRow | null> {
  const row = atMostOne(await transaction.query<LeaseRow>(LOCK_SQL, [sessionId]), "Lease lock");
  return row === null ? null : matchingLease(row, sessionId);
}

async function lockedStateFence(transaction: PostgresTransaction, sessionId: OrchestrationSessionId): Promise<OrchestrationFenceToken | null> {
  const row = atMostOne(await transaction.query<StateFenceRow>(STATE_LOCK_SQL, [sessionId]), "Recovery fence lock");
  if (row === null) return null;
  try {
    if (orchestrationSessionId(row.session_id) !== sessionId) throw new TypeError("Session mismatch");
    return orchestrationFenceToken(safeLeaseBigint(row.fence_token, "recovery fence_token"));
  } catch (cause) {
    throw new PersistenceCorruptionError("Invalid recovery-state fence row", { cause });
  }
}

function coherent(lease: MappedLeaseRow, stateFence: OrchestrationFenceToken | null): void {
  if (stateFence !== null && lease.fenceToken !== stateFence) {
    throw new PersistenceCorruptionError("Lease/recovery fence incoherence");
  }
}

async function syncStateFence(transaction: PostgresTransaction, sessionId: OrchestrationSessionId,
  oldFence: OrchestrationFenceToken | null, newFence: OrchestrationFenceToken): Promise<void> {
  if (oldFence === null) return;
  const row = one(await transaction.query<StateFenceRow>(STATE_FENCE_SQL, [sessionId, oldFence, newFence]), "Recovery fence synchronization");
  if (row.session_id !== sessionId || safeLeaseBigint(row.fence_token, "recovery fence_token") !== newFence) {
    throw new PersistenceCorruptionError("Recovery fence synchronization returned inconsistent state");
  }
}

function acquired(lease: MappedLeaseRow): OrchestrationLeaseAcquireResult {
  return Object.freeze({ status: "ACQUIRED", lease: held(lease) });
}

function validRequest(request: OrchestrationLeaseRequest): OrchestrationLeaseRequest {
  return { sessionId: orchestrationSessionId(request.sessionId),
    ownerId: orchestrationLeaseOwnerId(request.ownerId),
    leaseDurationMs: orchestrationLeaseDurationMs(request.leaseDurationMs) };
}

async function infrastructure<T>(work: () => Promise<T>): Promise<T> {
  try { return await work(); }
  catch (cause) {
    if (cause instanceof PersistenceCorruptionError || cause instanceof PersistenceConflictError) throw cause;
    throw new PersistenceInfrastructureError("PostgreSQL recovery lease operation failed", { cause });
  }
}

export class PostgresOrchestrationRecoveryLeaseStore implements OrchestrationRecoveryLeaseStore {
  public constructor(private readonly executor: PostgresExecutor) {}

  public acquireRecoveryLease(request: OrchestrationLeaseRequest): Promise<OrchestrationLeaseAcquireResult> {
    const valid = validRequest(request);
    return infrastructure(() => this.executor.transaction(async (transaction) => {
      // The provisional row is invisible until commit. Uniqueness arbitrates first acquisition.
      const inserted = atMostOne(await transaction.query<LeaseRow>(INSERT_SQL,
        [valid.sessionId, valid.ownerId]), "Lease insert");
      if (inserted !== null) {
        let lease = matchingLease(inserted, valid.sessionId);
        if (lease.ownerId !== valid.ownerId || lease.fenceToken !== 1 || lease.expiresAt !== 0) {
          throw new PersistenceCorruptionError("First lease insert returned inconsistent state");
        }
        const stateFence = await lockedStateFence(transaction, valid.sessionId);
        const now = await dbNow(transaction);
        const expiresAt = expiry(now, valid.leaseDurationMs);
        const newFence = stateFence === null ? orchestrationFenceToken(1) : nextFence(stateFence);
        lease = matchingLease(one(await transaction.query<LeaseRow>(FIRST_FENCE_SQL,
          [valid.sessionId, valid.ownerId, newFence, expiresAt]), "First lease activation"), valid.sessionId);
        if (lease.ownerId !== valid.ownerId || lease.fenceToken !== newFence || lease.expiresAt !== expiresAt) {
          throw new PersistenceCorruptionError("First lease activation returned inconsistent state");
        }
        await syncStateFence(transaction, valid.sessionId, stateFence, newFence);
        return acquired(lease);
      }
      const lease = await lockedLease(transaction, valid.sessionId);
      if (lease === null) throw new PersistenceConflictError("CONCURRENT_LEASE_CONFLICT", "Conflicting lease row disappeared");
      const stateFence = await lockedStateFence(transaction, valid.sessionId);
      coherent(lease, stateFence);
      const now = await dbNow(transaction);
      if (lease.ownerId !== null && lease.expiresAt !== null && lease.expiresAt > now) {
        if (lease.ownerId === valid.ownerId) return acquired(lease);
        return Object.freeze({ status: "HELD_BY_OTHER", expiresAt: lease.expiresAt });
      }
      const newFence = nextFence(lease.fenceToken);
      const expiresAt = expiry(now, valid.leaseDurationMs);
      const updated = matchingLease(one(await transaction.query<LeaseRow>(ACQUIRE_UPDATE_SQL,
        [valid.sessionId, lease.fenceToken, lease.ownerId, lease.expiresAt,
          valid.ownerId, newFence, expiresAt, now]), "Lease takeover"), valid.sessionId);
      if (updated.ownerId !== valid.ownerId || updated.fenceToken !== newFence || updated.expiresAt !== expiresAt) {
        throw new PersistenceCorruptionError("Lease takeover returned inconsistent state");
      }
      await syncStateFence(transaction, valid.sessionId, stateFence, newFence);
      return acquired(updated);
    }));
  }

  public renewRecoveryLease(request: OrchestrationFencedLeaseRequest): Promise<OrchestrationLeaseRenewResult> {
    const valid = validRequest(request);
    const expectedFence = orchestrationFenceToken(request.expectedFence);
    return infrastructure(() => this.executor.transaction(async (transaction) => {
      const lease = await lockedLease(transaction, valid.sessionId);
      if (lease === null) return Object.freeze({ status: "LEASE_LOST" });
      coherent(lease, await lockedStateFence(transaction, valid.sessionId));
      const now = await dbNow(transaction);
      if (lease.ownerId !== valid.ownerId || lease.fenceToken !== expectedFence
        || lease.expiresAt === null || lease.expiresAt <= now) return Object.freeze({ status: "LEASE_LOST" });
      const expiresAt = expiry(now, valid.leaseDurationMs);
      const updated = matchingLease(one(await transaction.query<LeaseRow>(RENEW_SQL,
        [valid.sessionId, valid.ownerId, expectedFence, now, expiresAt]), "Lease renewal"), valid.sessionId);
      if (updated.ownerId !== valid.ownerId || updated.fenceToken !== expectedFence || updated.expiresAt !== expiresAt) {
        throw new PersistenceCorruptionError("Lease renewal returned inconsistent state");
      }
      return Object.freeze({ status: "RENEWED", lease: held(updated) });
    }));
  }

  public releaseRecoveryLease(request: Omit<OrchestrationFencedLeaseRequest, "leaseDurationMs">): Promise<OrchestrationLeaseReleaseResult> {
    const sessionId = orchestrationSessionId(request.sessionId);
    const ownerId = orchestrationLeaseOwnerId(request.ownerId);
    const expectedFence = orchestrationFenceToken(request.expectedFence);
    return infrastructure(() => this.executor.transaction(async (transaction) => {
      const lease = await lockedLease(transaction, sessionId);
      if (lease === null) return Object.freeze({ status: "NOT_HELD" });
      coherent(lease, await lockedStateFence(transaction, sessionId));
      const now = await dbNow(transaction);
      if (lease.ownerId === null) return Object.freeze({ status: "NOT_HELD" });
      if (lease.ownerId !== ownerId || lease.fenceToken !== expectedFence
        || lease.expiresAt === null || lease.expiresAt <= now) return Object.freeze({ status: "LEASE_LOST" });
      const updated = matchingLease(one(await transaction.query<LeaseRow>(RELEASE_SQL,
        [sessionId, ownerId, expectedFence, now]), "Lease release"), sessionId);
      if (updated.ownerId !== null || updated.expiresAt !== null || updated.fenceToken !== expectedFence) {
        throw new PersistenceCorruptionError("Lease release returned inconsistent state");
      }
      return Object.freeze({ status: "RELEASED" });
    }));
  }
}
