import { describe, expect, it } from "vitest";
import { brokerAdapterId, type RequestFingerprint } from "@ulte/broker-adapters";
import { createEntryAcknowledgement } from "@ulte/execution-engine";
import {
  createOrchestrationExternalOutcome, createOrchestrationPendingEffect,
  createOrchestrationPendingEffectIdentity, orchestrationOutcomeKey,
  ORCHESTRATION_EXTERNAL_OUTCOME_SCHEMA_VERSION, ORCHESTRATION_PENDING_EFFECT_SCHEMA_VERSION,
  type OrchestrationOutcomeAppendResult, type OrchestrationPendingEffectCreateResult,
  type OrchestrationPendingEffectResolutionResult,
} from "./index.js";

const identity = {
  adapterId: brokerAdapterId("adapter-1"), environment: "SANDBOX", operation: "ENTRY_SUBMISSION",
  executionAttemptId: "attempt-1", idempotencyKey: "key-1",
  requestFingerprint: "fingerprint-1" as RequestFingerprint,
};
const pending = {
  schemaVersion: ORCHESTRATION_PENDING_EFFECT_SCHEMA_VERSION,
  sessionId: "session-1", ...identity, createdRevision: 2, createdFence: 1,
  state: "PENDING", resolvedOutcomeKey: null, resolvedRevision: null, resolvedFence: null,
};
const outcome = {
  schemaVersion: ORCHESTRATION_EXTERNAL_OUTCOME_SCHEMA_VERSION,
  outcomeKey: "outcome-1", sessionId: "session-1", executionAttemptId: "attempt-1",
  observedAt: 100, observedFence: 2, pendingEffectIdentity: identity,
  observation: { kind: "BROKER_DISPOSITION", disposition: { status: "STILL_UNKNOWN", adapterOrderId: "order-1" } },
};

describe("pending effects and external outcomes", () => {
  it("represents terminal V2 resolution without an outcome-key alias", () => {
    const unresolved = createOrchestrationPendingEffect({ ...pending,
      schemaVersion: "ORCHESTRATION_PENDING_EFFECT_V2",
      resolutionKind: null, resolvedAuthorityRef: null });
    expect(unresolved.resolvedOutcomeKey).toBeNull();
    const external = createOrchestrationPendingEffect({ ...pending,
      schemaVersion: "ORCHESTRATION_PENDING_EFFECT_V2", state: "RESOLVED",
      resolutionKind: "EXTERNAL_OUTCOME", resolvedAuthorityRef: "outcome-1",
      resolvedOutcomeKey: "outcome-1", resolvedRevision: 3, resolvedFence: 2 });
    expect(external.resolvedOutcomeKey).toBe("outcome-1");
    const terminal = createOrchestrationPendingEffect({ ...pending,
      schemaVersion: "ORCHESTRATION_PENDING_EFFECT_V2", state: "RESOLVED",
      resolutionKind: "TERMINAL_NON_SUBMISSION", resolvedAuthorityRef: "terminal-1",
      resolvedRevision: 3, resolvedFence: 2 });
    expect(terminal.resolvedAuthorityRef).toBe("terminal-1");
    expect(terminal.resolvedOutcomeKey).toBeNull();
    expect(() => createOrchestrationPendingEffect({ ...terminal,
      resolvedOutcomeKey: "terminal-1" })).toThrow();
    expect(() => createOrchestrationPendingEffect({ ...pending,
      schemaVersion: "ORCHESTRATION_PENDING_EFFECT_V2" })).toThrow();
  });
  it("accepts only Phase33 recovery environments for pending identities and records", () => {
    for (const environment of ["DRY_RUN", "SANDBOX"]) {
      expect(createOrchestrationPendingEffectIdentity({ ...identity, environment }).environment).toBe(environment);
      expect(createOrchestrationPendingEffect({ ...pending, environment }).environment).toBe(environment);
    }
    expect(() => createOrchestrationPendingEffectIdentity({ ...identity, environment: "LIVE" })).toThrow();
    expect(() => createOrchestrationPendingEffect({ ...pending, environment: "LIVE" })).toThrow();
  });

  it("rejects a LIVE pending identity in a broker disposition outcome", () => {
    expect(() => createOrchestrationExternalOutcome({ ...outcome,
      pendingEffectIdentity: { ...identity, environment: "LIVE" } })).toThrow();
  });

  it("accepts a pending record and copies frozen public wrappers", () => {
    const source = { ...pending };
    const record = createOrchestrationPendingEffect(source);
    expect(record).toEqual(pending);
    expect(source).toEqual(pending);
    expect(record).not.toBe(source);
    expect(Object.isFrozen(record)).toBe(true);
    expect(Object.isFrozen(createOrchestrationPendingEffectIdentity(identity))).toBe(true);
  });

  it("permits a newer owner fence and later resolution revision", () => {
    const resolved = createOrchestrationPendingEffect({ ...pending, state: "RESOLVED",
      resolvedOutcomeKey: "outcome-1", resolvedRevision: 3, resolvedFence: 3 });
    expect(resolved.createdFence).toBe(1);
    expect(resolved.resolvedFence).toBe(3);
  });

  it("requires precisely coherent resolution fields", () => {
    expect(() => createOrchestrationPendingEffect({ ...pending, resolvedFence: 2 })).toThrow();
    for (const field of ["resolvedOutcomeKey", "resolvedRevision", "resolvedFence"]) {
      const resolved = { ...pending, state: "RESOLVED", resolvedOutcomeKey: "outcome-1",
        resolvedRevision: 3, resolvedFence: 2, [field]: null };
      expect(() => createOrchestrationPendingEffect(resolved)).toThrow();
    }
    expect(() => createOrchestrationPendingEffect({ ...pending, state: "RESOLVED",
      resolvedOutcomeKey: "outcome-1", resolvedRevision: 1, resolvedFence: 2 })).toThrow();
  });

  it("rejects malformed identities, revisions, fences and schema", () => {
    for (const change of [{ sessionId: " " }, { adapterId: " bad " }, { operation: "UNKNOWN" },
      { executionAttemptId: "" }, { idempotencyKey: " key " }, { requestFingerprint: "" },
      { createdRevision: -1 }, { createdFence: 0 }, { schemaVersion: "V2" }]) {
      expect(() => createOrchestrationPendingEffect({ ...pending, ...change })).toThrow();
    }
  });

  it("requires a canonical caller-supplied outcome key", () => {
    expect(orchestrationOutcomeKey("key-1")).toBe("key-1");
    for (const bad of ["", " ", " key ", null, 1]) expect(() => orchestrationOutcomeKey(bad)).toThrow();
  });

  it("accepts a canonical transition and rejects an attempt mismatch", () => {
    const acknowledgement = createEntryAcknowledgement({ executionAttemptId: "attempt-1",
      idempotencyKey: "key-1", adapterOrderId: "order-1", acknowledgedAt: 90 });
    const transition = { kind: "ENTRY_SUBMISSION_ACKNOWLEDGED", acknowledgement: {
      executionAttemptId: acknowledgement.executionAttemptId, idempotencyKey: acknowledgement.idempotencyKey,
      adapterOrderId: acknowledgement.adapterOrderId, acknowledgedAt: acknowledgement.acknowledgedAt,
    } };
    const source = { ...outcome, observation: { kind: "CANONICAL_EXECUTION_TRANSITION", transition } };
    const result = createOrchestrationExternalOutcome(source);
    expect(result.observation.kind).toBe("CANONICAL_EXECUTION_TRANSITION");
    expect(Object.isFrozen(result.observation)).toBe(true);
    expect(Object.isFrozen(result.observation.kind === "CANONICAL_EXECUTION_TRANSITION" && result.observation.transition)).toBe(true);
    expect(source.observation.transition).toEqual(transition);
    expect(() => createOrchestrationExternalOutcome({ ...source, executionAttemptId: "other" })).toThrow();
    expect(() => createOrchestrationExternalOutcome({ ...source, pendingEffectIdentity: { ...identity, operation: "ENTRY_CANCELLATION" } })).toThrow();
  });

  it("keeps sparse dispositions distinct and accepts independent observations", () => {
    const result = createOrchestrationExternalOutcome(outcome);
    expect(result.observation.kind).toBe("BROKER_DISPOSITION");
    expect(Object.isFrozen(result.observation)).toBe(true);
    expect(result.pendingEffectIdentity).not.toBe(identity);
    expect(Object.isFrozen(result.pendingEffectIdentity)).toBe(true);
    expect(outcome.observation.disposition).toEqual({ status: "STILL_UNKNOWN", adapterOrderId: "order-1" });
    expect(createOrchestrationExternalOutcome({ ...outcome, pendingEffectIdentity: null,
      observation: { kind: "CANONICAL_EXECUTION_TRANSITION", transition: {
        kind: "ENTRY_FILL_APPLIED", fill: { executionAttemptId: "attempt-1", adapterOrderId: "order-1",
          fillId: "fill-1", filledQuantity: "1", fillPrice: "10", filledAt: 101 },
      } } }).pendingEffectIdentity).toBeNull();
    expect(() => createOrchestrationExternalOutcome({ ...outcome, pendingEffectIdentity: null })).toThrow();
    expect(() => createOrchestrationExternalOutcome({ ...outcome, observation: {
      kind: "BROKER_DISPOSITION", disposition: { status: "CONFIRMED_NOT_SUBMITTED", adapterOrderId: "invented" },
    } })).toThrow();
    for (const status of ["CONFIRMED_ACCEPTED", "CONFIRMED_REJECTED", "CONFIRMED_NOT_SUBMITTED", "STILL_UNKNOWN"]) {
      const sparse = createOrchestrationExternalOutcome({ ...outcome, observation: {
        kind: "BROKER_DISPOSITION", disposition: { status },
      } });
      expect(sparse.observation.kind).toBe("BROKER_DISPOSITION");
    }
  });

  it("validates observation time, fence, schema and linkage independently", () => {
    expect(createOrchestrationExternalOutcome(outcome).observedFence).toBe(2);
    for (const change of [{ observedAt: -1 }, { observedAt: 1.5 }, { observedFence: 0 },
      { schemaVersion: "V2" }, { pendingEffectIdentity: { ...identity, executionAttemptId: "other" } }]) {
      expect(() => createOrchestrationExternalOutcome({ ...outcome, ...change })).toThrow();
    }
  });

  it("defines closed create, append and resolution result families", () => {
    const effect = createOrchestrationPendingEffect(pending);
    const durableOutcome = createOrchestrationExternalOutcome(outcome);
    const create: OrchestrationPendingEffectCreateResult[] = [
      { status: "CREATED", effect }, { status: "DUPLICATE_SAME", effect }, { status: "EFFECT_CONFLICT", existing: effect },
    ];
    const append: OrchestrationOutcomeAppendResult[] = [
      { status: "APPENDED", outcome: durableOutcome }, { status: "DUPLICATE_SAME", outcome: durableOutcome },
      { status: "OUTCOME_CONFLICT", existing: durableOutcome },
    ];
    const resolve: OrchestrationPendingEffectResolutionResult[] = [
      { status: "RESOLVED", effect }, { status: "ALREADY_RESOLVED", effect }, { status: "NOT_FOUND" },
      { status: "OUTCOME_NOT_FOUND" }, { status: "REVISION_CONFLICT", currentRevision: effect.createdRevision },
      { status: "FENCE_CONFLICT", currentFence: null },
    ];
    expect(create.map((result) => result.status)).toHaveLength(3);
    expect(append.map((result) => result.status)).toHaveLength(3);
    expect(resolve.map((result) => result.status)).toHaveLength(6);
  });
});
