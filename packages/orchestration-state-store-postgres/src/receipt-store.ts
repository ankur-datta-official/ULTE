import {
  createExternalOutcomeAdoptionReceipt, createPendingIntentCommitReceipt,
  createTerminalNonSubmissionDispositionReceiptV1, equalCanonicalJson,
  createOrchestrationPendingEffectIdentity, orchestrationOutcomeKey, orchestrationRevision,
  orchestrationSessionId, type ExternalOutcomeAdoptionReceipt,
  type OrchestrationOutcomeKey, type OrchestrationPendingEffectIdentity,
  type OrchestrationRevision, type OrchestrationSessionId, type PendingIntentCommitReceipt,
  terminalNonSubmissionDispositionRef, type TerminalNonSubmissionDispositionReceiptV1,
  type TerminalNonSubmissionDispositionRef,
} from "@ulte/orchestration-state-store";
import { loadExecutionAuthorityCheckpointInTransaction } from "./checkpoint-store.js";
import { loadOutcomeInTransaction } from "./effect-store.js";
import { PersistenceCorruptionError, PersistenceInfrastructureError } from "./errors.js";
import { receiptCheckpointRefs, mapAdoptionReceiptRow, mapPendingReceiptRow,
  type AdoptionReceiptRow, type PendingReceiptRow } from "./receipt-mapping.js";
import type { PostgresExecutor, PostgresQueryResult, PostgresTransaction } from "./postgres.js";
import { mapTerminalReceiptRow, type TerminalReceiptRow } from "./terminal-receipt-mapping.js";

const TERMINAL_COLUMNS = `schema_version, disposition_ref, session_id, adapter_id, environment,
 operation, execution_attempt_id, idempotency_key, request_fingerprint, expected_revision,
 committed_revision, committed_fence, committing_owner_id, unchanged_checkpoint_ref,
 source_event_ref, observed_at_ms, proof_payload, commit_payload`;
const TERMINAL_LOAD_REF = `/* receipt:terminal-ref-load */ SELECT ${TERMINAL_COLUMNS}
 FROM orchestration_terminal_non_submission_disposition WHERE disposition_ref = $1`;
const TERMINAL_LOAD_SESSION = `/* receipt:terminal-session-load */ SELECT ${TERMINAL_COLUMNS}
 FROM orchestration_terminal_non_submission_disposition WHERE session_id = $1`;
const TERMINAL_LOAD_IDENTITY = `/* receipt:terminal-identity-load */ SELECT ${TERMINAL_COLUMNS}
 FROM orchestration_terminal_non_submission_disposition
 WHERE adapter_id = $1 AND environment = $2 AND idempotency_key = $3`;
const TERMINAL_INSERT = `/* receipt:terminal-insert */ INSERT INTO orchestration_terminal_non_submission_disposition
 (${TERMINAL_COLUMNS}) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
 ON CONFLICT DO NOTHING RETURNING ${TERMINAL_COLUMNS}`;

async function terminalReceipt(db: PostgresTransaction, sql: string, params: readonly unknown[]):
  Promise<TerminalNonSubmissionDispositionReceiptV1 | null> {
  const row = atMostOne(await db.query<TerminalReceiptRow>(sql, params), "Terminal receipt load");
  if (row === null) return null;
  const receipt = mapTerminalReceiptRow(row);
  const d = receipt.disposition;
  if (sql === TERMINAL_LOAD_REF && d.dispositionRef !== params[0]
      || sql === TERMINAL_LOAD_SESSION && d.sessionId !== params[0]
      || sql === TERMINAL_LOAD_IDENTITY && (d.pendingEffectIdentity.adapterId !== params[0]
        || d.pendingEffectIdentity.environment !== params[1]
        || d.pendingEffectIdentity.idempotencyKey !== params[2])) {
    throw new PersistenceCorruptionError("Terminal receipt lookup scope mismatch");
  }
  return receipt;
}

/** Historical read only; no lease or commit authority. */
export function loadTerminalNonSubmissionDispositionReceiptInTransaction(db: PostgresTransaction,
  ref: TerminalNonSubmissionDispositionRef): Promise<TerminalNonSubmissionDispositionReceiptV1 | null> {
  return infrastructure(() => terminalReceipt(db, TERMINAL_LOAD_REF, [terminalNonSubmissionDispositionRef(ref)]));
}
export function loadTerminalNonSubmissionDispositionReceiptBySessionInTransaction(db: PostgresTransaction,
  sessionId: OrchestrationSessionId): Promise<TerminalNonSubmissionDispositionReceiptV1 | null> {
  return infrastructure(() => terminalReceipt(db, TERMINAL_LOAD_SESSION, [orchestrationSessionId(sessionId)]));
}
export function loadTerminalNonSubmissionDispositionReceiptByIdentityInTransaction(db: PostgresTransaction,
  adapterId: string, environment: "DRY_RUN" | "SANDBOX", idempotencyKey: string):
  Promise<TerminalNonSubmissionDispositionReceiptV1 | null> {
  if (environment !== "DRY_RUN" && environment !== "SANDBOX") throw new TypeError("Invalid environment");
  return infrastructure(() => terminalReceipt(db, TERMINAL_LOAD_IDENTITY,
    [key(adapterId, "adapterId"), environment, key(idempotencyKey, "idempotencyKey")]));
}

/** Append only; a uniqueness race is read back and compared, never treated as blind success. */
export function appendTerminalNonSubmissionDispositionReceiptInTransaction(db: PostgresTransaction,
  input: TerminalNonSubmissionDispositionReceiptV1): Promise<ReceiptAppendResult<TerminalNonSubmissionDispositionReceiptV1>> {
  const receipt = createTerminalNonSubmissionDispositionReceiptV1(input);
  const d = receipt.disposition, p = d.pendingEffectIdentity;
  return infrastructure(async () => {
    const row = atMostOne(await db.query<TerminalReceiptRow>(TERMINAL_INSERT, [
      receipt.schemaVersion, d.dispositionRef, d.sessionId, p.adapterId, p.environment,
      p.operation, d.executionAttemptId, p.idempotencyKey, p.requestFingerprint,
      d.expectedRecoveryRevision, d.committedRevision, d.committedFence, d.committingOwnerId,
      d.executionAuthorityCheckpointRefBefore, d.proof.sourceEventRef, d.proof.observedAt,
      JSON.stringify(d.proof), JSON.stringify(receipt),
    ]), "Terminal receipt insert");
    if (row !== null) {
      const stored = mapTerminalReceiptRow(row);
      if (!equalCanonicalJson(stored, receipt))
        throw new PersistenceCorruptionError("Terminal receipt insert returned contradictory facts");
      return Object.freeze({ status: "APPENDED", receipt: stored });
    }
    const existing = await terminalReceipt(db, TERMINAL_LOAD_REF, [d.dispositionRef])
      ?? await terminalReceipt(db, TERMINAL_LOAD_SESSION, [d.sessionId])
      ?? await terminalReceipt(db, TERMINAL_LOAD_IDENTITY, [p.adapterId, p.environment, p.idempotencyKey]);
    if (existing === null) throw new PersistenceCorruptionError("Conflicting terminal receipt disappeared");
    return equalCanonicalJson(existing, receipt)
      ? Object.freeze({ status: "DUPLICATE_SAME", receipt: existing })
      : Object.freeze({ status: "RECEIPT_CONFLICT", existing });
  });
}

const PENDING_COLUMNS = `schema_version, adapter_id, idempotency_key, session_id, expected_revision,
 committed_revision, committed_fence, committing_owner_id, previous_checkpoint_ref,
 committed_checkpoint_ref, commit_payload`;
const ADOPTION_COLUMNS = `schema_version, outcome_key, session_id, execution_attempt_id, expected_revision,
 adopted_revision, adopted_fence, adopting_owner_id, previous_checkpoint_ref,
 committed_checkpoint_ref, commit_payload`;
const PENDING_LOAD = `/* receipt:pending-load */ SELECT ${PENDING_COLUMNS}
 FROM orchestration_pending_intent_commit WHERE adapter_id = $1 AND idempotency_key = $2`;
const ADOPTION_LOAD = `/* receipt:adoption-load */ SELECT ${ADOPTION_COLUMNS}
 FROM orchestration_external_outcome_adoption WHERE outcome_key = $1`;
const ADOPTION_CREATION_PROOF_LOAD = `/* receipt:adoption-creation-proof-load */ SELECT ${ADOPTION_COLUMNS}
 FROM orchestration_external_outcome_adoption WHERE session_id = $1 AND adopted_revision = $2`;
const PENDING_INSERT = `/* receipt:pending-insert */ INSERT INTO orchestration_pending_intent_commit (${PENDING_COLUMNS})
 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
 ON CONFLICT (adapter_id, idempotency_key) DO NOTHING RETURNING ${PENDING_COLUMNS}`;
const ADOPTION_INSERT = `/* receipt:adoption-insert */ INSERT INTO orchestration_external_outcome_adoption (${ADOPTION_COLUMNS})
 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
 ON CONFLICT (outcome_key) DO NOTHING RETURNING ${ADOPTION_COLUMNS}`;

export type ReceiptAppendResult<T> =
  | Readonly<{ readonly status: "APPENDED" | "DUPLICATE_SAME"; readonly receipt: T }>
  | Readonly<{ readonly status: "RECEIPT_CONFLICT"; readonly existing: T }>;

export type AdoptionCreationProofLookupResult =
  | Readonly<{ readonly status: "MISSING" }>
  | Readonly<{ readonly status: "FOUND"; readonly receipt: ExternalOutcomeAdoptionReceipt }>;

function atMostOne<Row>(result: PostgresQueryResult<Row>, context: string): Row | null {
  if (result.rowCount !== result.rows.length || result.rows.length > 1 || result.rowCount < 0)
    throw new PersistenceCorruptionError(`${context}: impossible row count`);
  return result.rows[0] ?? null;
}
function key(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value)
    throw new TypeError(`Invalid ${field}`);
  return value;
}
function sameJson(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (left === null || right === null || typeof left !== "object" || typeof right !== "object") return false;
  if (Array.isArray(left) || Array.isArray(right)) return Array.isArray(left) && Array.isArray(right)
    && left.length === right.length && left.every((value, index) => sameJson(value, right[index]));
  const a = Object.keys(left), b = Object.keys(right);
  return a.length === b.length && a.every((field) => Object.prototype.hasOwnProperty.call(right, field)
    && sameJson((left as Record<string, unknown>)[field], (right as Record<string, unknown>)[field]));
}
async function infrastructure<T>(work: () => Promise<T>): Promise<T> {
  try { return await work(); }
  catch (cause) {
    if (cause instanceof PersistenceCorruptionError || cause instanceof PersistenceInfrastructureError) throw cause;
    throw new PersistenceInfrastructureError("PostgreSQL receipt operation failed", { cause });
  }
}
async function checkpoints(db: PostgresTransaction, row: PendingReceiptRow | AdoptionReceiptRow) {
  const [previousRef, committedRef] = receiptCheckpointRefs(row);
  return loadCheckpoints(db, previousRef, committedRef);
}
async function loadCheckpoints(db: PostgresTransaction,
  previousRef: PendingIntentCommitReceipt["previousCheckpointRef"],
  committedRef: PendingIntentCommitReceipt["committedCheckpointRef"]) {
  const previous = await loadExecutionAuthorityCheckpointInTransaction(db, previousRef);
  const committed = await loadExecutionAuthorityCheckpointInTransaction(db, committedRef);
  if (previous === null || committed === null)
    throw new PersistenceCorruptionError("Receipt references a missing checkpoint");
  return [previous, committed] as const;
}
async function pendingFromRow(db: PostgresTransaction, row: PendingReceiptRow): Promise<PendingIntentCommitReceipt> {
  const [previous, committed] = await checkpoints(db, row);
  return mapPendingReceiptRow(row, previous, committed);
}
async function adoptionFromRow(db: PostgresTransaction, row: AdoptionReceiptRow): Promise<ExternalOutcomeAdoptionReceipt> {
  const [previous, committed] = await checkpoints(db, row);
  let outcomeKey: OrchestrationOutcomeKey;
  try { outcomeKey = orchestrationOutcomeKey(row.outcome_key); }
  catch (cause) { throw new PersistenceCorruptionError("Invalid adoption outcome key", { cause }); }
  const outcome = await loadOutcomeInTransaction(db, outcomeKey);
  if (outcome === null) throw new PersistenceCorruptionError("Adoption receipt references a missing outcome");
  return mapAdoptionReceiptRow(row, previous, committed, outcome);
}
async function readPending(db: PostgresTransaction, adapterId: string, idempotencyKey: string): Promise<PendingIntentCommitReceipt | null> {
  const row = atMostOne(await db.query<PendingReceiptRow>(PENDING_LOAD, [adapterId, idempotencyKey]), "Pending receipt load");
  if (row === null) return null;
  const receipt = await pendingFromRow(db, row);
  if (receipt.pendingEffect.adapterId !== adapterId || receipt.pendingEffect.idempotencyKey !== idempotencyKey)
    throw new PersistenceCorruptionError("Pending receipt durable key mismatch");
  return receipt;
}
async function readAdoption(db: PostgresTransaction, outcomeKey: OrchestrationOutcomeKey): Promise<ExternalOutcomeAdoptionReceipt | null> {
  const row = atMostOne(await db.query<AdoptionReceiptRow>(ADOPTION_LOAD, [outcomeKey]), "Adoption receipt load");
  if (row === null) return null;
  const receipt = await adoptionFromRow(db, row);
  if (receipt.outcomeKey !== outcomeKey) throw new PersistenceCorruptionError("Adoption receipt durable key mismatch");
  return receipt;
}

/** Historical read: active lease ownership is deliberately not required. */
export function loadPendingIntentCommitReceiptInTransaction(db: PostgresTransaction, adapterId: string,
  idempotencyKey: string): Promise<PendingIntentCommitReceipt | null> {
  const adapter = key(adapterId, "adapterId"), durableKey = key(idempotencyKey, "idempotencyKey");
  return infrastructure(() => readPending(db, adapter, durableKey));
}
/** Historical read: active lease ownership is deliberately not required. */
export function loadExternalOutcomeAdoptionReceiptInTransaction(db: PostgresTransaction,
  outcomeKey: OrchestrationOutcomeKey): Promise<ExternalOutcomeAdoptionReceipt | null> {
  const validKey = orchestrationOutcomeKey(outcomeKey);
  return infrastructure(() => readAdoption(db, validKey));
}

export function loadAdoptionCreationProofInTransaction(db: PostgresTransaction,
  sessionIdInput: OrchestrationSessionId, createdRevisionInput: OrchestrationRevision,
  pendingIdentityInput: Readonly<OrchestrationPendingEffectIdentity>): Promise<AdoptionCreationProofLookupResult> {
  const sessionId = orchestrationSessionId(sessionIdInput);
  const createdRevision = orchestrationRevision(createdRevisionInput);
  const identity = createOrchestrationPendingEffectIdentity(pendingIdentityInput);
  return infrastructure(async () => {
    const result = await db.query<AdoptionReceiptRow>(ADOPTION_CREATION_PROOF_LOAD, [sessionId, createdRevision]);
    const row = atMostOne(result, "Adoption creation proof lookup");
    if (row === null) return Object.freeze({ status: "MISSING" });
    const receipt = await adoptionFromRow(db, row);
    if (receipt.sessionId !== sessionId || receipt.adoptedRevision !== createdRevision)
      throw new PersistenceCorruptionError("Adoption creation proof durable scope mismatch");
    const next = receipt.nextPendingEffect, nested = receipt.nextPendingCommit;
    if (next === null || nested === null || next.createdRevision !== createdRevision
      || nested.pendingEffect.createdRevision !== createdRevision
      || !samePendingIdentity(next, identity) || !samePendingIdentity(nested.pendingEffect, identity))
      return Object.freeze({ status: "MISSING" });
    return Object.freeze({ status: "FOUND", receipt });
  });
}

function samePendingIdentity(effect: OrchestrationPendingEffectIdentity,
  identity: OrchestrationPendingEffectIdentity): boolean {
  return effect.adapterId === identity.adapterId && effect.environment === identity.environment
    && effect.operation === identity.operation && effect.executionAttemptId === identity.executionAttemptId
    && effect.idempotencyKey === identity.idempotencyKey
    && effect.requestFingerprint === identity.requestFingerprint;
}

/** Append only. The caller must own the transaction and compose recovery/pending mutations. */
export function appendPendingIntentCommitReceiptInTransaction(db: PostgresTransaction,
  input: PendingIntentCommitReceipt): Promise<ReceiptAppendResult<PendingIntentCommitReceipt>> {
  return infrastructure(async () => {
    const [previous, committed] = await loadCheckpoints(db, input.previousCheckpointRef, input.committedCheckpointRef);
    const receipt = createPendingIntentCommitReceipt(input, previous, committed);
    const effect = receipt.pendingEffect;
    const params = [receipt.schemaVersion, effect.adapterId, effect.idempotencyKey, receipt.sessionId,
      receipt.expectedRevision, receipt.committedRevision, receipt.committedFence, receipt.committingOwnerId,
      receipt.previousCheckpointRef, receipt.committedCheckpointRef, JSON.stringify(receipt)];
    const inserted = atMostOne(await db.query<PendingReceiptRow>(PENDING_INSERT, params), "Pending receipt insert");
    if (inserted !== null) {
      const stored = await pendingFromRow(db, inserted);
      if (!sameJson(stored, receipt)) throw new PersistenceCorruptionError("Pending receipt insert returned contradictory facts");
      return Object.freeze({ status: "APPENDED", receipt: stored });
    }
    const existing = await readPending(db, effect.adapterId, effect.idempotencyKey);
    if (existing === null) throw new PersistenceCorruptionError("Conflicting pending receipt disappeared");
    return sameJson(existing, receipt) ? Object.freeze({ status: "DUPLICATE_SAME", receipt: existing })
      : Object.freeze({ status: "RECEIPT_CONFLICT", existing });
  });
}

/** Append only. Nested next-pending payload remains in this DTO; its own receipt is not inserted. */
export function appendExternalOutcomeAdoptionReceiptInTransaction(db: PostgresTransaction,
  input: ExternalOutcomeAdoptionReceipt): Promise<ReceiptAppendResult<ExternalOutcomeAdoptionReceipt>> {
  return infrastructure(async () => {
    const [previous, committed] = await loadCheckpoints(db, input.previousCheckpointRef, input.committedCheckpointRef);
    const outcome = await loadOutcomeInTransaction(db, orchestrationOutcomeKey(input.outcomeKey));
    if (outcome === null) throw new PersistenceCorruptionError("Adoption receipt references a missing outcome");
    const receipt = createExternalOutcomeAdoptionReceipt(input, previous, committed, outcome);
    const params = [receipt.schemaVersion, receipt.outcomeKey, receipt.sessionId, receipt.executionAttemptId,
      receipt.expectedRevision, receipt.adoptedRevision, receipt.adoptedFence, receipt.adoptingOwnerId,
      receipt.previousCheckpointRef, receipt.committedCheckpointRef, JSON.stringify(receipt)];
    const inserted = atMostOne(await db.query<AdoptionReceiptRow>(ADOPTION_INSERT, params), "Adoption receipt insert");
    if (inserted !== null) {
      const stored = await adoptionFromRow(db, inserted);
      if (!sameJson(stored, receipt)) throw new PersistenceCorruptionError("Adoption receipt insert returned contradictory facts");
      return Object.freeze({ status: "APPENDED", receipt: stored });
    }
    const existing = await readAdoption(db, receipt.outcomeKey);
    if (existing === null) throw new PersistenceCorruptionError("Conflicting adoption receipt disappeared");
    return sameJson(existing, receipt) ? Object.freeze({ status: "DUPLICATE_SAME", receipt: existing })
      : Object.freeze({ status: "RECEIPT_CONFLICT", existing });
  });
}

export class PostgresOrchestrationReceiptStore {
  public constructor(private readonly executor: PostgresExecutor) {}
  public loadTerminalNonSubmissionDispositionReceipt(ref: TerminalNonSubmissionDispositionRef):
    Promise<TerminalNonSubmissionDispositionReceiptV1 | null> {
    return loadTerminalNonSubmissionDispositionReceiptInTransaction(this.executor, ref);
  }
  public loadTerminalNonSubmissionDispositionReceiptBySession(sessionId: OrchestrationSessionId):
    Promise<TerminalNonSubmissionDispositionReceiptV1 | null> {
    return loadTerminalNonSubmissionDispositionReceiptBySessionInTransaction(this.executor, sessionId);
  }
  public loadTerminalNonSubmissionDispositionReceiptByIdentity(adapterId: string,
    environment: "DRY_RUN" | "SANDBOX", idempotencyKey: string):
    Promise<TerminalNonSubmissionDispositionReceiptV1 | null> {
    return loadTerminalNonSubmissionDispositionReceiptByIdentityInTransaction(this.executor,
      adapterId, environment, idempotencyKey);
  }
  public loadPendingIntentCommitReceipt(adapterId: string, idempotencyKey: string): Promise<PendingIntentCommitReceipt | null> {
    return loadPendingIntentCommitReceiptInTransaction(this.executor, adapterId, idempotencyKey);
  }
  public loadExternalOutcomeAdoptionReceipt(outcomeKey: OrchestrationOutcomeKey): Promise<ExternalOutcomeAdoptionReceipt | null> {
    return loadExternalOutcomeAdoptionReceiptInTransaction(this.executor, outcomeKey);
  }
}
