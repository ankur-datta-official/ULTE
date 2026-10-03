import type { InstrumentId } from "@ulte/instrument-model";
import {
  createOrchestrationRecoveryRecord,
  executionAuthorityCheckpointId,
  latestROutcomeId,
  orchestrationFenceToken,
  orchestrationLeaseDurationMs,
  orchestrationLeaseOwnerId,
  orchestrationRevision,
  orchestrationSessionId,
  riskBasisCheckpointId,
  type OrchestrationLeaseRequest,
  type OrchestrationRecoveryLeaseStore,
  type OrchestrationRecoverySaveResult,
  type OrchestrationRecoveryStore,
  type OrchestrationRecoveryWrite,
} from "./index.js";

declare const store: OrchestrationRecoveryStore;
declare const leases: OrchestrationRecoveryLeaseStore;
declare const instrumentId: InstrumentId;

const sessionId = orchestrationSessionId("session-1");
const expectedRevision = orchestrationRevision(0);
const expectedFence = orchestrationFenceToken(1);
const ownerId = orchestrationLeaseOwnerId("worker-1");
const leaseDurationMs = orchestrationLeaseDurationMs(1_000);
const executionAuthorityIdentity = {
  executionAttemptId: "attempt-1", executionPlanId: "plan-1", tradeIntentId: "intent-1",
  candidateId: "candidate-1", instrumentId,
};
const state = {
  mode: "SANDBOX" as const,
  instrumentId,
  executionAuthorityCheckpointRef: executionAuthorityCheckpointId("checkpoint-1"),
  executionAuthorityIdentity,
  riskBasisCheckpointRef: riskBasisCheckpointId("risk-1"),
  latestROutcomeRef: latestROutcomeId("r-1"),
};
const write: OrchestrationRecoveryWrite = { sessionId, expectedRevision, expectedFence, state };

store.loadRecoveryState(sessionId);
store.initializeRecoveryState(write);
store.saveRecoveryState(write);
leases.acquireRecoveryLease({ sessionId, ownerId, leaseDurationMs });
leases.renewRecoveryLease({ sessionId, ownerId, expectedFence, leaseDurationMs });
leases.releaseRecoveryLease({ sessionId, ownerId, expectedFence });
createOrchestrationRecoveryRecord({
  schemaVersion: "ORCHESTRATION_RECOVERY_RECORD_V1",
  sessionId, revision: expectedRevision, fenceToken: expectedFence, ...state,
});

declare const result: OrchestrationRecoverySaveResult;
if (result.status === "SAVED") {
  result.record;
  result.newRevision;
} else if (result.status === "REVISION_CONFLICT") {
  result.currentRevision;
} else if (result.status === "FENCE_CONFLICT") {
  result.currentFence;
} else {
  result.status satisfies "NOT_FOUND";
}

// @ts-expect-error A recovery write requires a fence token.
store.saveRecoveryState({ sessionId, expectedRevision, state });
// @ts-expect-error Revision is branded and must pass its constructor.
const invalidWrite: OrchestrationRecoveryWrite = { ...write, expectedRevision: 0 };
// @ts-expect-error Lease duration must pass its constructor.
const invalidLease: OrchestrationLeaseRequest = { sessionId, ownerId, leaseDurationMs: 0 };
// @ts-expect-error Negative raw lease duration cannot satisfy the request.
leases.acquireRecoveryLease({ sessionId, ownerId, leaseDurationMs: -1 });
// @ts-expect-error Zero raw lease duration cannot satisfy renewal.
leases.renewRecoveryLease({ sessionId, ownerId, expectedFence, leaseDurationMs: 0 });
void invalidWrite;
void invalidLease;
