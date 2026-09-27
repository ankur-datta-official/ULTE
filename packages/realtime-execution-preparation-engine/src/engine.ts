import {
  createExecutionMarketSnapshot,
  createExecutionPreparationConfig,
  createInstrumentExecutionSpec,
  prepareExecutionPlan,
  type ExecutionMarketSnapshot,
  type ExecutionPreparationConfig,
  type InstrumentExecutionSpec,
} from "@ulte/execution-preparation-engine";
import { unixMs, type UnixMs } from "@ulte/instrument-model";
import type { RealtimeDecisionResult } from "@ulte/realtime-decision-engine";
import { createRealtimeExecutionPreparationConfig } from "./config.js";
import {
  createPreparationContextFingerprint,
  createPreparationCycleId,
  createPreparationProfileId,
  type PreparationContextFingerprint,
  type PreparationProfileId,
} from "./identity.js";
import type {
  ExecutionPreparationContext,
  NoPreparationReason,
  PublishedPreparationResult,
  RealtimeExecutionPreparationConfig,
  RealtimeExecutionPreparationEvaluators,
  RealtimeExecutionPreparationInput,
  RealtimeExecutionPreparationResult,
} from "./types.js";

const DEFAULT_EVALUATORS: RealtimeExecutionPreparationEvaluators = Object.freeze({
  prepareExecutionPlan,
});

interface ValidatedContext {
  readonly preparationAsOf: UnixMs;
  readonly marketSnapshot: ExecutionMarketSnapshot;
  readonly instrumentExecutionSpec: InstrumentExecutionSpec;
  readonly config: ExecutionPreparationConfig;
}

interface RetainedPreparation {
  readonly fingerprint: PreparationContextFingerprint;
  readonly result: PublishedPreparationResult;
}

function assertIdentifier(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) {
    throw new TypeError(`${field} must be non-empty and have no surrounding whitespace`);
  }
}

function validateDecision(decision: RealtimeDecisionResult): void {
  assertIdentifier(decision.analysisCycleId, "analysisCycleId");
  assertIdentifier(decision.decisionCycleId, "decisionCycleId");
  unixMs(decision.analysisAsOf);
  unixMs(decision.triggerCloseTime);
  if (decision.analysisAsOf !== decision.triggerCloseTime) {
    throw new TypeError("analysisAsOf must equal triggerCloseTime");
  }
  if (decision.status === "TRADE_INTENT_CREATED") {
    if (decision.tradeIntentResult.status !== "INTENT_READY") {
      throw new TypeError("TRADE_INTENT_CREATED must contain an INTENT_READY trade intent");
    }
    if (decision.tradeIntentResult.asOf !== decision.analysisAsOf) {
      throw new TypeError("Trade intent asOf must exactly equal analysisAsOf");
    }
  }
}

function validateContext(context: ExecutionPreparationContext): ValidatedContext {
  return Object.freeze({
    preparationAsOf: unixMs(context.preparationAsOf),
    marketSnapshot: createExecutionMarketSnapshot(context.marketSnapshot),
    instrumentExecutionSpec: createInstrumentExecutionSpec(context.instrumentExecutionSpec),
    config: createExecutionPreparationConfig(context.config),
  });
}

function noPreparationReason(decision: RealtimeDecisionResult): NoPreparationReason {
  switch (decision.status) {
    case "NO_DECISION": return "UPSTREAM_NO_DECISION";
    case "DECISION_REJECTED": return "UPSTREAM_DECISION_REJECTED";
    case "DUPLICATE_DECISION": return "DUPLICATE_DECISION_INPUT";
    case "TRADE_INTENT_CREATED":
      throw new TypeError("Actionable decisions require execution preparation");
  }
}

function noPreparationFingerprint(decision: RealtimeDecisionResult): PreparationContextFingerprint {
  let detail: string;
  switch (decision.status) {
    case "NO_DECISION": detail = decision.reason; break;
    case "DECISION_REJECTED": detail = decision.blockingStage; break;
    case "DUPLICATE_DECISION": detail = decision.originalStatus; break;
    case "TRADE_INTENT_CREATED":
      throw new TypeError("Actionable decisions require an execution context fingerprint");
  }
  return createPreparationContextFingerprint(["NO_PREPARATION", decision.status, detail]);
}

function preparationProfileFields(
  orchestrationConfig: Readonly<RealtimeExecutionPreparationConfig>,
  context?: ValidatedContext,
): string[] {
  if (context === undefined) return [orchestrationConfig.profileVersion, "NO_PREPARATION"];
  return [
    orchestrationConfig.profileVersion,
    String(context.config.maxIntentAgeMs),
    String(context.config.maxQuoteAgeMs),
    String(context.config.maxEntryDeviationBps),
    context.instrumentExecutionSpec.instrumentId,
    context.instrumentExecutionSpec.priceTick,
    context.instrumentExecutionSpec.quantityStep,
    context.instrumentExecutionSpec.minimumQuantity,
    context.instrumentExecutionSpec.maximumQuantity,
  ];
}

function contextFingerprint(
  context: ValidatedContext,
  profileId: PreparationProfileId,
): PreparationContextFingerprint {
  return createPreparationContextFingerprint([
    profileId,
    String(context.preparationAsOf),
    context.marketSnapshot.instrumentId,
    String(context.marketSnapshot.asOf),
    context.marketSnapshot.bid,
    context.marketSnapshot.ask,
  ]);
}

export class PreparationContextConflictError extends TypeError {
  readonly code = "PREPARATION_CONTEXT_CONFLICT" as const;
  constructor(readonly decisionCycleId: string) {
    super(`Decision cycle ${decisionCycleId} was already prepared with different context`);
    this.name = "PreparationContextConflictError";
  }
}

export class AlreadyPublishedPreparationBoundaryError extends TypeError {
  readonly code = "ALREADY_PUBLISHED_PREPARATION_BOUNDARY" as const;
  constructor(
    readonly attemptedBoundaryTime: UnixMs,
    readonly latestPublishedBoundaryTime: UnixMs,
  ) {
    super(
      `Decision boundary ${attemptedBoundaryTime} cannot reopen at or before ` +
      `latest published preparation boundary ${latestPublishedBoundaryTime}`,
    );
    this.name = "AlreadyPublishedPreparationBoundaryError";
  }
}

export class RealtimeExecutionPreparationEngine {
  readonly config: Readonly<RealtimeExecutionPreparationConfig>;
  private readonly evaluators: RealtimeExecutionPreparationEvaluators;
  private readonly retained = new Map<string, RetainedPreparation>();
  private readonly retainedOrder: string[] = [];
  private latestPublishedDecisionBoundaryTime: UnixMs | undefined;

  constructor(
    config: RealtimeExecutionPreparationConfig,
    evaluators: RealtimeExecutionPreparationEvaluators = DEFAULT_EVALUATORS,
  ) {
    this.config = createRealtimeExecutionPreparationConfig(config);
    this.evaluators = Object.freeze({ ...evaluators });
  }

  process(input: RealtimeExecutionPreparationInput): RealtimeExecutionPreparationResult {
    const decision = input.decision;
    validateDecision(decision);

    if (decision.status !== "TRADE_INTENT_CREATED") {
      const profileId = createPreparationProfileId(preparationProfileFields(this.config));
      const fingerprint = noPreparationFingerprint(decision);
      const retained = this.retained.get(decision.decisionCycleId);
      if (retained !== undefined) {
        if (retained.fingerprint !== fingerprint) {
          // A Task 019 duplicate deliberately carries no original intent/context. It is always a no-op.
          if (decision.status === "DUPLICATE_DECISION") {
            return this.createNoPreparation(decision, profileId);
          }
          throw new PreparationContextConflictError(decision.decisionCycleId);
        }
        return this.createDuplicate(retained.result);
      }
      this.assertNewBoundary(decision.triggerCloseTime);
      const result = this.createNoPreparation(decision, profileId);
      this.publish(decision.decisionCycleId, fingerprint, result);
      return result;
    }

    if (input.context === undefined) {
      throw new TypeError("Execution preparation context is required for TRADE_INTENT_CREATED");
    }
    const context = validateContext(input.context);
    const profileId = createPreparationProfileId(preparationProfileFields(this.config, context));
    const fingerprint = contextFingerprint(context, profileId);
    const retained = this.retained.get(decision.decisionCycleId);
    if (retained !== undefined) {
      if (retained.fingerprint !== fingerprint) {
        throw new PreparationContextConflictError(decision.decisionCycleId);
      }
      return this.createDuplicate(retained.result);
    }
    this.assertNewBoundary(decision.triggerCloseTime);

    const preparationCycleId = createPreparationCycleId(decision.decisionCycleId, profileId);
    const base = Object.freeze({
      analysisCycleId: decision.analysisCycleId,
      decisionCycleId: decision.decisionCycleId,
      preparationCycleId,
      preparationProfileId: profileId,
      analysisAsOf: decision.analysisAsOf,
      triggerCloseTime: decision.triggerCloseTime,
      preparationAsOf: context.preparationAsOf,
      tradeIntentResult: decision.tradeIntentResult,
    });
    const executionPreparationResult = this.evaluators.prepareExecutionPlan({
      tradeIntent: decision.tradeIntentResult,
      executionAsOf: context.preparationAsOf,
      marketSnapshot: context.marketSnapshot,
      instrumentExecutionSpec: context.instrumentExecutionSpec,
      config: context.config,
    });
    const result: PublishedPreparationResult = executionPreparationResult.status === "EXECUTION_PLAN_READY"
      ? Object.freeze({
          ...base,
          status: "EXECUTION_PREPARED",
          executionPreparationResult,
        })
      : Object.freeze({
          ...base,
          status: "PREPARATION_REJECTED",
          executionPreparationResult,
        });
    this.publish(decision.decisionCycleId, fingerprint, result);
    return result;
  }

  getRecentPreparationCount(): number {
    return this.retained.size;
  }

  getLatestPublishedDecisionBoundaryTime(): UnixMs | undefined {
    return this.latestPublishedDecisionBoundaryTime;
  }

  private createNoPreparation(
    decision: Exclude<RealtimeDecisionResult, { readonly status: "TRADE_INTENT_CREATED" }>,
    profileId: PreparationProfileId,
  ): PublishedPreparationResult {
    return Object.freeze({
      status: "NO_PREPARATION",
      reason: noPreparationReason(decision),
      upstreamDecisionStatus: decision.status,
      analysisCycleId: decision.analysisCycleId,
      decisionCycleId: decision.decisionCycleId,
      preparationCycleId: createPreparationCycleId(decision.decisionCycleId, profileId),
      preparationProfileId: profileId,
      analysisAsOf: decision.analysisAsOf,
      triggerCloseTime: decision.triggerCloseTime,
    });
  }

  private createDuplicate(result: PublishedPreparationResult): RealtimeExecutionPreparationResult {
    return Object.freeze({
      status: "DUPLICATE_PREPARATION",
      originalStatus: result.status,
      analysisCycleId: result.analysisCycleId,
      decisionCycleId: result.decisionCycleId,
      preparationCycleId: result.preparationCycleId,
      preparationProfileId: result.preparationProfileId,
      analysisAsOf: result.analysisAsOf,
      triggerCloseTime: result.triggerCloseTime,
    });
  }

  private assertNewBoundary(boundaryTime: UnixMs): void {
    if (this.latestPublishedDecisionBoundaryTime !== undefined &&
        boundaryTime <= this.latestPublishedDecisionBoundaryTime) {
      throw new AlreadyPublishedPreparationBoundaryError(
        boundaryTime,
        this.latestPublishedDecisionBoundaryTime,
      );
    }
  }

  private publish(
    decisionCycleId: string,
    fingerprint: PreparationContextFingerprint,
    result: PublishedPreparationResult,
  ): void {
    this.retained.set(decisionCycleId, Object.freeze({ fingerprint, result }));
    this.retainedOrder.push(decisionCycleId);
    if (this.retainedOrder.length > this.config.recentPreparationWindowSize) {
      const evicted = this.retainedOrder.shift();
      if (evicted === undefined) throw new Error("Preparation retention state is corrupt");
      this.retained.delete(evicted);
    }
    this.latestPublishedDecisionBoundaryTime = result.triggerCloseTime;
  }
}
