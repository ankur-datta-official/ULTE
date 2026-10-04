import {
  createExternalOutcomeAdoptionReceipt, createOutcomeAdoptionRecoveryState,
  createPendingIntentCommitReceipt,
  executionAuthorityCheckpointId,
  equivalentOutcomeAdoptionRetry, equivalentPendingIntentRetry,
  proveExecutionCheckpointAdvance, proveOutcomeAdoptionCheckpointAdvance,
  provePendingIntentCheckpointAdvance,
  orchestrationFenceToken, orchestrationLeaseOwnerId, orchestrationRevision, orchestrationSessionId,
  type AdoptionLogicalPayload, type CheckpointAdvanceProof, type ExecutionAuthorityCheckpoint,
  type ExternalOutcomeAdoptionReceipt, type OrchestrationExternalOutcome,
  type OrchestrationRecoveryRecord, type OrchestrationRecoveryState,
  type OrchestrationPendingEffect, type OutcomeAdoptionTransactionResult,
  type PendingIntentCommitReceipt, type PendingIntentLogicalPayload,
  type PendingIntentTransactionResult,
} from "./index.js";

declare const before: ExecutionAuthorityCheckpoint;
declare const after: ExecutionAuthorityCheckpoint;
declare const pending: OrchestrationPendingEffect;
declare const outcome: OrchestrationExternalOutcome;
declare const pendingReceipt: PendingIntentCommitReceipt;
declare const adoptionReceipt: ExternalOutcomeAdoptionReceipt;
declare const pendingLogical: PendingIntentLogicalPayload;
declare const adoptionLogical: AdoptionLogicalPayload;
declare const pendingResult: PendingIntentTransactionResult;
declare const adoptionResult: OutcomeAdoptionTransactionResult;
declare const currentRecovery: OrchestrationRecoveryRecord;

const adoptedRecovery: OrchestrationRecoveryState = createOutcomeAdoptionRecoveryState({
  currentRecovery, committedCheckpoint: after,
});
// @ts-expect-error Adoption has no caller-controlled latest-R update option.
createOutcomeAdoptionRecoveryState({ currentRecovery, committedCheckpoint: after, nextLatestROutcomeRef: null });
// @ts-expect-error Adoption has no caller-controlled risk-basis update option.
createOutcomeAdoptionRecoveryState({ currentRecovery, committedCheckpoint: after, riskBasisUpdate: null });

const proof: CheckpointAdvanceProof = proveExecutionCheckpointAdvance({
  previousCheckpoint: before, committedCheckpoint: after, allowedSuffix: after.evidence.transitions,
});
provePendingIntentCheckpointAdvance({ previousCheckpoint: before, committedCheckpoint: after, pendingEffect: pending });
const adoptionProof = proveOutcomeAdoptionCheckpointAdvance({ previousCheckpoint: before,
  committedCheckpoint: after, outcome, nextPendingEffect: null });
if (adoptionProof.status === "PROVEN") adoptionProof.proof satisfies CheckpointAdvanceProof;
else adoptionProof.status satisfies "OUTCOME_NOT_ADOPTABLE";

createPendingIntentCommitReceipt(pendingReceipt, before, after);
createExternalOutcomeAdoptionReceipt(adoptionReceipt, before, after, outcome);
equivalentPendingIntentRetry(pendingReceipt, pendingLogical);
equivalentOutcomeAdoptionRetry(adoptionReceipt, adoptionLogical);
orchestrationSessionId("session");
orchestrationRevision(1);
orchestrationFenceToken(1);
orchestrationLeaseOwnerId("owner");
function impossible(value: never): never { throw new Error(`Unexpected result: ${String(value)}`); }
function checkPending(value: PendingIntentTransactionResult): void {
  switch (value.status) {
    case "COMMITTED": case "ALREADY_COMMITTED": value.receipt satisfies PendingIntentCommitReceipt; break;
    case "REVISION_CONFLICT": value.currentRevision satisfies typeof pendingReceipt.expectedRevision; break;
    case "FENCE_CONFLICT": value.currentFence satisfies typeof pendingReceipt.committedFence | null; break;
    case "CHECKPOINT_CONFLICT": value.checkpointRef satisfies typeof before.checkpointRef; break;
    case "PRIOR_CHECKPOINT_CONFLICT":
      value.requestedPreviousCheckpointRef satisfies typeof before.checkpointRef;
      value.currentCheckpointRef satisfies typeof before.checkpointRef | null;
      break;
    case "LEASE_LOST": case "NOT_FOUND": case "EFFECT_CONFLICT": break;
    default: impossible(value);
  }
}
function checkAdoption(value: OutcomeAdoptionTransactionResult): void {
  switch (value.status) {
    case "ADOPTED": case "ALREADY_ADOPTED": value.receipt satisfies ExternalOutcomeAdoptionReceipt; break;
    case "REVISION_CONFLICT": value.currentRevision satisfies typeof adoptionReceipt.expectedRevision; break;
    case "FENCE_CONFLICT": value.currentFence satisfies typeof adoptionReceipt.adoptedFence | null; break;
    case "CHECKPOINT_CONFLICT": value.checkpointRef satisfies typeof before.checkpointRef; break;
    case "PRIOR_CHECKPOINT_CONFLICT":
      value.requestedPreviousCheckpointRef satisfies typeof before.checkpointRef;
      value.currentCheckpointRef satisfies typeof before.checkpointRef | null;
      break;
    case "LEASE_LOST": case "NOT_FOUND": case "OUTCOME_NOT_FOUND": case "OUTCOME_NOT_ADOPTABLE":
    case "EFFECT_CONFLICT": case "ADOPTION_CONFLICT": break;
    default: impossible(value);
  }
}
const checkpointRef = executionAuthorityCheckpointId("checkpoint");
const pendingCollision: PendingIntentTransactionResult = { status: "CHECKPOINT_CONFLICT", checkpointRef };
const adoptionPrior: OutcomeAdoptionTransactionResult = {
  status: "PRIOR_CHECKPOINT_CONFLICT", requestedPreviousCheckpointRef: checkpointRef, currentCheckpointRef: null,
};
// @ts-expect-error Raw strings are not branded checkpoint references.
const unbrandedConflict: PendingIntentTransactionResult = { status: "CHECKPOINT_CONFLICT", checkpointRef: "raw" };
const unrelatedField: OutcomeAdoptionTransactionResult = {
  status: "PRIOR_CHECKPOINT_CONFLICT", requestedPreviousCheckpointRef: checkpointRef, currentCheckpointRef: null,
  // @ts-expect-error A prior-checkpoint conflict has no revision payload.
  currentRevision: orchestrationRevision(1),
};
const unrelatedCheckpointField: PendingIntentTransactionResult = {
  status: "CHECKPOINT_CONFLICT", checkpointRef,
  // @ts-expect-error A checkpoint binding conflict has no prior-authority payload.
  currentCheckpointRef: null,
};
// @ts-expect-error Raw strings have not passed the session ID constructor.
const invalidSession: PendingIntentLogicalPayload["sessionId"] = "session";
// @ts-expect-error A broker disposition has no canonical transition proof.
const invalidProof: CheckpointAdvanceProof = adoptionProof;
void proof; void adoptedRecovery; void invalidSession; void invalidProof; void pendingResult; void adoptionResult;
void checkPending; void checkAdoption; void pendingCollision; void adoptionPrior;
void unbrandedConflict; void unrelatedField; void unrelatedCheckpointField;
