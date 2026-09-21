import type {
  CurrencyCode,
  InstrumentId,
  NonNegativeDecimalString,
  PositiveDecimalString,
  UnixMs,
} from "@ulte/instrument-model";
import type { PortfolioRiskResult } from "@ulte/portfolio-risk-engine";
import type { RiskQualificationResult } from "@ulte/risk-engine";

export interface LinearInstrumentSizingSpecInput {
  readonly valuationModel: string;
  readonly instrumentId: string;
  readonly pnlCurrency: string;
  readonly quantityUnit: string;
  readonly quantityStep: string;
  readonly minimumQuantity: string;
  readonly maximumQuantity: string;
  readonly pnlValuePerPriceUnitPerQuantity: string;
}

export interface LinearInstrumentSizingSpec {
  readonly valuationModel: "LINEAR_PRICE_PNL";
  readonly instrumentId: InstrumentId;
  readonly pnlCurrency: CurrencyCode;
  readonly quantityUnit: string;
  readonly quantityStep: PositiveDecimalString;
  readonly minimumQuantity: PositiveDecimalString;
  readonly maximumQuantity: PositiveDecimalString;
  readonly pnlValuePerPriceUnitPerQuantity: PositiveDecimalString;
}

export interface FxConversionSnapshotInput {
  readonly asOf: number;
  readonly fromCurrency: string;
  readonly toCurrency: string;
  readonly rate: string;
}

export interface FxConversionSnapshot {
  readonly asOf: UnixMs;
  readonly fromCurrency: CurrencyCode;
  readonly toCurrency: CurrencyCode;
  readonly rate: PositiveDecimalString;
}

export interface PositionSizingInput {
  readonly structuralRiskResult: RiskQualificationResult;
  readonly portfolioRiskResult: PortfolioRiskResult;
  readonly instrumentSpec: LinearInstrumentSizingSpec;
  readonly fxConversion?: FxConversionSnapshot;
}

interface PositionSizingIdentity {
  readonly candidateId: string;
  readonly instrumentId: InstrumentId;
  readonly asOf: UnixMs;
}

export type PositionSizingDataRejectionReason =
  | "UPSTREAM_IDENTITY_MISMATCH"
  | "AS_OF_MISMATCH"
  | "INSTRUMENT_SPEC_MISMATCH"
  | "UNSUPPORTED_VALUATION_MODEL"
  | "INVALID_INSTRUMENT_SPEC"
  | "INVALID_APPROVED_RISK_BUDGET"
  | "FX_CONVERSION_REQUIRED"
  | "FX_CONVERSION_MISMATCH"
  | "INVALID_RISK_PER_QUANTITY";

export type PositionNotSizeableReason = "RISK_BUDGET_BELOW_MINIMUM_QUANTITY";

export interface UpstreamNotEligiblePositionSizingResult extends PositionSizingIdentity {
  readonly status: "UPSTREAM_NOT_ELIGIBLE";
  readonly structuralStatus: RiskQualificationResult["status"];
  readonly structuralReason: string | null;
  readonly portfolioStatus: PortfolioRiskResult["status"];
  readonly portfolioReason: string | null;
}

export interface RejectedPositionSizingDataResult extends PositionSizingIdentity {
  readonly status: "DATA_REJECTED";
  readonly reason: PositionSizingDataRejectionReason;
}

export interface NotSizeablePositionSizingResult extends PositionSizingIdentity {
  readonly status: "NOT_SIZEABLE";
  readonly reason: PositionNotSizeableReason;
  readonly approvedRiskAmount: PositiveDecimalString;
  readonly minimumQuantity: PositiveDecimalString;
  readonly riskPerQuantityStep: PositiveDecimalString;
}

export interface SizedPositionResult extends PositionSizingIdentity {
  readonly status: "SIZED";
  readonly quantityUnit: string;
  readonly sizedQuantity: PositiveDecimalString;
  readonly quantityStep: PositiveDecimalString;
  readonly minimumQuantity: PositiveDecimalString;
  readonly maximumQuantity: PositiveDecimalString;
  readonly cappedByMaximumQuantity: boolean;
  readonly pnlCurrency: CurrencyCode;
  readonly accountCurrency: CurrencyCode;
  readonly conversionRate: PositiveDecimalString;
  readonly approvedRiskAmount: PositiveDecimalString;
  readonly structuralNetRisk: PositiveDecimalString;
  readonly pnlValuePerPriceUnitPerQuantity: PositiveDecimalString;
  readonly riskPerQuantityUnitInAccountCurrency: PositiveDecimalString;
  readonly riskPerQuantityStep: PositiveDecimalString;
  readonly actualRiskAmount: PositiveDecimalString;
  readonly unusedRiskAmount: NonNegativeDecimalString;
  readonly riskUtilizationBps: string;
}

export type PositionSizingResult =
  | SizedPositionResult
  | NotSizeablePositionSizingResult
  | RejectedPositionSizingDataResult
  | UpstreamNotEligiblePositionSizingResult;
