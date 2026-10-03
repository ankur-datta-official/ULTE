import {
  createExternalOutcomeAdoptionReceipt, createPendingIntentCommitReceipt,
  equivalentOutcomeAdoptionRetry, equivalentPendingIntentRetry,
  proveExecutionCheckpointAdvance, proveOutcomeAdoptionCheckpointAdvance,
  provePendingIntentCheckpointAdvance,
  orchestrationFenceToken, orchestrationLeaseOwnerId, orchestrationRevision, orchestrationSessionId,
  type AdoptionLogicalPayload, type CheckpointAdvanceProof, type ExecutionAuthorityCheckpoint,
  type ExternalOutcomeAdoptionReceipt, type OrchestrationExternalOutcome,
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
if (pendingResult.status === "COMMITTED" || pendingResult.status === "ALREADY_COMMITTED") {
  pendingResult.receipt satisfies PendingIntentCommitReceipt;
}
if (adoptionResult.status === "ADOPTED" || adoptionResult.status === "ALREADY_ADOPTED") {
  adoptionResult.receipt satisfies ExternalOutcomeAdoptionReceipt;
}
// @ts-expect-error Raw strings have not passed the session ID constructor.
const invalidSession: PendingIntentLogicalPayload["sessionId"] = "session";
// @ts-expect-error A broker disposition has no canonical transition proof.
const invalidProof: CheckpointAdvanceProof = adoptionProof;
void proof; void invalidSession; void invalidProof;
