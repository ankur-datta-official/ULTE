import { positiveDecimalString, unixMs, type UnixMs } from "@ulte/instrument-model";
import {
  createAccountRiskSnapshot,
  createPortfolioRiskConfig,
  evaluatePortfolioRisk,
  type AccountRiskSnapshot,
  type PortfolioRiskConfig,
} from "@ulte/portfolio-risk-engine";
import {
  createFxConversionSnapshot,
  createLinearInstrumentSizingSpec,
  sizePosition,
} from "@ulte/position-sizing-engine";
import { qualifyStructuralRisk, createRiskCostAssumptions, createRiskQualificationConfig } from "@ulte/risk-engine";
import { createTradeIntent } from "@ulte/trade-intent-engine";
import { createRealtimeDecisionConfig } from "./config.js";
import {
  createDecisionContextFingerprint,
  createDecisionCycleId,
  createDecisionProfileId,
  encodeDecisionFields,
  type DecisionContextFingerprint,
  type DecisionProfileId,
} from "./identity.js";
import type {
  DecisionContext,
  PublishedDecisionResult,
  RealtimeDecisionConfig,
  RealtimeDecisionEvaluators,
  RealtimeDecisionInput,
  RealtimeDecisionResult,
} from "./types.js";

const DEFAULT_EVALUATORS: RealtimeDecisionEvaluators = Object.freeze({
  qualifyStructuralRisk,
  evaluatePortfolioRisk,
  sizePosition,
  createTradeIntent,
});

interface ValidatedContext extends DecisionContext {
  readonly account: AccountRiskSnapshot;
  readonly portfolioRiskConfig: PortfolioRiskConfig;
}

interface RetainedDecision {
  readonly fingerprint: DecisionContextFingerprint;
  readonly result: PublishedDecisionResult;
}

function insertLexically(values: string[], value: string): void {
  let index = 0;
  while (index < values.length && values[index]! < value) index += 1;
  values.splice(index, 0, value);
}

// Account positions and their group memberships are domain sets. Canonicalizing only these
// set-like fields prevents object insertion order from changing an idempotency fingerprint.
function canonicalAccountFields(account: AccountRiskSnapshot): string[] {
  const positions: string[] = [];
  for (const position of account.openPositions) {
    const groups: string[] = [];
    for (const groupId of position.riskGroupIds) insertLexically(groups, groupId);
    insertLexically(positions, encodeDecisionFields([
      position.positionId,
      position.instrumentId,
      position.riskAmountAtStop,
      encodeDecisionFields(groups),
    ]));
  }
  return [
    String(account.asOf),
    account.baseCurrency,
    account.currentEquity,
    account.dayStartEquity,
    encodeDecisionFields(positions),
  ];
}

function canonicalPortfolioConfigFields(config: PortfolioRiskConfig): string[] {
  const groups: string[] = [];
  for (const group of config.riskGroupLimits) {
    insertLexically(groups, encodeDecisionFields([group.groupId, String(group.maxRiskBps)]));
  }
  return [
    String(config.maxRiskPerTradeBps),
    String(config.maxTotalOpenRiskBps),
    String(config.maxConcurrentPositions),
    String(config.maxDailyLossBps),
    encodeDecisionFields(groups),
  ];
}

function validateProposedGroups(groups: readonly string[], config: PortfolioRiskConfig): readonly string[] {
  const seen = new Set<string>();
  const configured = new Set(config.riskGroupLimits.map((entry) => entry.groupId));
  const result = groups.map((groupId) => {
    if (typeof groupId !== "string" || groupId.length === 0 || groupId.trim() !== groupId) {
      throw new TypeError("proposedRiskGroupIds must contain non-empty IDs without surrounding whitespace");
    }
    if (seen.has(groupId)) throw new TypeError(`Duplicate proposed risk group: ${groupId}`);
    if (!configured.has(groupId)) throw new TypeError(`Unknown proposed risk group: ${groupId}`);
    seen.add(groupId);
    return groupId;
  });
  return Object.freeze(result);
}

function validateKnownAccountGroups(account: AccountRiskSnapshot, config: PortfolioRiskConfig): void {
  const configured = new Set(config.riskGroupLimits.map((entry) => entry.groupId));
  for (const position of account.openPositions) {
    for (const groupId of position.riskGroupIds) {
      if (!configured.has(groupId)) throw new TypeError(`Unknown account risk group: ${groupId}`);
    }
  }
}

function validateContext(context: DecisionContext, analysisAsOf: UnixMs): ValidatedContext {
  const riskCosts = createRiskCostAssumptions(context.riskCosts);
  const riskConfig = createRiskQualificationConfig(context.riskConfig);
  const account = createAccountRiskSnapshot({
    asOf: context.account.asOf,
    baseCurrency: context.account.baseCurrency,
    currentEquity: context.account.currentEquity,
    dayStartEquity: context.account.dayStartEquity,
    openPositions: context.account.openPositions.map((position) => ({
      positionId: position.positionId,
      instrumentId: position.instrumentId,
      riskAmountAtStop: position.riskAmountAtStop,
      riskGroupIds: [...position.riskGroupIds],
    })),
  });
  if (account.asOf !== analysisAsOf) {
    throw new TypeError("Decision account asOf must exactly equal analysisAsOf");
  }
  const requestedRiskAmount = positiveDecimalString(context.requestedRiskAmount);
  const portfolioRiskConfig = createPortfolioRiskConfig(context.portfolioRiskConfig);
  validateKnownAccountGroups(account, portfolioRiskConfig);
  const proposedRiskGroupIds = validateProposedGroups(context.proposedRiskGroupIds, portfolioRiskConfig);
  const instrumentSizingSpec = createLinearInstrumentSizingSpec(context.instrumentSizingSpec);
  const fxConversion = context.fxConversion === undefined
    ? undefined
    : createFxConversionSnapshot(context.fxConversion);
  if (fxConversion !== undefined && fxConversion.asOf !== analysisAsOf) {
    throw new TypeError("Decision FX asOf must exactly equal analysisAsOf");
  }
  return Object.freeze({
    riskCosts,
    riskConfig,
    account,
    requestedRiskAmount,
    proposedRiskGroupIds,
    portfolioRiskConfig,
    instrumentSizingSpec,
    ...(fxConversion === undefined ? {} : { fxConversion }),
  });
}

function policyFields(config: RealtimeDecisionConfig, context?: ValidatedContext): string[] {
  if (context === undefined) return [config.profileVersion, "NO_ACTIONABLE_CONTEXT"];
  const spec = context.instrumentSizingSpec;
  return [
    config.profileVersion,
    String(context.riskCosts.entryCostBps),
    String(context.riskCosts.targetExitCostBps),
    String(context.riskCosts.stopExitCostBps),
    String(context.riskConfig.minimumNetRewardRiskBps),
    ...canonicalPortfolioConfigFields(context.portfolioRiskConfig),
    spec.valuationModel,
    spec.instrumentId,
    spec.pnlCurrency,
    spec.quantityUnit,
    spec.quantityStep,
    spec.minimumQuantity,
    spec.maximumQuantity,
    spec.pnlValuePerPriceUnitPerQuantity,
  ];
}

function contextFingerprint(context?: ValidatedContext): DecisionContextFingerprint {
  if (context === undefined) return createDecisionContextFingerprint(["NO_ACTIONABLE_CONTEXT"]);
  return createDecisionContextFingerprint([
    ...canonicalAccountFields(context.account),
    context.requestedRiskAmount,
    encodeDecisionFields(context.proposedRiskGroupIds),
    ...policyFields({ profileVersion: "", recentDecisionWindowSize: 1 }, context).slice(1),
    ...(context.fxConversion === undefined ? ["NO_FX"] : [
      String(context.fxConversion.asOf),
      context.fxConversion.fromCurrency,
      context.fxConversion.toCurrency,
      context.fxConversion.rate,
    ]),
  ]);
}

export class DecisionContextConflictError extends TypeError {
  readonly code = "DECISION_CONTEXT_CONFLICT" as const;
  constructor(readonly analysisCycleId: string) {
    super(`Analysis cycle ${analysisCycleId} was already decided with different context`);
    this.name = "DecisionContextConflictError";
  }
}

export class AlreadyPublishedDecisionBoundaryError extends TypeError {
  readonly code = "ALREADY_PUBLISHED_DECISION_BOUNDARY" as const;
  constructor(
    readonly attemptedBoundaryTime: UnixMs,
    readonly latestPublishedBoundaryTime: UnixMs,
  ) {
    super(
      `Decision boundary ${attemptedBoundaryTime} cannot reopen at or before ` +
      `latest published boundary ${latestPublishedBoundaryTime}`,
    );
    this.name = "AlreadyPublishedDecisionBoundaryError";
  }
}

export class RealtimeDecisionEngine {
  readonly config: Readonly<RealtimeDecisionConfig>;
  private readonly evaluators: RealtimeDecisionEvaluators;
  private readonly retained = new Map<string, RetainedDecision>();
  private readonly retainedOrder: string[] = [];
  private latestPublishedBoundaryTime: UnixMs | undefined;

  constructor(config: RealtimeDecisionConfig, evaluators: RealtimeDecisionEvaluators = DEFAULT_EVALUATORS) {
    this.config = createRealtimeDecisionConfig(config);
    this.evaluators = Object.freeze({ ...evaluators });
  }

  process(input: RealtimeDecisionInput): RealtimeDecisionResult {
    const analysis = input.analysis;
    unixMs(analysis.analysisAsOf);
    if (analysis.analysisAsOf !== analysis.triggerCloseTime) {
      throw new TypeError("analysisAsOf must equal triggerCloseTime");
    }
    if (analysis.status !== "INSUFFICIENT_HISTORY" && analysis.setup.status === "READY" &&
        analysis.setup.asOf !== analysis.analysisAsOf) {
      throw new TypeError("Setup evaluation asOf must exactly equal analysisAsOf");
    }

    const retained = this.retained.get(analysis.analysisCycleId);
    const actionable = analysis.status === "ANALYZED" && analysis.setup.status === "READY"
      ? analysis.setup.candidates.filter((candidate) => candidate.stage === "CONFIRMED")
      : [];
    for (const candidate of actionable) {
      if (candidate.asOf !== analysis.analysisAsOf) {
        throw new TypeError("Setup candidate asOf must exactly equal analysisAsOf");
      }
    }
    const needsContext = actionable.length === 1;
    if (needsContext && input.context === undefined) {
      throw new TypeError("Decision context is required for one actionable setup candidate");
    }
    const validatedContext = needsContext ? validateContext(input.context!, analysis.analysisAsOf) : undefined;
    const fingerprint = contextFingerprint(validatedContext);

    if (retained !== undefined) {
      if (retained.fingerprint !== fingerprint) throw new DecisionContextConflictError(analysis.analysisCycleId);
      return Object.freeze({
        status: "DUPLICATE_DECISION",
        analysisCycleId: retained.result.analysisCycleId,
        decisionCycleId: retained.result.decisionCycleId,
        decisionProfileId: retained.result.decisionProfileId,
        analysisAsOf: retained.result.analysisAsOf,
        triggerCloseTime: retained.result.triggerCloseTime,
        originalStatus: retained.result.status,
      });
    }
    if (this.latestPublishedBoundaryTime !== undefined && analysis.triggerCloseTime <= this.latestPublishedBoundaryTime) {
      throw new AlreadyPublishedDecisionBoundaryError(
        analysis.triggerCloseTime,
        this.latestPublishedBoundaryTime,
      );
    }

    const decisionProfileId = createDecisionProfileId(policyFields(this.config, validatedContext));
    const base = Object.freeze({
      analysisCycleId: analysis.analysisCycleId,
      decisionCycleId: createDecisionCycleId(analysis.analysisCycleId, decisionProfileId),
      decisionProfileId,
      analysisAsOf: analysis.analysisAsOf,
      triggerCloseTime: analysis.triggerCloseTime,
    });
    let result: PublishedDecisionResult;
    if (analysis.status === "INSUFFICIENT_HISTORY") {
      result = Object.freeze({ ...base, status: "NO_DECISION", reason: "INSUFFICIENT_HISTORY" });
    } else if (analysis.status === "NO_SETUP") {
      result = Object.freeze({ ...base, status: "NO_DECISION", reason: "NO_SETUP" });
    } else if (analysis.setup.status !== "READY") {
      result = Object.freeze({ ...base, status: "NO_DECISION", reason: "SETUP_NOT_READY" });
    } else if (actionable.length === 0) {
      result = Object.freeze({ ...base, status: "NO_DECISION", reason: "NO_ACTIONABLE_CANDIDATE" });
    } else if (actionable.length > 1) {
      result = Object.freeze({
        ...base,
        status: "DECISION_REJECTED",
        blockingStage: "MULTIPLE_ACTIONABLE_CANDIDATES",
        reason: "MULTIPLE_ACTIONABLE_CANDIDATES_UNSUPPORTED",
        candidateIds: Object.freeze(actionable.map((candidate) => candidate.id)),
      });
    } else {
      const candidate = actionable[0]!;
      if (analysis.structure.status !== "READY") {
        throw new TypeError("Actionable setup requires a ready structure result");
      }
      const setupFrame = analysis.frame.timeframes.find(
        (timeframe) => timeframe.timeframe === candidate.setupTimeframe,
      );
      if (setupFrame === undefined) throw new TypeError("Setup timeframe is absent from the analysis frame");
      const context = validatedContext!;
      const structuralRiskResult = this.evaluators.qualifyStructuralRisk({
        candidate,
        structure: analysis.structure,
        setupCandles: setupFrame.candles,
        costs: context.riskCosts,
        config: context.riskConfig,
      });
      if (structuralRiskResult.status !== "QUALIFIED") {
        result = Object.freeze({
          ...base,
          status: "DECISION_REJECTED",
          blockingStage: "STRUCTURAL_RISK",
          setupCandidate: candidate,
          structuralRiskResult,
        });
      } else {
        const portfolioRiskResult = this.evaluators.evaluatePortfolioRisk({
          structuralRiskResult,
          account: context.account,
          requestedRiskAmount: context.requestedRiskAmount,
          proposedRiskGroupIds: context.proposedRiskGroupIds,
          config: context.portfolioRiskConfig,
        });
        if (portfolioRiskResult.status !== "CAPITAL_ELIGIBLE") {
          result = Object.freeze({
            ...base,
            status: "DECISION_REJECTED",
            blockingStage: "PORTFOLIO_RISK",
            setupCandidate: candidate,
            structuralRiskResult,
            portfolioRiskResult,
          });
        } else {
          const positionSizingResult = this.evaluators.sizePosition({
            structuralRiskResult,
            portfolioRiskResult,
            instrumentSpec: context.instrumentSizingSpec,
            ...(context.fxConversion === undefined ? {} : { fxConversion: context.fxConversion }),
          });
          if (positionSizingResult.status !== "SIZED") {
            result = Object.freeze({
              ...base,
              status: "DECISION_REJECTED",
              blockingStage: "POSITION_SIZING",
              setupCandidate: candidate,
              structuralRiskResult,
              portfolioRiskResult,
              positionSizingResult,
            });
          } else {
            const tradeIntentResult = this.evaluators.createTradeIntent({
              setupCandidate: candidate,
              structuralRiskResult,
              portfolioRiskResult,
              positionSizingResult,
            });
            result = tradeIntentResult.status === "INTENT_READY"
              ? Object.freeze({
                  ...base,
                  status: "TRADE_INTENT_CREATED",
                  setupCandidate: candidate,
                  structuralRiskResult,
                  portfolioRiskResult,
                  positionSizingResult,
                  tradeIntentResult,
                })
              : Object.freeze({
                  ...base,
                  status: "DECISION_REJECTED",
                  blockingStage: "TRADE_INTENT",
                  setupCandidate: candidate,
                  structuralRiskResult,
                  portfolioRiskResult,
                  positionSizingResult,
                  tradeIntentResult,
                });
          }
        }
      }
    }

    this.publish(analysis.analysisCycleId, fingerprint, result);
    return result;
  }

  getRecentDecisionCount(): number {
    return this.retained.size;
  }

  getLatestPublishedBoundaryTime(): UnixMs | undefined {
    return this.latestPublishedBoundaryTime;
  }

  private publish(
    analysisCycleId: string,
    fingerprint: DecisionContextFingerprint,
    result: PublishedDecisionResult,
  ): void {
    this.retained.set(analysisCycleId, Object.freeze({ fingerprint, result }));
    this.retainedOrder.push(analysisCycleId);
    if (this.retainedOrder.length > this.config.recentDecisionWindowSize) {
      const evicted = this.retainedOrder.shift();
      if (evicted === undefined) throw new Error("Decision retention state is corrupt");
      this.retained.delete(evicted);
    }
    this.latestPublishedBoundaryTime = result.triggerCloseTime;
  }
}
