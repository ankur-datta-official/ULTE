import {
  createOrchestrationExternalOutcome, createOrchestrationPendingEffect,
  createOrchestrationPendingEffectIdentity, orchestrationOutcomeKey, orchestrationRevision,
  orchestrationFenceToken, orchestrationSessionId,
  type OrchestrationExternalOutcome, type OrchestrationOutcomeAppendResult,
  type OrchestrationOutcomeKey, type OrchestrationPendingEffect,
  type OrchestrationPendingEffectCreateResult, type OrchestrationPendingEffectIdentity,
  type OrchestrationPendingEffectResolutionRequest, type OrchestrationPendingEffectResolutionResult,
  type OrchestrationSessionId,
} from "@ulte/orchestration-state-store";
import { PersistenceCorruptionError, PersistenceInfrastructureError } from "./errors.js";
import { mapOutcomeRow, mapPendingRow, type OutcomeRow, type PendingRow } from "./effect-mapping.js";
import type { PostgresExecutor, PostgresQueryResult, PostgresTransaction } from "./postgres.js";

const PENDING_COLUMNS = `schema_version, session_id, adapter_id, environment, operation,
 execution_attempt_id, idempotency_key, request_fingerprint, created_revision, created_fence,
 state, resolution_kind, resolved_authority_ref, resolved_revision, resolved_fence`;
const OUTCOME_COLUMNS = `schema_version, outcome_key, session_id, execution_attempt_id,
 observed_at_ms, observed_fence, pending_adapter_id, pending_environment, pending_operation,
 pending_execution_attempt_id, pending_idempotency_key, pending_request_fingerprint,
 observation_kind, observation_payload`;
const PENDING_LOAD = `/* effect:pending-load */ SELECT ${PENDING_COLUMNS} FROM orchestration_pending_effect
 WHERE adapter_id = $1 AND idempotency_key = $2`;
const PENDING_LOCK = `${PENDING_LOAD} FOR UPDATE`;
const PENDING_LIST = `/* effect:pending-list */ SELECT ${PENDING_COLUMNS} FROM orchestration_pending_effect
 WHERE session_id = $1 AND state = 'PENDING'
 ORDER BY created_revision ASC, adapter_id ASC, idempotency_key ASC`;
const PENDING_INSERT = `/* effect:pending-insert */ INSERT INTO orchestration_pending_effect (${PENDING_COLUMNS})
 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
 ON CONFLICT (adapter_id, idempotency_key) DO NOTHING RETURNING ${PENDING_COLUMNS}`;
const PENDING_RESOLVE = `/* effect:pending-resolve */ UPDATE orchestration_pending_effect
 SET state = 'RESOLVED', resolution_kind = 'EXTERNAL_OUTCOME', resolved_authority_ref = $3,
   resolved_revision = $4, resolved_fence = $5
 WHERE adapter_id = $1 AND idempotency_key = $2 AND state = 'PENDING'
   AND session_id = $6 AND environment = $7 AND operation = $8
   AND execution_attempt_id = $9 AND request_fingerprint = $10
 RETURNING ${PENDING_COLUMNS}`;
const OUTCOME_LOAD = `/* effect:outcome-load */ SELECT ${OUTCOME_COLUMNS} FROM orchestration_external_outcome WHERE outcome_key = $1`;
const OUTCOME_LIST = `/* effect:outcome-list */ SELECT ${OUTCOME_COLUMNS} FROM orchestration_external_outcome
 WHERE session_id = $1 AND execution_attempt_id = $2 ORDER BY observed_at_ms ASC, outcome_key ASC`;
const OUTCOME_INSERT = `/* effect:outcome-insert */ INSERT INTO orchestration_external_outcome (${OUTCOME_COLUMNS})
 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
 ON CONFLICT (outcome_key) DO NOTHING RETURNING ${OUTCOME_COLUMNS}`;

function atMostOne<Row>(result: PostgresQueryResult<Row>, context: string): Row | null {
  if (result.rowCount !== result.rows.length || result.rows.length > 1)
    throw new PersistenceCorruptionError(`${context}: impossible row count`);
  return result.rows[0] ?? null;
}
function all<Row>(result: PostgresQueryResult<Row>, context: string): readonly Row[] {
  if (result.rowCount !== result.rows.length) throw new PersistenceCorruptionError(`${context}: impossible row count`);
  return result.rows;
}
function sameIdentity(a: OrchestrationPendingEffectIdentity, b: OrchestrationPendingEffectIdentity): boolean {
  return a.adapterId === b.adapterId && a.environment === b.environment && a.operation === b.operation
    && a.executionAttemptId === b.executionAttemptId && a.idempotencyKey === b.idempotencyKey
    && a.requestFingerprint === b.requestFingerprint;
}
function sameCreation(a: OrchestrationPendingEffect, b: OrchestrationPendingEffect): boolean {
  return a.schemaVersion === b.schemaVersion && a.sessionId === b.sessionId && sameIdentity(a, b)
    && a.createdRevision === b.createdRevision && a.createdFence === b.createdFence;
}
function sameJson(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return false;
  if (Array.isArray(a) || Array.isArray(b)) return Array.isArray(a) && Array.isArray(b)
    && a.length === b.length && a.every((value, index) => sameJson(value, b[index]));
  const left = Object.entries(a), right = Object.entries(b);
  return left.length === right.length && left.every(([key, value]) =>
    Object.prototype.hasOwnProperty.call(b, key) && sameJson(value, Object.getOwnPropertyDescriptor(b, key)?.value));
}
function sameOutcome(a: OrchestrationExternalOutcome, b: OrchestrationExternalOutcome): boolean {
  return a.schemaVersion === b.schemaVersion && a.outcomeKey === b.outcomeKey
    && a.sessionId === b.sessionId && a.executionAttemptId === b.executionAttemptId
    && a.observedAt === b.observedAt && a.observedFence === b.observedFence
    && (a.pendingEffectIdentity === null && b.pendingEffectIdentity === null
      || a.pendingEffectIdentity !== null && b.pendingEffectIdentity !== null
      && sameIdentity(a.pendingEffectIdentity, b.pendingEffectIdentity))
    && sameJson(a.observation, b.observation);
}
function pendingValues(effect: OrchestrationPendingEffect): readonly unknown[] {
  return [effect.schemaVersion, effect.sessionId, effect.adapterId, effect.environment, effect.operation,
    effect.executionAttemptId, effect.idempotencyKey, effect.requestFingerprint,
    effect.createdRevision, effect.createdFence, effect.state,
    effect.schemaVersion === "ORCHESTRATION_PENDING_EFFECT_V2" ? effect.resolutionKind : null,
    effect.schemaVersion === "ORCHESTRATION_PENDING_EFFECT_V2" ? effect.resolvedAuthorityRef : null,
    effect.resolvedRevision, effect.resolvedFence];
}
function outcomeValues(outcome: OrchestrationExternalOutcome): readonly unknown[] {
  const pending = outcome.pendingEffectIdentity;
  return [outcome.schemaVersion, outcome.outcomeKey, outcome.sessionId, outcome.executionAttemptId,
    outcome.observedAt, outcome.observedFence, pending?.adapterId ?? null, pending?.environment ?? null,
    pending?.operation ?? null, pending?.executionAttemptId ?? null, pending?.idempotencyKey ?? null,
    pending?.requestFingerprint ?? null, outcome.observation.kind,
    JSON.stringify(outcome.observation.kind === "CANONICAL_EXECUTION_TRANSITION"
      ? outcome.observation.transition : outcome.observation.disposition)];
}
async function readPending(db: PostgresTransaction, identity: OrchestrationPendingEffectIdentity,
  lock: boolean, requireIdentity = true): Promise<OrchestrationPendingEffect | null> {
  const row = atMostOne(await db.query<PendingRow>(lock ? PENDING_LOCK : PENDING_LOAD,
    [identity.adapterId, identity.idempotencyKey]), "Pending lookup");
  if (row === null) return null;
  const effect = mapPendingRow(row);
  if (effect.adapterId !== identity.adapterId || effect.idempotencyKey !== identity.idempotencyKey
    || requireIdentity && !sameIdentity(effect, identity))
    throw new PersistenceCorruptionError("Pending durable key has contradictory identity");
  return effect;
}
/** Caller-owned transaction lock; the caller decides whether a key collision is corruption or conflict. */
export function loadPendingEffectForUpdateInTransaction(transaction: PostgresTransaction,
  input: OrchestrationPendingEffectIdentity): Promise<OrchestrationPendingEffect | null> {
  const identity = createOrchestrationPendingEffectIdentity(input);
  return infrastructure(() => readPending(transaction, identity, true, false));
}
async function readOutcome(db: PostgresTransaction, key: OrchestrationOutcomeKey): Promise<OrchestrationExternalOutcome | null> {
  const row = atMostOne(await db.query<OutcomeRow>(OUTCOME_LOAD, [key]), "Outcome lookup");
  if (row === null) return null;
  const outcome = mapOutcomeRow(row);
  if (outcome.outcomeKey !== key) throw new PersistenceCorruptionError("Outcome durable key mismatch");
  return outcome;
}

async function readUnresolved(db: PostgresTransaction, sessionId: OrchestrationSessionId):
  Promise<readonly OrchestrationPendingEffect[]> {
  const rows = all(await db.query<PendingRow>(PENDING_LIST, [sessionId]), "Unresolved list");
  return Object.freeze(rows.map((row) => {
    const effect = mapPendingRow(row);
    if (effect.sessionId !== sessionId || effect.state !== "PENDING")
      throw new PersistenceCorruptionError("Unresolved list returned contradictory row");
    return effect;
  }));
}

export function listUnresolvedEffectsInTransaction(transaction: PostgresTransaction,
  input: OrchestrationSessionId): Promise<readonly OrchestrationPendingEffect[]> {
  const sessionId = orchestrationSessionId(input);
  return infrastructure(() => readUnresolved(transaction, sessionId));
}

async function readExecutionOutcomes(db: PostgresTransaction, sessionId: OrchestrationSessionId,
  attempt: string): Promise<readonly OrchestrationExternalOutcome[]> {
  const rows = all(await db.query<OutcomeRow>(OUTCOME_LIST, [sessionId, attempt]), "Outcome list");
  return Object.freeze(rows.map((row) => {
    const outcome = mapOutcomeRow(row);
    if (outcome.sessionId !== sessionId || outcome.executionAttemptId !== attempt)
      throw new PersistenceCorruptionError("Outcome list returned contradictory row");
    return outcome;
  }));
}

export function listExecutionOutcomesInTransaction(transaction: PostgresTransaction,
  input: OrchestrationSessionId, executionAttemptId: string): Promise<readonly OrchestrationExternalOutcome[]> {
  const sessionId = orchestrationSessionId(input);
  if (typeof executionAttemptId !== "string" || executionAttemptId.length === 0
    || executionAttemptId.trim() !== executionAttemptId) throw new TypeError("Invalid executionAttemptId");
  return infrastructure(() => readExecutionOutcomes(transaction, sessionId, executionAttemptId));
}

/** Reuses the public outcome loader and mapper inside a caller-owned transaction. */
export function loadOutcomeInTransaction(transaction: PostgresTransaction,
  input: OrchestrationOutcomeKey): Promise<OrchestrationExternalOutcome | null> {
  const key = orchestrationOutcomeKey(input);
  return infrastructure(() => readOutcome(transaction, key));
}
/** Appends through the caller's transaction without authorizing lease or pending state. */
export function appendOutcomeInTransaction(transaction: PostgresTransaction,
  input: OrchestrationExternalOutcome): Promise<OrchestrationOutcomeAppendResult> {
  const outcome = createOrchestrationExternalOutcome(input);
  return infrastructure(() => appendOutcome(transaction, outcome));
}
async function appendOutcome(db: PostgresTransaction,
  outcome: OrchestrationExternalOutcome): Promise<OrchestrationOutcomeAppendResult> {
  const inserted = atMostOne(await db.query<OutcomeRow>(OUTCOME_INSERT, outcomeValues(outcome)), "Outcome insert");
  if (inserted !== null) {
    const stored = mapOutcomeRow(inserted);
    if (!sameOutcome(stored, outcome)) throw new PersistenceCorruptionError("Outcome insert returned contradictory facts");
    return Object.freeze({ status: "APPENDED", outcome: stored });
  }
  const existing = await readOutcome(db, outcome.outcomeKey);
  if (existing === null) throw new PersistenceCorruptionError("Conflicting outcome row disappeared");
  return sameOutcome(existing, outcome)
    ? Object.freeze({ status: "DUPLICATE_SAME", outcome: existing })
    : Object.freeze({ status: "OUTCOME_CONFLICT", existing });
}
async function infrastructure<T>(work: () => Promise<T>): Promise<T> {
  try { return await work(); }
  catch (cause) {
    if (cause instanceof PersistenceCorruptionError || cause instanceof PersistenceInfrastructureError) throw cause;
    throw new PersistenceInfrastructureError("PostgreSQL pending effect/outcome operation failed", { cause });
  }
}

/** B1E supplies the transaction after it has authorized the recovery revision and lease fence. */
export async function createPendingEffectInTransaction(transaction: PostgresTransaction,
  input: OrchestrationPendingEffect): Promise<OrchestrationPendingEffectCreateResult> {
  const effect = createOrchestrationPendingEffect(input);
  if (effect.state !== "PENDING") throw new TypeError("Creation requires a PENDING effect");
  return infrastructure(async () => {
    const inserted = atMostOne(await transaction.query<PendingRow>(PENDING_INSERT, pendingValues(effect)), "Pending insert");
    if (inserted !== null) {
      const stored = mapPendingRow(inserted);
      if (!sameCreation(stored, effect) || stored.state !== "PENDING")
        throw new PersistenceCorruptionError("Pending insert returned contradictory facts");
      return Object.freeze({ status: "CREATED", effect: stored });
    }
    const existing = await readPending(transaction, effect, true, false);
    if (existing === null) throw new PersistenceCorruptionError("Conflicting pending row disappeared");
    return sameCreation(existing, effect)
      ? Object.freeze({ status: "DUPLICATE_SAME", effect: existing })
      : Object.freeze({ status: "EFFECT_CONFLICT", existing });
  });
}

/** B1E owns aggregate application and authorization in the surrounding transaction. */
export async function resolvePendingEffectInTransaction(transaction: PostgresTransaction,
  request: OrchestrationPendingEffectResolutionRequest): Promise<OrchestrationPendingEffectResolutionResult> {
  const sessionId = orchestrationSessionId(request.sessionId);
  const identity = createOrchestrationPendingEffectIdentity(request.pendingEffectIdentity);
  const outcomeKey = orchestrationOutcomeKey(request.outcomeKey);
  const revision = orchestrationRevision(request.expectedRevision);
  const fence = orchestrationFenceToken(request.expectedFence);
  return infrastructure(async () => {
    const current = await readPending(transaction, identity, true);
    if (current === null) return Object.freeze({ status: "NOT_FOUND" });
    if (current.sessionId !== sessionId) throw new PersistenceCorruptionError("Pending session mismatch");
    const outcome = await readOutcome(transaction, outcomeKey);
    if (outcome === null) return Object.freeze({ status: "OUTCOME_NOT_FOUND" });
    if (outcome.sessionId !== sessionId || outcome.executionAttemptId !== identity.executionAttemptId
      || outcome.pendingEffectIdentity === null || !sameIdentity(outcome.pendingEffectIdentity, identity))
      throw new PersistenceCorruptionError("Contradictory outcome linkage");
    if (current.state === "RESOLVED") {
      if (current.resolvedOutcomeKey === outcomeKey && current.resolvedRevision === revision && current.resolvedFence === fence)
        return Object.freeze({ status: "ALREADY_RESOLVED", effect: current });
      throw new PersistenceCorruptionError("Contradictory second pending resolution");
    }
    if (revision < current.createdRevision) throw new PersistenceCorruptionError("Resolution precedes creation");
    const row = atMostOne(await transaction.query<PendingRow>(PENDING_RESOLVE,
      [identity.adapterId, identity.idempotencyKey, outcomeKey, revision, fence, sessionId,
        identity.environment, identity.operation, identity.executionAttemptId, identity.requestFingerprint]),
    "Pending resolution update");
    if (row === null) throw new PersistenceCorruptionError("Conditional pending resolution updated zero rows");
    const resolved = mapPendingRow(row);
    if (!sameCreation(resolved, current) || resolved.state !== "RESOLVED"
      || resolved.resolvedOutcomeKey !== outcomeKey || resolved.resolvedRevision !== revision || resolved.resolvedFence !== fence)
      throw new PersistenceCorruptionError("Pending resolution returned contradictory facts");
    return Object.freeze({ status: "RESOLVED", effect: resolved });
  });
}

export class PostgresOrchestrationEffectStore {
  public constructor(private readonly executor: PostgresExecutor) {}

  public loadPendingEffect(input: Readonly<OrchestrationPendingEffectIdentity>): Promise<OrchestrationPendingEffect | null> {
    const identity = createOrchestrationPendingEffectIdentity(input);
    return infrastructure(() => readPending(this.executor, identity, false));
  }
  public listUnresolvedEffects(input: OrchestrationSessionId): Promise<readonly OrchestrationPendingEffect[]> {
    return listUnresolvedEffectsInTransaction(this.executor, input);
  }
  public loadOutcome(input: OrchestrationOutcomeKey): Promise<OrchestrationExternalOutcome | null> {
    const key = orchestrationOutcomeKey(input);
    return infrastructure(() => readOutcome(this.executor, key));
  }
  public listExecutionOutcomes(input: OrchestrationSessionId, attempt: string): Promise<readonly OrchestrationExternalOutcome[]> {
    return listExecutionOutcomesInTransaction(this.executor, input, attempt);
  }
  public appendOutcome(input: OrchestrationExternalOutcome): Promise<OrchestrationOutcomeAppendResult> {
    const outcome = createOrchestrationExternalOutcome(input);
    return infrastructure(() => appendOutcome(this.executor, outcome));
  }
}
