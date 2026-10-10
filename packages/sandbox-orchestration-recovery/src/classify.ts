import type {
  OrchestrationExternalOutcome,
  OrchestrationPendingEffect,
  OrchestrationPendingEffectIdentity,
} from "@ulte/orchestration-state-store";
import { createTerminalNonSubmissionDispositionReceiptV1, equalCanonicalJson } from "@ulte/orchestration-state-store";
import type {
  LoadedExternalOutcome,
  LoadedPendingEffect,
  PendingCreationRef,
  RecoveryBootAuthorityRef,
  RecoveryBootClassifierInput,
  RecoveryBootRejectionReason,
  RecoveryBootResult,
} from "./types.js";

type Rejected = Extract<RecoveryBootResult, { readonly status: "RECOVERY_REJECTED" }>;
type Candidate = Extract<RecoveryBootResult, { readonly status: "RECONCILIATION_REQUIRED"
  | "CANONICAL_OUTCOME_REQUIRED" | "OUTCOME_AVAILABLE" | "INTENT_DISPOSITION_REQUIRED" }>;

function sameIdentity(a: OrchestrationPendingEffectIdentity, b: OrchestrationPendingEffectIdentity): boolean {
  return a.adapterId === b.adapterId && a.environment === b.environment
    && a.operation === b.operation && a.executionAttemptId === b.executionAttemptId
    && a.idempotencyKey === b.idempotencyKey && a.requestFingerprint === b.requestFingerprint;
}

function sameEffect(a: OrchestrationPendingEffect, b: OrchestrationPendingEffect): boolean {
  return sameIdentity(a, b) && a.sessionId === b.sessionId
    && a.createdRevision === b.createdRevision && a.createdFence === b.createdFence
    && a.state === b.state && a.resolvedOutcomeKey === b.resolvedOutcomeKey
    && a.resolvedRevision === b.resolvedRevision && a.resolvedFence === b.resolvedFence;
}

function effectKey(identity: OrchestrationPendingEffectIdentity): string {
  return `${identity.adapterId}\u0000${identity.idempotencyKey}`;
}

function authority(input: RecoveryBootClassifierInput): RecoveryBootAuthorityRef {
  return Object.freeze({ sessionId: input.recovery.sessionId, ownerId: input.ownerId,
    fenceToken: input.recovery.fenceToken, recoveryRevision: input.recovery.revision,
    checkpointRef: input.recovery.executionAuthorityCheckpointRef });
}

function reject(ref: RecoveryBootAuthorityRef, reason: RecoveryBootRejectionReason,
  pendingEffectIdentity?: OrchestrationPendingEffectIdentity,
  outcomeKey?: OrchestrationExternalOutcome["outcomeKey"]): Rejected {
  return Object.freeze({ ...ref, status: "RECOVERY_REJECTED", reason,
    ...(pendingEffectIdentity === undefined ? {} : { pendingEffectIdentity }),
    ...(outcomeKey === undefined ? {} : { outcomeKey }) });
}

function creationRef(loaded: LoadedPendingEffect): PendingCreationRef | null {
  const proof = loaded.creationProof;
  if (proof === null) return null;
  const effect = loaded.effect;
  if (proof.kind === "PENDING_INTENT_COMMIT") {
    const receipt = proof.receipt;
    if (!sameEffect(receipt.pendingEffect, effect) || receipt.sessionId !== effect.sessionId
        || receipt.committedRevision !== effect.createdRevision
        || receipt.committedFence !== effect.createdFence) return null;
    return Object.freeze({ kind: proof.kind, committedCheckpointRef: receipt.committedCheckpointRef,
      committedRevision: receipt.committedRevision });
  }
  const receipt = proof.receipt;
  if (receipt.nextPendingEffect === null || receipt.nextPendingCommit === null
      || !sameEffect(receipt.nextPendingEffect, effect)
      || !sameEffect(receipt.nextPendingCommit.pendingEffect, effect)
      || receipt.sessionId !== effect.sessionId || receipt.adoptedRevision !== effect.createdRevision
      || receipt.adoptedFence !== effect.createdFence
      || receipt.nextPendingCommit.committedCheckpointRef !== receipt.committedCheckpointRef) return null;
  return Object.freeze({ kind: proof.kind, committedCheckpointRef: receipt.committedCheckpointRef,
    committedRevision: receipt.adoptedRevision });
}

function candidatePriority(result: Candidate): number {
  switch (result.status) {
    case "RECONCILIATION_REQUIRED": return 4;
    case "CANONICAL_OUTCOME_REQUIRED": return 3;
    case "OUTCOME_AVAILABLE": return 2;
    case "INTENT_DISPOSITION_REQUIRED": return 1;
  }
}

function terminalResult(input: RecoveryBootClassifierInput, ref: RecoveryBootAuthorityRef):
  RecoveryBootResult | null {
  const terminal = input.terminal;
  const recovery = input.recovery;
  if (recovery.schemaVersion !== "ORCHESTRATION_RECOVERY_RECORD_V2") {
    return terminal === undefined || terminal.receipt === null && terminal.resolvedEffects.length === 0
      ? null : reject(ref, "PERSISTENCE_CORRUPTION");
  }
  if (terminal === undefined || terminal.receipt === null || terminal.pending === null
      || terminal.creationProof === null || terminal.creationCheckpoint === null
      || terminal.idempotency.status !== "PRESENT" || terminal.leaseFence !== ref.fenceToken
      || input.evidence !== "COMPLETE" || input.checkpoint.status !== "VALID")
    return reject(ref, "PERSISTENCE_CORRUPTION");
  try {
    const receipt = createTerminalNonSubmissionDispositionReceiptV1(terminal.receipt);
    const d = receipt.disposition;
    const p = terminal.pending;
    const broker = terminal.idempotency.record;
    const checkpoint = input.checkpoint.checkpoint;
    const creation = terminal.creationProof;
    const created = terminal.creationCheckpoint.evidence;
    const current = checkpoint.evidence;
    if (d.dispositionRef !== recovery.terminalNonSubmissionDispositionRef
        || d.sessionId !== ref.sessionId || d.executionAttemptId !== d.pendingEffectIdentity.executionAttemptId
        || d.committedRevision !== ref.recoveryRevision || d.committedFence > ref.fenceToken
        || d.executionAuthorityCheckpointRefAfter !== ref.checkpointRef
        || d.expectedRecoveryRevision + 1 !== ref.recoveryRevision
        || !equalCanonicalJson(d.executionAuthorityIdentity, recovery.executionAuthorityIdentity)
        || d.mode !== recovery.mode || d.instrumentId !== recovery.instrumentId
        || d.riskBasisCheckpointRef !== recovery.riskBasisCheckpointRef
        || d.latestROutcomeRef !== recovery.latestROutcomeRef
        || checkpoint.checkpointRef !== ref.checkpointRef
        || !equalCanonicalJson(current.identity, recovery.executionAuthorityIdentity)
        || p.sessionId !== ref.sessionId || !sameIdentity(p, d.pendingEffectIdentity)
        || p.state !== "RESOLVED" || p.schemaVersion !== "ORCHESTRATION_PENDING_EFFECT_V2"
        || p.resolutionKind !== "TERMINAL_NON_SUBMISSION"
        || p.resolvedAuthorityRef !== d.dispositionRef || p.resolvedOutcomeKey !== null
        || p.resolvedRevision !== d.committedRevision || p.resolvedFence !== d.committedFence
        || p.createdRevision !== d.pendingCreatedRevision || p.createdFence !== d.pendingCreatedFence
        || broker.adapterId !== p.adapterId || broker.environment !== p.environment
        || broker.operation !== p.operation || broker.executionAttemptId !== p.executionAttemptId
        || broker.idempotencyKey !== p.idempotencyKey || broker.requestFingerprint !== p.requestFingerprint
        || broker.status !== "FAILED_NOT_SUBMITTED" || broker.adapterOrderId !== undefined
        || creation.kind !== d.pendingCreationRef.kind
        || creation.receipt.sessionId !== ref.sessionId
        || creation.receipt.committedCheckpointRef !== d.pendingCreationRef.committedCheckpointRef
        || terminal.creationCheckpoint.checkpointRef !== d.pendingCreationRef.committedCheckpointRef
        || created.schemaVersion !== current.schemaVersion
        || !equalCanonicalJson(created.identity, current.identity)
        || !equalCanonicalJson(created.initialization, current.initialization)
        || created.transitions.length > current.transitions.length
        || !created.transitions.every((transition, i) => equalCanonicalJson(transition, current.transitions[i])))
      return reject(ref, "PERSISTENCE_CORRUPTION");
    const origin = creation.kind === "PENDING_INTENT_COMMIT"
      ? creation.receipt.pendingEffect : creation.receipt.nextPendingEffect;
    if (origin === null || !sameIdentity(origin, p) || origin.state !== "PENDING"
        || origin.createdRevision !== p.createdRevision || origin.createdFence !== p.createdFence
        || creation.kind === "PENDING_INTENT_COMMIT"
          && (creation.receipt.committedRevision !== p.createdRevision
            || creation.receipt.committedFence !== p.createdFence)
        || creation.kind === "ADOPTION_NEXT_PENDING"
          && (creation.receipt.adoptedRevision !== p.createdRevision
            || creation.receipt.adoptedFence !== p.createdFence)
        || input.pendingEffects.length !== 0
        || terminal.resolvedEffects.length !== 1
        || !sameIdentity(terminal.resolvedEffects[0]!, p)
        || input.outcomes.some((item) => item.outcome.pendingEffectIdentity !== null
          && sameIdentity(item.outcome.pendingEffectIdentity, p)
          && (item.outcome.observation.kind === "CANONICAL_EXECUTION_TRANSITION"
            || item.outcome.observation.disposition.status !== "CONFIRMED_NOT_SUBMITTED")))
      return reject(ref, "PERSISTENCE_CORRUPTION");
    return Object.freeze({ ...ref, status: "TERMINAL_NON_SUBMISSION",
      checkpointRef: d.executionAuthorityCheckpointRefAfter,
      dispositionRef: d.dispositionRef, dispositionReceipt: receipt,
      resolvedPendingEffectIdentity: d.pendingEffectIdentity,
      sessionDisposition: "TERMINAL_NON_SUBMISSION" });
  } catch {
    return reject(ref, "PERSISTENCE_CORRUPTION");
  }
}

/** Classifies a complete, already-loaded durable snapshot. Returned references grant no execution authority. */
export function classifyRecoveryBoot(input: RecoveryBootClassifierInput): RecoveryBootResult {
  const ref = authority(input);
  const terminal = terminalResult(input, ref);
  if (terminal !== null) return terminal;
  if (input.lease !== "VALID") return reject(ref, "LEASE_OR_FENCE_INVALID");
  if (input.evidence === "CORRUPT") return reject(ref, "PERSISTENCE_CORRUPTION");
  if (input.evidence !== "COMPLETE") return reject(ref, "REQUIRED_EVIDENCE_UNAVAILABLE");
  if (input.checkpoint.status === "MISSING" || ref.checkpointRef === null) return reject(ref, "CHECKPOINT_MISSING");
  if (input.checkpoint.status === "MALFORMED") return reject(ref, "CHECKPOINT_MALFORMED");
  if (input.checkpoint.status === "ILLEGAL_REPLAY") return reject(ref, "ILLEGAL_REPLAY_EVIDENCE");
  if (input.checkpoint.status !== "VALID") return reject(ref, "CHECKPOINT_MALFORMED");
  const checkpoint = input.checkpoint.checkpoint;
  if (checkpoint.checkpointRef !== ref.checkpointRef) return reject(ref, "CHECKPOINT_MALFORMED");
  const expectedIdentity = input.recovery.executionAuthorityIdentity;
  if (expectedIdentity === null) return reject(ref, "AUTHORITY_IDENTITY_MISMATCH");
  const actualIdentity = checkpoint.evidence.identity;
  if (expectedIdentity.executionAttemptId !== actualIdentity.executionAttemptId
      || expectedIdentity.executionPlanId !== actualIdentity.executionPlanId
      || expectedIdentity.tradeIntentId !== actualIdentity.tradeIntentId
      || expectedIdentity.candidateId !== actualIdentity.candidateId
      || expectedIdentity.instrumentId !== actualIdentity.instrumentId
      || input.recovery.instrumentId !== actualIdentity.instrumentId) {
    return reject(ref, "AUTHORITY_IDENTITY_MISMATCH");
  }

  const pending = [...input.pendingEffects].sort((a, b) => effectKey(a.effect).localeCompare(effectKey(b.effect)));
  const outcomes = [...input.outcomes].sort((a, b) => a.outcome.outcomeKey.localeCompare(b.outcome.outcomeKey));
  const pendingByKey = new Map<string, LoadedPendingEffect>();
  for (const item of pending) {
    const effect = item.effect;
    if (effect.sessionId !== ref.sessionId || effect.executionAttemptId !== actualIdentity.executionAttemptId) {
      return reject(ref, "AUTHORITY_IDENTITY_MISMATCH", effect);
    }
    if (effect.createdRevision > ref.recoveryRevision) return reject(ref, "REVISION_MISMATCH", effect);
    if (effect.createdFence > ref.fenceToken) return reject(ref, "LEASE_OR_FENCE_INVALID", effect);
    if (effect.state !== "PENDING" || effect.resolvedOutcomeKey !== null) {
      return reject(ref, "PENDING_OUTCOME_CONTRADICTION", effect);
    }
    const key = effectKey(effect);
    const existing = pendingByKey.get(key);
    if (existing !== undefined) return reject(ref, "PENDING_OUTCOME_CONTRADICTION", effect);
    pendingByKey.set(key, item);
    if (item.creationProof === null) return reject(ref, "PENDING_CREATION_PROOF_MISSING", effect);
    if (creationRef(item) === null) return reject(ref, "RECEIPT_CONTRADICTION", effect);
    const record = item.idempotency;
    if (record.status === "UNAVAILABLE") return reject(ref, "REQUIRED_EVIDENCE_UNAVAILABLE", effect);
    if (record.status === "PRESENT") {
      const id = record.record;
      if (id.adapterId !== effect.adapterId || id.idempotencyKey !== effect.idempotencyKey
          || id.executionAttemptId !== effect.executionAttemptId || id.operation !== effect.operation) {
        return reject(ref, "IDEMPOTENCY_IDENTITY_CONFLICT", effect);
      }
      if (id.environment !== effect.environment) return reject(ref, "IDEMPOTENCY_ENVIRONMENT_CONFLICT", effect);
      if (id.requestFingerprint !== effect.requestFingerprint) return reject(ref, "FINGERPRINT_CONFLICT", effect);
      if (id.status === "FAILED_NOT_SUBMITTED") return reject(ref,
        "TERMINAL_NON_SUBMISSION_PROOF_UNAVAILABLE", effect);
    }
  }

  const outcomeKeys = new Set<string>();
  const canonicalByPending = new Map<string, LoadedExternalOutcome>();
  const dispositionByPending = new Map<string, LoadedExternalOutcome>();
  const candidates: Candidate[] = [];
  for (const item of outcomes) {
    const outcome = item.outcome;
    if (outcomeKeys.has(outcome.outcomeKey)) return reject(ref, "PERSISTENCE_CORRUPTION", undefined, outcome.outcomeKey);
    outcomeKeys.add(outcome.outcomeKey);
    if (outcome.sessionId !== ref.sessionId || outcome.executionAttemptId !== actualIdentity.executionAttemptId) {
      return reject(ref, "AUTHORITY_IDENTITY_MISMATCH", undefined, outcome.outcomeKey);
    }
    if (outcome.observedFence > ref.fenceToken) {
      return reject(ref, "LEASE_OR_FENCE_INVALID", outcome.pendingEffectIdentity ?? undefined, outcome.outcomeKey);
    }
    const linked = outcome.pendingEffectIdentity;
    if (outcome.observation.kind === "CANONICAL_EXECUTION_TRANSITION"
        && outcome.observation.transition.kind !== "ENTRY_FILL_APPLIED"
        && outcome.observation.transition.kind !== "EXIT_FILL_APPLIED" && linked === null) {
      return reject(ref, "PENDING_OUTCOME_CONTRADICTION", undefined, outcome.outcomeKey);
    }
    const loaded = linked === null ? undefined : pendingByKey.get(effectKey(linked));
    if (linked !== null && (loaded === undefined || !sameIdentity(linked, loaded.effect))) {
      if (item.adoptionReceipt === null) return reject(ref, "PENDING_OUTCOME_CONTRADICTION", linked, outcome.outcomeKey);
    }
    if (item.adoptionReceipt !== null) {
      const receipt = item.adoptionReceipt;
      if (receipt.outcomeKey !== outcome.outcomeKey || receipt.sessionId !== ref.sessionId
          || receipt.executionAttemptId !== actualIdentity.executionAttemptId
          || receipt.adoptedRevision > ref.recoveryRevision
          || receipt.adoptedFence > ref.fenceToken
          || receipt.linkedPendingResolution?.outcomeKey !== (linked === null ? undefined : outcome.outcomeKey)
          || (linked !== null && receipt.linkedPendingResolution !== null
            && !sameIdentity(receipt.linkedPendingResolution.pendingEffectIdentity, linked))
          || loaded !== undefined) return reject(ref, "RECEIPT_CONTRADICTION", linked ?? undefined, outcome.outcomeKey);
      if (outcome.observation.kind === "BROKER_DISPOSITION") {
        return reject(ref, "RECEIPT_CONTRADICTION", linked ?? undefined, outcome.outcomeKey);
      }
      continue;
    }
    if (outcome.observation.kind === "BROKER_DISPOSITION") {
      if (linked === null || loaded === undefined || dispositionByPending.has(effectKey(linked))) {
        return reject(ref, "PENDING_OUTCOME_CONTRADICTION", linked ?? undefined, outcome.outcomeKey);
      }
      dispositionByPending.set(effectKey(linked), item);
      continue;
    }
    if (linked !== null) {
      if (canonicalByPending.has(effectKey(linked))) {
        return reject(ref, "CONFLICTING_CANONICAL_OUTCOMES", linked, outcome.outcomeKey);
      }
      canonicalByPending.set(effectKey(linked), item);
    }
    candidates.push(Object.freeze({ ...ref, status: "OUTCOME_AVAILABLE", outcomeKey: outcome.outcomeKey,
      transitionKind: outcome.observation.transition.kind, pendingEffectIdentity: linked,
      priorCheckpointRef: checkpoint.checkpointRef }));
  }

  for (const item of pending) {
    const effect = item.effect;
    const key = effectKey(effect);
    const canonical = canonicalByPending.get(key);
    const disposition = dispositionByPending.get(key);
    const idempotency = item.idempotency;
    const proof = creationRef(item);
    if (proof === null || idempotency.status === "UNAVAILABLE") {
      return reject(ref, "REQUIRED_EVIDENCE_UNAVAILABLE", effect);
    }
    const dispositionStatus = disposition?.outcome.observation.kind === "BROKER_DISPOSITION"
      ? disposition.outcome.observation.disposition.status : undefined;
    if (canonical !== undefined) {
      if (idempotency.status !== "PRESENT" || idempotency.record.status === "CLAIMED"
          || idempotency.record.status === "RETRY_AUTHORIZED"
          || idempotency.record.status === "FAILED_NOT_SUBMITTED") {
        return reject(ref, "PENDING_OUTCOME_CONTRADICTION", effect, canonical.outcome.outcomeKey);
      }
      const transition = canonical.outcome.observation;
      if (transition.kind !== "CANONICAL_EXECUTION_TRANSITION") {
        return reject(ref, "PENDING_OUTCOME_CONTRADICTION", effect, canonical.outcome.outcomeKey);
      }
      const accepted = transition.transition.kind.endsWith("ACKNOWLEDGED");
      const rejected = transition.transition.kind.endsWith("REJECTED");
      if ((accepted && (idempotency.record.status === "REJECTED" || dispositionStatus === "CONFIRMED_REJECTED"))
          || (rejected && (idempotency.record.status === "CONFIRMED" || dispositionStatus === "CONFIRMED_ACCEPTED"))) {
        return reject(ref, "PENDING_OUTCOME_CONTRADICTION", effect, canonical.outcome.outcomeKey);
      }
      if (dispositionStatus === "CONFIRMED_NOT_SUBMITTED") {
        return reject(ref, "PENDING_OUTCOME_CONTRADICTION", effect, canonical.outcome.outcomeKey);
      }
      continue;
    }
    if (dispositionStatus === "CONFIRMED_NOT_SUBMITTED" && (idempotency.status !== "PRESENT"
        || idempotency.record.status !== "RETRY_AUTHORIZED")) {
      return reject(ref, "PENDING_OUTCOME_CONTRADICTION", effect, disposition?.outcome.outcomeKey);
    }
    if ((dispositionStatus === "CONFIRMED_ACCEPTED" || dispositionStatus === "CONFIRMED_REJECTED")
        && (idempotency.status !== "PRESENT"
          || idempotency.record.status !== (dispositionStatus === "CONFIRMED_ACCEPTED" ? "CONFIRMED" : "REJECTED"))) {
      return reject(ref, "PENDING_OUTCOME_CONTRADICTION", effect, disposition?.outcome.outcomeKey);
    }
    const base = { ...ref, pendingEffect: effect, creationRef: proof,
      ...(disposition === undefined ? {} : { dispositionOutcomeKey: disposition.outcome.outcomeKey }) };
    if (idempotency.status === "ABSENT") {
      if (disposition !== undefined) return reject(ref, "PENDING_OUTCOME_CONTRADICTION", effect, disposition.outcome.outcomeKey);
      candidates.push(Object.freeze({ ...base, status: "INTENT_DISPOSITION_REQUIRED", idempotency }));
    } else if (dispositionStatus === "STILL_UNKNOWN" || idempotency.record.status === "SUBMITTED"
        || idempotency.record.status === "OUTCOME_UNKNOWN") {
      candidates.push(Object.freeze({ ...base, status: "RECONCILIATION_REQUIRED", idempotency,
        ...(item.reconciliationRequestId === undefined ? {} : { reconciliationRequestId: item.reconciliationRequestId }) }));
    } else if (idempotency.record.status === "CONFIRMED" || idempotency.record.status === "REJECTED") {
      candidates.push(Object.freeze({ ...base, status: "CANONICAL_OUTCOME_REQUIRED", idempotency }));
    } else {
      candidates.push(Object.freeze({ ...base, status: "INTENT_DISPOSITION_REQUIRED", idempotency }));
    }
  }

  let selected: Candidate | undefined;
  for (const candidate of candidates) {
    if (selected === undefined || candidatePriority(candidate) > candidatePriority(selected)) selected = candidate;
  }
  return selected ?? Object.freeze({ ...ref, status: "READY" });
}
