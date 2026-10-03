import { describe, expect, it } from "vitest";
import { validateExecutionAttemptRecoveryEvidence } from "@ulte/execution-engine";
import { checkpointEvidence } from "../../../tests/integration/phase33b-checkpoint-fixture.js";
import {
  createExecutionAuthorityCheckpoint, executionAuthorityCheckpointId,
  EXECUTION_AUTHORITY_CHECKPOINT_SCHEMA_VERSION,
  type ExecutionAuthorityCheckpointAppendResult,
} from "./index.js";

const ref = "opaque:execution/checkpoint#1";
function checkpoint(evidence: unknown = checkpointEvidence(), checkpointRef: unknown = ref) {
  return createExecutionAuthorityCheckpoint({
    schemaVersion: EXECUTION_AUTHORITY_CHECKPOINT_SCHEMA_VERSION, checkpointRef, evidence,
  });
}

describe("immutable execution authority checkpoint contract", () => {
  it("accepts minimal and requested-transition restorable evidence with an opaque caller ref", () => {
    expect(checkpoint().checkpointRef).toBe(ref);
    const requested = checkpointEvidence([{ kind: "ENTRY_SUBMISSION_REQUESTED", adapterCapabilities: {
      supportsClientIdempotency: false, supportsCloseOnlyExit: true,
      supportsNativeBracketProtection: false, supportsProtectionModification: true,
      supportsOrderCancellation: true, supportsPartialFillReporting: true,
    } }]);
    expect(checkpoint(requested).evidence.transitions).toHaveLength(1);
  });

  it("rejects unsupported schema, malformed identity, and malformed transition", () => {
    const evidence = checkpointEvidence();
    for (const bad of [
      { ...evidence, schemaVersion: "OLD" },
      { ...evidence, identity: { ...evidence.identity, candidateId: " " } },
      { ...evidence, transitions: [{ kind: "ENTRY_SUBMISSION_REQUESTED" }] },
    ]) expect(() => checkpoint(bad)).toThrow(TypeError);
  });

  it("rejects structural evidence whose lifecycle cannot replay", () => {
    const evidence = checkpointEvidence([{ kind: "PROTECTION_REQUESTED" }]);
    expect(validateExecutionAttemptRecoveryEvidence(evidence).status).toBe("EXECUTION_ATTEMPT_RECOVERY_EVIDENCE_VALID");
    expect(() => checkpoint(evidence)).toThrow(TypeError);
  });

  it("owns a deeply frozen snapshot immune to caller mutation", () => {
    const source = checkpointEvidence();
    const result = checkpoint(source);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.evidence)).toBe(true);
    expect(Object.isFrozen(result.evidence.identity)).toBe(true);
    expect(Object.isFrozen(result.evidence.initialization.executionPlanRecoveryData)).toBe(true);
    expect(Object.isFrozen(result.evidence.transitions)).toBe(true);
    expect(result.evidence).not.toBe(source);
    Object.assign(source.identity, { candidateId: "changed" });
    expect(result.evidence.identity.candidateId).not.toBe("changed");
    expect(() => Object.assign(result.evidence.identity, { candidateId: "changed" })).toThrow(TypeError);
  });

  it("requires exact outer keys, canonical refs, and plain data", () => {
    expect(executionAuthorityCheckpointId(ref)).toBe(ref);
    for (const badRef of ["", " ", " ref ", null]) expect(() => checkpoint(checkpointEvidence(), badRef)).toThrow(TypeError);
    const evidence = checkpointEvidence();
    expect(() => createExecutionAuthorityCheckpoint({ schemaVersion: EXECUTION_AUTHORITY_CHECKPOINT_SCHEMA_VERSION,
      checkpointRef: ref, evidence, extra: true })).toThrow(TypeError);
    expect(() => checkpoint({ ...evidence, [Symbol("extra")]: true })).toThrow(TypeError);
    const accessor = { schemaVersion: EXECUTION_AUTHORITY_CHECKPOINT_SCHEMA_VERSION, checkpointRef: ref, evidence };
    Object.defineProperty(accessor, "evidence", { get: () => evidence, enumerable: true });
    expect(() => createExecutionAuthorityCheckpoint(accessor)).toThrow(TypeError);
  });

  it("exposes append result union statuses", () => {
    const value = checkpoint();
    const results: ExecutionAuthorityCheckpointAppendResult[] = [
      { status: "APPENDED", checkpoint: value },
      { status: "DUPLICATE_SAME", checkpoint: value },
      { status: "CHECKPOINT_CONFLICT", existing: value },
    ];
    expect(results.map((result) => result.status)).toEqual(["APPENDED", "DUPLICATE_SAME", "CHECKPOINT_CONFLICT"]);
  });
});
