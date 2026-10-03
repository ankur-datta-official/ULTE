import { brokerAdapterId, type RequestFingerprint } from "@ulte/broker-adapters";
import {
  createOrchestrationExternalOutcome, createOrchestrationPendingEffect,
  createOrchestrationPendingEffectIdentity, orchestrationFenceToken, orchestrationOutcomeKey,
  orchestrationRevision, orchestrationSessionId,
  ORCHESTRATION_EXTERNAL_OUTCOME_SCHEMA_VERSION, ORCHESTRATION_PENDING_EFFECT_SCHEMA_VERSION,
  type OrchestrationExternalOutcomeStore, type OrchestrationPendingEffect,
  type OrchestrationPendingEffectIdentity, type OrchestrationPendingEffectStore,
  type OrchestrationPendingEffectResolutionRequest,
} from "./index.js";

declare const effects: OrchestrationPendingEffectStore;
declare const outcomes: OrchestrationExternalOutcomeStore;
const sessionId = orchestrationSessionId("session-1");
const identity = createOrchestrationPendingEffectIdentity({ adapterId: brokerAdapterId("adapter-1"),
  environment: "SANDBOX", operation: "ENTRY_SUBMISSION", executionAttemptId: "attempt-1",
  idempotencyKey: "key-1", requestFingerprint: "fingerprint-1" as RequestFingerprint });
const effect = createOrchestrationPendingEffect({ schemaVersion: ORCHESTRATION_PENDING_EFFECT_SCHEMA_VERSION,
  sessionId, ...identity, createdRevision: orchestrationRevision(0), createdFence: orchestrationFenceToken(1),
  state: "PENDING", resolvedOutcomeKey: null, resolvedRevision: null, resolvedFence: null });
const liveIdentity: OrchestrationPendingEffectIdentity = { ...identity,
  // @ts-expect-error LIVE is outside the Phase33 recovery environment.
  environment: "LIVE" };
const liveEffect: OrchestrationPendingEffect = { ...effect,
  // @ts-expect-error A pending effect cannot be created with LIVE.
  environment: "LIVE" };
void liveIdentity;
void liveEffect;
const outcomeKey = orchestrationOutcomeKey("outcome-1");
const outcome = createOrchestrationExternalOutcome({ schemaVersion: ORCHESTRATION_EXTERNAL_OUTCOME_SCHEMA_VERSION,
  outcomeKey, sessionId, executionAttemptId: "attempt-1", observedAt: 100, observedFence: 2,
  pendingEffectIdentity: identity, observation: { kind: "BROKER_DISPOSITION",
    disposition: { status: "STILL_UNKNOWN" } } });
const resolution: OrchestrationPendingEffectResolutionRequest = { sessionId, pendingEffectIdentity: identity,
  outcomeKey, expectedRevision: orchestrationRevision(1), expectedFence: orchestrationFenceToken(2) };
effects.loadPendingEffect(identity);
effects.listUnresolvedEffects(sessionId);
effects.createPendingEffect(effect);
effects.resolvePendingEffect(resolution);
outcomes.loadOutcome(outcomeKey);
outcomes.listExecutionOutcomes(sessionId, identity.executionAttemptId);
outcomes.appendOutcome(outcome);
// @ts-expect-error Current fence is mandatory.
effects.resolvePendingEffect({ sessionId, pendingEffectIdentity: identity, outcomeKey, expectedRevision: orchestrationRevision(1) });
// @ts-expect-error Outcome keys are branded by their constructor.
outcomes.loadOutcome("outcome-1");
