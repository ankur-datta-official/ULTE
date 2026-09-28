import type {
  DecimalString,
  InstrumentId,
  NonNegativeDecimalString,
  PositiveDecimalString,
  UnixMs,
} from "@ulte/instrument-model";
import type {
  AuthoritativeAccountingAttempt,
  RealizedAccountingSpec,
  RealizedAccountingRejectedResult,
  RealizedTradeAccounting,
} from "@ulte/trade-accounting-engine";

export const VALUATION_MARK_SCHEMA_VERSION = "VALUATION_MARK_V1" as const;
export const UNREALIZED_TRADE_VALUATION_SCHEMA_VERSION = "UNREALIZED_TRADE_VALUATION_V1" as const;

export interface ValuationMarkInput {
  readonly instrumentId: string;
  readonly markPrice: string;
  readonly markAsOf: number;
}

export interface ValuationMark {
  readonly schemaVersion: typeof VALUATION_MARK_SCHEMA_VERSION;
  readonly instrumentId: InstrumentId;
  readonly markPrice: PositiveDecimalString;
  readonly markAsOf: UnixMs;
}

export interface OpenLotValuation {
  readonly entryFillId: string;
  readonly entryPrice: PositiveDecimalString;
  readonly remainingQuantity: PositiveDecimalString;
  readonly entryFilledAt: UnixMs;
  readonly markPrice: PositiveDecimalString;
  readonly grossUnrealizedPnl: DecimalString;
}

export interface UnrealizedTradeValuation {
  readonly schemaVersion: typeof UNREALIZED_TRADE_VALUATION_SCHEMA_VERSION;
  readonly executionAttemptId: string;
  readonly executionPlanId: string;
  readonly tradeIntentId: string;
  readonly candidateId: string;
  readonly instrumentId: InstrumentId;
  readonly valuationMethod: "FIFO_OPEN_BASIS_MARK_TO_MARKET_V1";
  readonly direction: RealizedTradeAccounting["direction"];
  readonly valuationModel: "LINEAR_PRICE_PNL";
  readonly pnlCurrency: RealizedTradeAccounting["pnlCurrency"];
  readonly pnlValuePerPriceUnitPerQuantity: PositiveDecimalString;
  readonly openQuantity: NonNegativeDecimalString;
  readonly markPrice: PositiveDecimalString;
  readonly markAsOf: UnixMs;
  readonly grossUnrealizedPnl: DecimalString;
  readonly openLotValuations: readonly OpenLotValuation[];
  readonly accountingAsOf: UnixMs;
  readonly realizedAccounting: RealizedTradeAccounting;
}

export type UnrealizedValuationRejectionReason =
  | "REALIZED_ACCOUNTING_REJECTED"
  | "VALUATION_MARK_INVALID"
  | "VALUATION_MARK_INSTRUMENT_MISMATCH"
  | "VALUATION_MARK_PRECEDES_ACCOUNTING"
  | "OPEN_BASIS_VALUATION_INCOHERENT";

export interface UnrealizedValuationProjectedResult {
  readonly status: "UNREALIZED_VALUATION_PROJECTED";
  readonly valuation: UnrealizedTradeValuation;
}

export interface UnrealizedValuationRejectedResult {
  readonly status: "UNREALIZED_VALUATION_REJECTED";
  readonly reason: UnrealizedValuationRejectionReason;
  readonly accountingProjection?: RealizedAccountingRejectedResult;
}

export type UnrealizedTradeValuationResult =
  | UnrealizedValuationProjectedResult
  | UnrealizedValuationRejectedResult;

export type UnrealizedValuationAccountingSpec = RealizedAccountingSpec;
export type AuthoritativeValuationAttempt = AuthoritativeAccountingAttempt;
