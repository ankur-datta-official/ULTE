import type {
  CurrencyCode,
  InstrumentId,
  NonNegativeDecimalString,
  PositiveDecimalString,
  TimeframeId,
  UnixMs,
} from "@ulte/instrument-model";
import type { PortfolioRiskResult } from "@ulte/portfolio-risk-engine";
import type { PositionSizingResult } from "@ulte/position-sizing-engine";
import type { RiskQualificationResult } from "@ulte/risk-engine";
import type { SetupCandidate, SetupDirection, SetupFamily } from "@ulte/setup-engine";

export const TRADE_INTENT_SCHEMA_VERSION = "TRADE_INTENT_V1" as const;

export interface TradeIntentInput {
  readonly setupCandidate: SetupCandidate;
  readonly structuralRiskResult: RiskQualificationResult;
  readonly portfolioRiskResult: PortfolioRiskResult;
  readonly positionSizingResult: PositionSizingResult;
}

export type TradeIntentBlockingLayer =
  | "SETUP"
  | "STRUCTURAL_RISK"
  | "PORTFOLIO_RISK"
  | "POSITION_SIZING";

export type TradeIntentUpstreamStatus =
  | "ARMED"
  | "NOT_QUALIFIED"
  | "DATA_REJECTED"
  | "BLOCKED"
  | "UPSTREAM_NOT_QUALIFIED"
  | "NOT_SIZEABLE"
  | "UPSTREAM_NOT_ELIGIBLE";

export type TradeIntentDataRejectionReason =
  | "AS_OF_MISMATCH"
  | "CANDIDATE_ID_MISMATCH"
  | "INSTRUMENT_MISMATCH"
  | "FAMILY_MISMATCH"
  | "DIRECTION_MISMATCH"
  | "SETUP_TIMEFRAME_MISMATCH"
  | "APPROVED_RISK_MISMATCH"
  | "ACCOUNT_CURRENCY_MISMATCH"
  | "ACTUAL_RISK_EXCEEDS_APPROVED_RISK"
  | "STRUCTURAL_NET_RISK_MISMATCH"
  | "INVALID_STRUCTURAL_RISK_RESULT"
  | "INVALID_PRICE_DIRECTION";

export interface UpstreamNotReadyTradeIntentResult {
  readonly status: "UPSTREAM_NOT_READY";
  readonly blockingLayer: TradeIntentBlockingLayer;
  readonly upstreamStatus: TradeIntentUpstreamStatus;
  readonly upstreamReason?: string;
  readonly candidateId: string;
}

export interface RejectedTradeIntentResult {
  readonly status: "DATA_REJECTED";
  readonly reason: TradeIntentDataRejectionReason;
  readonly candidateId: string;
}

export interface ReadyTradeIntent {
  readonly status: "INTENT_READY";
  readonly schemaVersion: typeof TRADE_INTENT_SCHEMA_VERSION;
  readonly intentId: string;
  readonly candidateId: string;
  readonly instrumentId: InstrumentId;
  readonly asOf: UnixMs;
  readonly family: SetupFamily;
  readonly direction: SetupDirection;
  readonly contextTimeframe: TimeframeId;
  readonly setupTimeframe: TimeframeId;
  readonly entryReferencePrice: PositiveDecimalString;
  readonly invalidationPrice: PositiveDecimalString;
  readonly primaryTargetPrice: PositiveDecimalString;
  readonly quantityUnit: string;
  readonly quantity: PositiveDecimalString;
  readonly quantityStep: PositiveDecimalString;
  readonly accountCurrency: CurrencyCode;
  readonly pnlCurrency: CurrencyCode;
  readonly conversionRate: PositiveDecimalString;
  readonly approvedRiskAmount: PositiveDecimalString;
  readonly actualRiskAmount: PositiveDecimalString;
  readonly unusedRiskAmount: NonNegativeDecimalString;
  readonly riskUtilizationBps: string;
  readonly structuralNetRisk: PositiveDecimalString;
  readonly netRewardRiskBps: string;
  readonly minimumRequiredNetRewardRiskBps: number;
  readonly pnlValuePerPriceUnitPerQuantity: PositiveDecimalString;
  readonly riskPerQuantityUnitInAccountCurrency: PositiveDecimalString;
  readonly riskPerQuantityStep: PositiveDecimalString;
  readonly cappedByMaximumQuantity: boolean;
}

export type TradeIntentResult =
  | ReadyTradeIntent
  | UpstreamNotReadyTradeIntentResult
  | RejectedTradeIntentResult;
