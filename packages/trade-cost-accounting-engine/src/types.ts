import type {
  CurrencyCode,
  DecimalString,
  InstrumentId,
  PositiveDecimalString,
  UnixMs,
} from "@ulte/instrument-model";
import type {
  AuthoritativeAccountingAttempt,
  RealizedAccountingRejectedResult,
  RealizedAccountingSpec,
  RealizedTradeAccounting,
} from "@ulte/trade-accounting-engine";

export const TRADE_COST_EVENT_SCHEMA_VERSION = "TRADE_COST_EVENT_V1" as const;
export const TRADE_COST_ACCOUNTING_SCHEMA_VERSION = "TRADE_COST_ACCOUNTING_V1" as const;

export const TRADE_COST_TYPES = [
  "COMMISSION",
  "EXCHANGE_FEE",
  "BROKER_FEE",
  "FUNDING",
  "BORROW_COST",
] as const;
export type TradeCostType = (typeof TRADE_COST_TYPES)[number];

export const TRADE_COST_EFFECTS = ["DEBIT", "CREDIT"] as const;
export type TradeCostEffect = (typeof TRADE_COST_EFFECTS)[number];

export interface TradeCostEventInput {
  readonly schemaVersion?: typeof TRADE_COST_EVENT_SCHEMA_VERSION;
  readonly costEventId: string;
  readonly executionAttemptId: string;
  readonly instrumentId: string;
  readonly costType: TradeCostType;
  readonly effect: TradeCostEffect;
  readonly amount: string;
  readonly currency: string;
  readonly effectiveAt: number;
  readonly source: string;
}

export interface TradeCostEvent {
  readonly schemaVersion: typeof TRADE_COST_EVENT_SCHEMA_VERSION;
  readonly costEventId: string;
  readonly executionAttemptId: string;
  readonly instrumentId: InstrumentId;
  readonly costType: TradeCostType;
  readonly effect: TradeCostEffect;
  readonly amount: PositiveDecimalString;
  readonly currency: CurrencyCode;
  readonly effectiveAt: UnixMs;
  readonly source: string;
}

export interface TradeCostAccounting {
  readonly schemaVersion: typeof TRADE_COST_ACCOUNTING_SCHEMA_VERSION;
  readonly executionAttemptId: RealizedTradeAccounting["executionAttemptId"];
  readonly executionPlanId: RealizedTradeAccounting["executionPlanId"];
  readonly tradeIntentId: RealizedTradeAccounting["tradeIntentId"];
  readonly candidateId: RealizedTradeAccounting["candidateId"];
  readonly instrumentId: RealizedTradeAccounting["instrumentId"];
  readonly pnlCurrency: RealizedTradeAccounting["pnlCurrency"];
  readonly grossDebitCostAmount: DecimalString;
  readonly grossCreditCostAmount: DecimalString;
  readonly netCostAmount: DecimalString;
  readonly costEventCount: number;
  readonly costEvents: readonly TradeCostEvent[];
  readonly executionAccountingAsOf: RealizedTradeAccounting["accountingAsOf"];
  readonly costAccountingAsOf: UnixMs;
  readonly positionExposure: RealizedTradeAccounting["positionExposure"];
  readonly realizedAccounting: RealizedTradeAccounting;
}

export type TradeCostAccountingRejectionReason =
  | "REALIZED_ACCOUNTING_REJECTED"
  | "COST_EVENT_INVALID"
  | "COST_EVENT_EXECUTION_ATTEMPT_MISMATCH"
  | "COST_EVENT_INSTRUMENT_MISMATCH"
  | "COST_EVENT_CURRENCY_MISMATCH"
  | "COST_EVENT_PRECEDES_ATTEMPT"
  | "DUPLICATE_COST_EVENT_ID"
  | "COST_ACCOUNTING_INCOHERENT";

export interface TradeCostAccountingProjectedResult {
  readonly status: "TRADE_COST_ACCOUNTING_PROJECTED";
  readonly accounting: TradeCostAccounting;
}

export interface TradeCostAccountingRejectedResult {
  readonly status: "TRADE_COST_ACCOUNTING_REJECTED";
  readonly reason: TradeCostAccountingRejectionReason;
  readonly realizedAccountingProjection?: RealizedAccountingRejectedResult;
}

export type TradeCostAccountingResult =
  | TradeCostAccountingProjectedResult
  | TradeCostAccountingRejectedResult;

export type AuthoritativeCostAccountingAttempt = AuthoritativeAccountingAttempt;
export type TradeCostAccountingSpec = RealizedAccountingSpec;
