import { createExecutionAuthorityCheckpoint, executionAuthorityCheckpointId,
  type ExecutionAuthorityCheckpoint, type ExecutionAuthorityCheckpointAppendResult,
  type ExecutionAuthorityCheckpointStore } from "./index.js";

declare const store: ExecutionAuthorityCheckpointStore;
declare const checkpoint: ExecutionAuthorityCheckpoint;
declare const result: ExecutionAuthorityCheckpointAppendResult;

store.loadExecutionAuthorityCheckpoint(executionAuthorityCheckpointId("opaque-ref"));
store.appendExecutionAuthorityCheckpoint(checkpoint);
createExecutionAuthorityCheckpoint({ schemaVersion: "EXECUTION_AUTHORITY_CHECKPOINT_V1",
  checkpointRef: executionAuthorityCheckpointId("opaque-ref"), evidence: checkpoint.evidence });

if (result.status === "APPENDED" || result.status === "DUPLICATE_SAME") {
  result.checkpoint;
} else {
  result.status satisfies "CHECKPOINT_CONFLICT";
  result.existing;
}

// @ts-expect-error A raw string has not passed the checkpoint-ref constructor.
store.loadExecutionAuthorityCheckpoint("opaque-ref");
// @ts-expect-error The conflict branch exposes existing, not checkpoint.
const invalidResult: ExecutionAuthorityCheckpointAppendResult = { status: "CHECKPOINT_CONFLICT", checkpoint };
void invalidResult;
