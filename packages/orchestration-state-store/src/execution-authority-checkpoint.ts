import {
  restoreExecutionAttemptFromEvidence,
  validateExecutionAttemptRecoveryEvidence,
  type ExecutionAttemptRecoveryEvidenceV1,
} from "@ulte/execution-engine";
import { executionAuthorityCheckpointId, type ExecutionAuthorityCheckpointId } from "./recovery-store.js";

export const EXECUTION_AUTHORITY_CHECKPOINT_SCHEMA_VERSION = "EXECUTION_AUTHORITY_CHECKPOINT_V1" as const;

export interface ExecutionAuthorityCheckpoint {
  readonly schemaVersion: typeof EXECUTION_AUTHORITY_CHECKPOINT_SCHEMA_VERSION;
  readonly checkpointRef: ExecutionAuthorityCheckpointId;
  readonly evidence: ExecutionAttemptRecoveryEvidenceV1;
}

function copyFrozenJson(value: unknown, ancestors: ReadonlySet<object> = new Set()): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "object" || ancestors.has(value)) throw new TypeError("Invalid checkpoint JSON data");
  const next = new Set(ancestors);
  next.add(value);
  if (Array.isArray(value)) {
    if (Reflect.ownKeys(value).length !== value.length + 1) throw new TypeError("Invalid checkpoint array");
    const copy: unknown[] = [];
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, index);
      if (descriptor === undefined || !("value" in descriptor)) throw new TypeError("Invalid checkpoint array element");
      copy.push(copyFrozenJson(descriptor.value, next));
    }
    return Object.freeze(copy);
  }
  if (Object.getPrototypeOf(value) !== Object.prototype) throw new TypeError("Invalid checkpoint object");
  const entries: [string, unknown][] = [];
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") throw new TypeError("Invalid checkpoint object key");
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
      throw new TypeError("Invalid checkpoint object property");
    }
    entries.push([key, copyFrozenJson(descriptor.value, next)]);
  }
  return Object.freeze(Object.fromEntries(entries));
}

/** A checkpoint is evidence only; appending it grants no orchestration authority or recovery advance. */
export function createExecutionAuthorityCheckpoint(value: unknown): ExecutionAuthorityCheckpoint {
  if (typeof value !== "object" || value === null || Array.isArray(value)
      || Object.getPrototypeOf(value) !== Object.prototype) throw new TypeError("Invalid execution checkpoint");
  const keys = Reflect.ownKeys(value);
  if (keys.length !== 3 || keys.some((key) => typeof key !== "string"
      || !["schemaVersion", "checkpointRef", "evidence"].includes(key))) {
    throw new TypeError("Invalid execution checkpoint keys");
  }
  const record = value as Readonly<Record<string, unknown>>;
  const fields = ["schemaVersion", "checkpointRef", "evidence"] as const;
  if (fields.some((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(record, key);
    return descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable;
  }) || record["schemaVersion"] !== EXECUTION_AUTHORITY_CHECKPOINT_SCHEMA_VERSION) {
    throw new TypeError("Invalid execution checkpoint schema");
  }
  const checkpointRef = executionAuthorityCheckpointId(record["checkpointRef"]);
  const snapshot = copyFrozenJson(record["evidence"]);
  const validation = validateExecutionAttemptRecoveryEvidence(snapshot);
  if (validation.status !== "EXECUTION_ATTEMPT_RECOVERY_EVIDENCE_VALID") {
    throw new TypeError("Invalid execution checkpoint evidence");
  }
  if (restoreExecutionAttemptFromEvidence(validation.evidence).status !== "EXECUTION_ATTEMPT_RESTORED") {
    throw new TypeError("Execution checkpoint evidence cannot restore authority");
  }
  return Object.freeze({ schemaVersion: EXECUTION_AUTHORITY_CHECKPOINT_SCHEMA_VERSION,
    checkpointRef, evidence: validation.evidence });
}

export type ExecutionAuthorityCheckpointAppendResult =
  | Readonly<{ readonly status: "APPENDED"; readonly checkpoint: ExecutionAuthorityCheckpoint }>
  | Readonly<{ readonly status: "DUPLICATE_SAME"; readonly checkpoint: ExecutionAuthorityCheckpoint }>
  | Readonly<{ readonly status: "CHECKPOINT_CONFLICT"; readonly existing: ExecutionAuthorityCheckpoint }>;

/** Append alone grants no orchestration authority and does not advance recovery state.
 * B1E must insert/reference this checkpoint in the same authorized transaction as the recovery advance.
 */
export interface ExecutionAuthorityCheckpointStore {
  loadExecutionAuthorityCheckpoint(checkpointRef: ExecutionAuthorityCheckpointId): Promise<ExecutionAuthorityCheckpoint | null>;
  appendExecutionAuthorityCheckpoint(checkpoint: ExecutionAuthorityCheckpoint): Promise<ExecutionAuthorityCheckpointAppendResult>;
}
