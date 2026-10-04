import { brokerAdapterId, fingerprintEntryCancellation, fingerprintEntrySubmission,
  fingerprintProtectionRequest } from "../../packages/broker-adapters/src/index.js";
import { requestEntryCancellation, requestEntrySubmission, requestProtection, restoreExecutionAttemptFromEvidence,
  type ExecutionAttemptRecoveryTransition } from "../../packages/execution-engine/src/index.js";
import { createExecutionAuthorityCheckpoint, createOrchestrationExternalOutcome,
  createOrchestrationPendingEffect, type AdoptOutcomeRequest, type CommitPendingIntentRequest,
  type ExecutionAuthorityCheckpoint, type OrchestrationExternalOutcome,
  type OrchestrationPendingEffect } from "../../packages/orchestration-state-store/src/index.js";
import { PostgresExecutionAuthorityCheckpointStore, PostgresOrchestrationEffectStore } from "../../packages/orchestration-state-store-postgres/src/index.js";
import { checkpointEvidence } from "./phase33b-checkpoint-fixture.js";
import type { B1fDatabase } from "./b1f-postgres-helper.js";

const base = checkpointEvidence();
const capabilities = { supportsClientIdempotency: false, supportsCloseOnlyExit: true,
  supportsNativeBracketProtection: false, supportsProtectionModification: true,
  supportsOrderCancellation: true, supportsPartialFillReporting: true };
const requested = { kind: "ENTRY_SUBMISSION_REQUESTED", adapterCapabilities: capabilities } as const;
const restored = restoreExecutionAttemptFromEvidence(base);
if (restored.status !== "EXECUTION_ATTEMPT_RESTORED") throw new Error("Invalid B1F fixture");
const entry = requestEntrySubmission(restored.executionAttempt, capabilities);
if (entry.status !== "ENTRY_SUBMISSION_READY") throw new Error("Invalid B1F entry fixture");
const entryRequest = entry.request;
const acknowledged = { kind: "ENTRY_SUBMISSION_ACKNOWLEDGED", acknowledgement: {
  executionAttemptId: base.identity.executionAttemptId, idempotencyKey: entryRequest.idempotencyKey,
  adapterOrderId: "order-1", acknowledgedAt: 2_100_101 } } as const;
const rejected = { kind: "ENTRY_SUBMISSION_REJECTED", rejection: {
  executionAttemptId: base.identity.executionAttemptId, idempotencyKey: entryRequest.idempotencyKey,
  adapterReasonCode: "declined", rejectedAt: 2_100_101 } } as const;
const filled = { kind: "ENTRY_FILL_APPLIED", fill: {
  executionAttemptId: base.identity.executionAttemptId, adapterOrderId: "order-1", fillId: "fill-1",
  filledQuantity: "1", fillPrice: entry.request.limitPrice, filledAt: 2_100_102 } } as const;
function checkpoint(ref: string, transitions: readonly ExecutionAttemptRecoveryTransition[]) {
  return createExecutionAuthorityCheckpoint({ schemaVersion: "EXECUTION_AUTHORITY_CHECKPOINT_V1",
    checkpointRef: ref, evidence: { ...base, transitions } });
}
const entryBefore = checkpoint("entry-before", []);
const entryAfter = checkpoint("entry-after", [requested]);
const protectionAttempt = restoreExecutionAttemptFromEvidence({ ...base,
  transitions: [requested, acknowledged, filled] });
if (protectionAttempt.status !== "EXECUTION_ATTEMPT_RESTORED") throw new Error("Invalid protection fixture");
const protection = requestProtection(protectionAttempt.executionAttempt);
if (protection.status !== "PROTECTION_REQUEST_READY") throw new Error("Invalid protection fixture");
const protectionRequest = protection.request;

export function pendingFixture() {
  const pending = createOrchestrationPendingEffect({ schemaVersion: "ORCHESTRATION_PENDING_EFFECT_V1",
    sessionId: "session-1", adapterId: brokerAdapterId("adapter-1"), environment: "SANDBOX",
    operation: "ENTRY_SUBMISSION", executionAttemptId: base.identity.executionAttemptId,
    idempotencyKey: entryRequest.idempotencyKey, requestFingerprint: fingerprintEntrySubmission(entryRequest),
    createdRevision: 2, createdFence: 3, state: "PENDING", resolvedOutcomeKey: null,
    resolvedRevision: null, resolvedFence: null });
  const request: CommitPendingIntentRequest = { sessionId: pending.sessionId,
    ownerId: "owner-1" as CommitPendingIntentRequest["ownerId"],
    expectedRevision: 1 as CommitPendingIntentRequest["expectedRevision"],
    expectedFence: 3 as CommitPendingIntentRequest["expectedFence"],
    previousCheckpointRef: entryBefore.checkpointRef, committedCheckpoint: entryAfter,
    resultingRecoveryState: { mode: "SANDBOX", instrumentId: base.identity.instrumentId,
      executionAuthorityCheckpointRef: entryAfter.checkpointRef, executionAuthorityIdentity: base.identity,
      riskBasisCheckpointRef: null, latestROutcomeRef: null }, pendingEffect: pending };
  return { previous: entryBefore, request };
}

export function cancellationFixture() {
  const previous = checkpoint("fill-before", [requested, acknowledged]);
  const committed = checkpoint("cancel-after", [requested, acknowledged,
    { kind: "ENTRY_CANCELLATION_REQUESTED" }]);
  const attempt = restoreExecutionAttemptFromEvidence({ ...base,
    transitions: [requested, acknowledged] });
  if (attempt.status !== "EXECUTION_ATTEMPT_RESTORED") throw new Error("Invalid cancellation fixture");
  const cancellation = requestEntryCancellation(attempt.executionAttempt);
  if (cancellation.status !== "CANCELLATION_REQUEST_READY") throw new Error("Invalid cancellation request");
  const cancelRequest = cancellation.request;
  const pendingEffect = createOrchestrationPendingEffect({ schemaVersion: "ORCHESTRATION_PENDING_EFFECT_V1",
    sessionId: "session-1", adapterId: brokerAdapterId("adapter-1"), environment: "SANDBOX",
    operation: "ENTRY_CANCELLATION", executionAttemptId: base.identity.executionAttemptId,
    idempotencyKey: cancelRequest.idempotencyKey,
    requestFingerprint: fingerprintEntryCancellation(cancelRequest),
    createdRevision: 2, createdFence: 3, state: "PENDING", resolvedOutcomeKey: null,
    resolvedRevision: null, resolvedFence: null });
  const request: CommitPendingIntentRequest = { sessionId: pendingEffect.sessionId,
    ownerId: "owner-1" as CommitPendingIntentRequest["ownerId"],
    expectedRevision: 1 as CommitPendingIntentRequest["expectedRevision"],
    expectedFence: 3 as CommitPendingIntentRequest["expectedFence"],
    previousCheckpointRef: previous.checkpointRef, committedCheckpoint: committed,
    resultingRecoveryState: { mode: "SANDBOX", instrumentId: base.identity.instrumentId,
      executionAuthorityCheckpointRef: committed.checkpointRef, executionAuthorityIdentity: base.identity,
      riskBasisCheckpointRef: null, latestROutcomeRef: null }, pendingEffect };
  return { previous, request };
}

export function adoptionFixture(kind: "ack" | "rejection" | "fill-next" = "ack") {
  const transition = kind === "ack" ? acknowledged : kind === "rejection" ? rejected : filled;
  const previous = kind === "fill-next" ? checkpoint("fill-before", [requested, acknowledged]) : entryAfter;
  const suffix: ExecutionAttemptRecoveryTransition[] = kind === "fill-next"
    ? [filled, { kind: "PROTECTION_REQUESTED" }] : [transition];
  const committed = checkpoint(`adopt-${kind}`, [...previous.evidence.transitions, ...suffix]);
  const linked = kind === "fill-next" ? null : pendingFixture().request.pendingEffect;
  const pendingEffectIdentity = linked === null ? null : {
    adapterId: linked.adapterId, environment: linked.environment, operation: linked.operation,
    executionAttemptId: linked.executionAttemptId, idempotencyKey: linked.idempotencyKey,
    requestFingerprint: linked.requestFingerprint };
  const outcome = createOrchestrationExternalOutcome({ schemaVersion: "ORCHESTRATION_EXTERNAL_OUTCOME_V1",
    outcomeKey: `outcome-${kind}`, sessionId: "session-1", executionAttemptId: base.identity.executionAttemptId,
    observedAt: 2_100_101, observedFence: 3, pendingEffectIdentity,
    observation: { kind: "CANONICAL_EXECUTION_TRANSITION", transition } });
  const nextPendingEffectIdentity = kind === "fill-next" ? {
    adapterId: brokerAdapterId("adapter-1"), environment: "SANDBOX" as const,
    operation: "PROTECTION_SUBMISSION" as const, executionAttemptId: base.identity.executionAttemptId,
    idempotencyKey: protectionRequest.idempotencyKey,
    requestFingerprint: fingerprintProtectionRequest(protectionRequest) } : null;
  const request: AdoptOutcomeRequest = { sessionId: outcome.sessionId,
    ownerId: "owner-1" as AdoptOutcomeRequest["ownerId"],
    expectedRevision: 1 as AdoptOutcomeRequest["expectedRevision"],
    expectedFence: 3 as AdoptOutcomeRequest["expectedFence"],
    previousCheckpointRef: previous.checkpointRef, outcomeKey: outcome.outcomeKey,
    committedCheckpoint: committed,
    resultingRecoveryState: { mode: "SANDBOX", instrumentId: base.identity.instrumentId,
      executionAuthorityCheckpointRef: committed.checkpointRef, executionAuthorityIdentity: base.identity,
      riskBasisCheckpointRef: null, latestROutcomeRef: null }, nextPendingEffectIdentity };
  return { previous, request, outcome, linked };
}

export async function seed(db: B1fDatabase, previous: ExecutionAuthorityCheckpoint,
  options: { leaseMs?: number; linked?: OrchestrationPendingEffect | null;
    outcomes?: readonly OrchestrationExternalOutcome[] } = {}): Promise<number> {
  const checkpointStore = new PostgresExecutionAuthorityCheckpointStore(db.observer);
  const effectStore = new PostgresOrchestrationEffectStore(db.observer);
  if ((await checkpointStore.appendExecutionAuthorityCheckpoint(previous)).status !== "APPENDED")
    throw new Error("B1F previous checkpoint seed failed");
  const expiresAt = await db.nowMs() + (options.leaseMs ?? 5000);
  await db.observer.query(`INSERT INTO orchestration_recovery_state
    (schema_version, session_id, revision, fence_token, mode, instrument_id,
     execution_authority_checkpoint_ref, execution_attempt_id, execution_plan_id,
     trade_intent_id, candidate_id, execution_instrument_id)
    VALUES ('ORCHESTRATION_RECOVERY_RECORD_V1','session-1',1,3,'SANDBOX',$1,$2,$3,$4,$5,$6,$1)`,
    [base.identity.instrumentId, previous.checkpointRef, base.identity.executionAttemptId,
      base.identity.executionPlanId, base.identity.tradeIntentId, base.identity.candidateId]);
  await db.observer.query(`INSERT INTO orchestration_recovery_lease
    (session_id,owner_id,fence_token,expires_at_ms) VALUES ('session-1','owner-1',3,$1)`, [expiresAt]);
  if (options.linked) {
    const effect = options.linked;
    await db.observer.query(`INSERT INTO orchestration_pending_effect
      (schema_version,session_id,adapter_id,environment,operation,execution_attempt_id,
       idempotency_key,request_fingerprint,created_revision,created_fence,state)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,1,3,'PENDING')`,
    [effect.schemaVersion,effect.sessionId,effect.adapterId,effect.environment,effect.operation,
      effect.executionAttemptId,effect.idempotencyKey,effect.requestFingerprint]);
  }
  for (const outcome of options.outcomes ?? []) {
    if ((await effectStore.appendOutcome(outcome)).status !== "APPENDED")
      throw new Error("B1F outcome seed failed");
  }
  return expiresAt;
}
