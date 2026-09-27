import type { UnixMs } from "@ulte/instrument-model";
import type { AccountRiskSnapshot, PortfolioRiskConfig, PortfolioRiskResult } from "@ulte/portfolio-risk-engine";
import type { FxConversionSnapshot, LinearInstrumentSizingSpec, PositionSizingResult } from "@ulte/position-sizing-engine";
import type { AnalysisCycleId, AnalysisCycleResult } from "@ulte/realtime-analysis-engine";
import type { RiskCostAssumptions, RiskQualificationConfig, RiskQualificationResult } from "@ulte/risk-engine";
import type { SetupCandidate } from "@ulte/setup-engine";
import type { TradeIntentResult } from "@ulte/trade-intent-engine";
import type { DecisionCycleId, DecisionProfileId } from "./identity.js";

export interface RealtimeDecisionConfig {
  readonly profileVersion: string;
  readonly recentDecisionWindowSize: number;
}

export interface DecisionContext {
  readonly riskCosts: RiskCostAssumptions;
  readonly riskConfig: RiskQualificationConfig;
  readonly account: AccountRiskSnapshot;
  readonly requestedRiskAmount: string;
  readonly proposedRiskGroupIds: readonly string[];
  readonly portfolioRiskConfig: PortfolioRiskConfig;
  readonly instrumentSizingSpec: LinearInstrumentSizingSpec;
  readonly fxConversion?: FxConversionSnapshot;
}

export interface RealtimeDecisionInput {
  readonly analysis: AnalysisCycleResult;
  readonly context?: DecisionContext;
}

export interface RealtimeDecisionEvaluators {
  readonly qualifyStructuralRisk: typeof import("@ulte/risk-engine").qualifyStructuralRisk;
  readonly evaluatePortfolioRisk: typeof import("@ulte/portfolio-risk-engine").evaluatePortfolioRisk;
  readonly sizePosition: typeof import("@ulte/position-sizing-engine").sizePosition;
  readonly createTradeIntent: typeof import("@ulte/trade-intent-engine").createTradeIntent;
}

interface DecisionBase {
  readonly analysisCycleId: AnalysisCycleId;
  readonly decisionCycleId: DecisionCycleId;
  readonly decisionProfileId: DecisionProfileId;
  readonly analysisAsOf: UnixMs;
  readonly triggerCloseTime: UnixMs;
}

export type NoDecisionReason =
  | "INSUFFICIENT_HISTORY"
  | "NO_SETUP"
  | "SETUP_NOT_READY"
  | "NO_ACTIONABLE_CANDIDATE";

export interface NoDecisionResult extends DecisionBase {
  readonly status: "NO_DECISION";
  readonly reason: NoDecisionReason;
}

export interface MultipleCandidatesRejectedResult extends DecisionBase {
  readonly status: "DECISION_REJECTED";
  readonly blockingStage: "MULTIPLE_ACTIONABLE_CANDIDATES";
  readonly reason: "MULTIPLE_ACTIONABLE_CANDIDATES_UNSUPPORTED";
  readonly candidateIds: readonly string[];
}

export interface StructuralRiskRejectedResult extends DecisionBase {
  readonly status: "DECISION_REJECTED";
  readonly blockingStage: "STRUCTURAL_RISK";
  readonly setupCandidate: SetupCandidate;
  readonly structuralRiskResult: RiskQualificationResult;
}

export interface PortfolioRiskRejectedResult extends DecisionBase {
  readonly status: "DECISION_REJECTED";
  readonly blockingStage: "PORTFOLIO_RISK";
  readonly setupCandidate: SetupCandidate;
  readonly structuralRiskResult: RiskQualificationResult;
  readonly portfolioRiskResult: PortfolioRiskResult;
}

export interface PositionSizingRejectedResult extends DecisionBase {
  readonly status: "DECISION_REJECTED";
  readonly blockingStage: "POSITION_SIZING";
  readonly setupCandidate: SetupCandidate;
  readonly structuralRiskResult: RiskQualificationResult;
  readonly portfolioRiskResult: PortfolioRiskResult;
  readonly positionSizingResult: PositionSizingResult;
}

export interface TradeIntentRejectedResult extends DecisionBase {
  readonly status: "DECISION_REJECTED";
  readonly blockingStage: "TRADE_INTENT";
  readonly setupCandidate: SetupCandidate;
  readonly structuralRiskResult: RiskQualificationResult;
  readonly portfolioRiskResult: PortfolioRiskResult;
  readonly positionSizingResult: PositionSizingResult;
  readonly tradeIntentResult: TradeIntentResult;
}

export interface TradeIntentCreatedResult extends DecisionBase {
  readonly status: "TRADE_INTENT_CREATED";
  readonly setupCandidate: SetupCandidate;
  readonly structuralRiskResult: RiskQualificationResult;
  readonly portfolioRiskResult: PortfolioRiskResult;
  readonly positionSizingResult: PositionSizingResult;
  readonly tradeIntentResult: TradeIntentResult & { readonly status: "INTENT_READY" };
}

export interface DuplicateDecisionResult extends DecisionBase {
  readonly status: "DUPLICATE_DECISION";
  readonly originalStatus: Exclude<RealtimeDecisionResult["status"], "DUPLICATE_DECISION">;
}

export type PublishedDecisionResult =
  | NoDecisionResult
  | MultipleCandidatesRejectedResult
  | StructuralRiskRejectedResult
  | PortfolioRiskRejectedResult
  | PositionSizingRejectedResult
  | TradeIntentRejectedResult
  | TradeIntentCreatedResult;

export type RealtimeDecisionResult = PublishedDecisionResult | DuplicateDecisionResult;
