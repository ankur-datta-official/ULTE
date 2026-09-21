import type {
  CurrencyCode,
  InstrumentId,
  NonNegativeDecimalString,
  PositiveDecimalString,
  UnixMs,
} from "@ulte/instrument-model";
import type { RiskQualificationResult } from "@ulte/risk-engine";
import type { PortfolioRiskConfig } from "./config.js";

export interface OpenPositionRisk {
  readonly positionId: string;
  readonly instrumentId: InstrumentId;
  readonly riskAmountAtStop: NonNegativeDecimalString;
  readonly riskGroupIds: readonly string[];
}

export interface OpenPositionRiskInput {
  readonly positionId: string;
  readonly instrumentId: string;
  readonly riskAmountAtStop: string;
  readonly riskGroupIds: readonly string[];
}

export interface AccountRiskSnapshot {
  readonly asOf: UnixMs;
  readonly baseCurrency: CurrencyCode;
  readonly currentEquity: PositiveDecimalString;
  readonly dayStartEquity: PositiveDecimalString;
  readonly openPositions: readonly OpenPositionRisk[];
}

export interface AccountRiskSnapshotInput {
  readonly asOf: number;
  readonly baseCurrency: string;
  readonly currentEquity: string;
  readonly dayStartEquity: string;
  readonly openPositions: readonly OpenPositionRiskInput[];
}

export interface PortfolioRiskEvaluationInput {
  readonly structuralRiskResult: RiskQualificationResult;
  readonly account: AccountRiskSnapshot;
  readonly requestedRiskAmount: string;
  readonly proposedRiskGroupIds: readonly string[];
  readonly config: PortfolioRiskConfig;
}

export type PortfolioRiskDataRejectionReason =
  | "INVALID_ACCOUNT_EQUITY"
  | "INVALID_DAY_START_EQUITY"
  | "INVALID_REQUESTED_RISK"
  | "AS_OF_MISMATCH"
  | "INVALID_POSITION_ID"
  | "DUPLICATE_POSITION_ID"
  | "INVALID_OPEN_POSITION_RISK"
  | "EMPTY_RISK_GROUP"
  | "DUPLICATE_POSITION_RISK_GROUP"
  | "DUPLICATE_PROPOSED_RISK_GROUP"
  | "UNKNOWN_RISK_GROUP";

export type PortfolioRiskBlockReason =
  | "DAILY_LOSS_LIMIT_REACHED"
  | "MAX_CONCURRENT_POSITIONS_REACHED"
  | "PER_TRADE_RISK_LIMIT_EXCEEDED"
  | "TOTAL_OPEN_RISK_LIMIT_EXCEEDED"
  | "RISK_GROUP_LIMIT_EXCEEDED";

export interface ProposedRiskGroupSummary {
  readonly groupId: string;
  readonly groupRiskLimitAmount: NonNegativeDecimalString;
  readonly currentGroupRisk: NonNegativeDecimalString;
  readonly postTradeGroupRisk: NonNegativeDecimalString;
  readonly remainingGroupRiskCapacity: NonNegativeDecimalString;
}

interface PortfolioRiskIdentity {
  readonly candidateId: string;
  readonly instrumentId: InstrumentId;
  readonly asOf: UnixMs;
}

export interface PortfolioRiskSummary extends PortfolioRiskIdentity {
  readonly baseCurrency: CurrencyCode;
  readonly requestedRiskAmount: PositiveDecimalString;
  readonly currentEquity: PositiveDecimalString;
  readonly dayStartEquity: PositiveDecimalString;
  readonly dailyLossAmount: NonNegativeDecimalString;
  readonly perTradeRiskLimitAmount: NonNegativeDecimalString;
  readonly currentTotalOpenRisk: NonNegativeDecimalString;
  readonly totalOpenRiskLimitAmount: NonNegativeDecimalString;
  readonly postTradeTotalOpenRisk: NonNegativeDecimalString;
  readonly remainingTotalOpenRiskCapacity: NonNegativeDecimalString;
  readonly proposedRiskGroups: readonly ProposedRiskGroupSummary[];
  readonly maximumAdditionalRiskAmount: NonNegativeDecimalString;
}

export interface CapitalEligibleResult extends PortfolioRiskSummary {
  readonly status: "CAPITAL_ELIGIBLE";
}

export interface BlockedPortfolioRiskResult extends PortfolioRiskSummary {
  readonly status: "BLOCKED";
  readonly reason: PortfolioRiskBlockReason;
  readonly blockingRiskGroupId?: string;
}

export interface RejectedPortfolioRiskDataResult extends PortfolioRiskIdentity {
  readonly status: "DATA_REJECTED";
  readonly reason: PortfolioRiskDataRejectionReason;
  readonly unknownRiskGroupId?: string;
}

export interface UpstreamNotQualifiedPortfolioRiskResult {
  readonly status: "UPSTREAM_NOT_QUALIFIED";
  readonly upstreamStatus: "NOT_QUALIFIED" | "DATA_REJECTED";
  readonly upstreamReason: string;
  readonly candidateId: string;
  readonly instrumentId: InstrumentId;
  readonly asOf: UnixMs;
}

export type PortfolioRiskResult =
  | CapitalEligibleResult
  | BlockedPortfolioRiskResult
  | RejectedPortfolioRiskDataResult
  | UpstreamNotQualifiedPortfolioRiskResult;
