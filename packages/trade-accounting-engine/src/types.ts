import type { ExitLeg, ExecutionAttempt } from "@ulte/execution-engine";
import type {
  CurrencyCode,
  DecimalString,
  InstrumentId,
  NonNegativeDecimalString,
  PositiveDecimalString,
  UnixMs,
} from "@ulte/instrument-model";
import type {
  PositionDirection,
  PositionExposure,
  PositionExposureRejectedResult,
} from "@ulte/position-engine";
import type { LinearInstrumentSizingSpec } from "@ulte/position-sizing-engine";

export const REALIZED_TRADE_ACCOUNTING_SCHEMA_VERSION = "REALIZED_TRADE_ACCOUNTING_V1" as const;

export interface RealizedMatch {
  readonly entryFillId: string;
  readonly exitFillId: string;
  readonly exitLeg: ExitLeg;
  readonly matchedQuantity: PositiveDecimalString;
  readonly entryPrice: PositiveDecimalString;
  readonly exitPrice: PositiveDecimalString;
  readonly grossRealizedPnl: DecimalString;
  readonly entryFilledAt: UnixMs;
  readonly exitFilledAt: UnixMs;
}

export interface OpenBasisLot {
  readonly entryFillId: string;
  readonly entryPrice: PositiveDecimalString;
  readonly originalQuantity: PositiveDecimalString;
  readonly remainingQuantity: PositiveDecimalString;
  readonly entryFilledAt: UnixMs;
}

export interface RealizedTradeAccounting {
  readonly schemaVersion: typeof REALIZED_TRADE_ACCOUNTING_SCHEMA_VERSION;
  readonly executionAttemptId: string;
  readonly executionPlanId: string;
  readonly tradeIntentId: string;
  readonly candidateId: string;
  readonly instrumentId: InstrumentId;
  readonly accountingMethod: "FIFO_V1";
  readonly direction: PositionDirection;
  readonly valuationModel: "LINEAR_PRICE_PNL";
  readonly pnlCurrency: CurrencyCode;
  readonly pnlValuePerPriceUnitPerQuantity: PositiveDecimalString;
  readonly filledEntryQuantity: NonNegativeDecimalString;
  readonly exitedQuantity: NonNegativeDecimalString;
  readonly openQuantity: NonNegativeDecimalString;
  readonly grossRealizedPnl: DecimalString;
  readonly realizedMatches: readonly RealizedMatch[];
  readonly openBasisLots: readonly OpenBasisLot[];
  readonly accountingAsOf: UnixMs;
  readonly positionExposure: PositionExposure;
}

export type RealizedAccountingRejectionReason =
  | "POSITION_EXPOSURE_REJECTED"
  | "VALUATION_SPEC_INSTRUMENT_MISMATCH"
  | "UNSUPPORTED_VALUATION_MODEL"
  | "INVALID_ACCOUNTING_INPUT"
  | "ENTRY_FILL_HISTORY_INCOHERENT"
  | "EXIT_FILL_HISTORY_INCOHERENT"
  | "DUPLICATE_FILL_ID"
  | "AMBIGUOUS_FILL_CHRONOLOGY"
  | "EXIT_WITHOUT_AVAILABLE_BASIS"
  | "FINAL_OPEN_BASIS_INCOHERENT";

export interface RealizedAccountingProjectedResult {
  readonly status: "REALIZED_ACCOUNTING_PROJECTED";
  readonly accounting: RealizedTradeAccounting;
}

export interface RealizedAccountingRejectedResult {
  readonly status: "REALIZED_ACCOUNTING_REJECTED";
  readonly reason: RealizedAccountingRejectionReason;
  readonly positionProjection?: PositionExposureRejectedResult;
}

export type RealizedTradeAccountingResult =
  | RealizedAccountingProjectedResult
  | RealizedAccountingRejectedResult;

export type RealizedAccountingSpec = LinearInstrumentSizingSpec;
export type AuthoritativeAccountingAttempt = ExecutionAttempt;
