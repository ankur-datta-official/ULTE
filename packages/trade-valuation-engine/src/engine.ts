import {
  addDecimal,
  compareDecimal,
  multiplyDecimal,
  subtractDecimal,
} from "@ulte/exact-decimal";
import {
  decimalString,
  nonNegativeDecimalString,
  type DecimalString,
} from "@ulte/instrument-model";
import {
  projectRealizedTradeAccounting,
  type RealizedAccountingSpec,
  type RealizedTradeAccounting,
} from "@ulte/trade-accounting-engine";
import { createValuationMark } from "./mark.js";
import {
  UNREALIZED_TRADE_VALUATION_SCHEMA_VERSION,
  VALUATION_MARK_SCHEMA_VERSION,
  type AuthoritativeValuationAttempt,
  type OpenLotValuation,
  type UnrealizedTradeValuationResult,
  type UnrealizedValuationRejectedResult,
  type UnrealizedValuationRejectionReason,
  type ValuationMark,
} from "./types.js";

const ZERO = nonNegativeDecimalString("0");

function rejected(reason: UnrealizedValuationRejectionReason): UnrealizedValuationRejectedResult {
  return Object.freeze({ status: "UNREALIZED_VALUATION_REJECTED", reason });
}

function validateMark(input: ValuationMark): ValuationMark | undefined {
  if ((input as { readonly schemaVersion?: unknown } | null)?.schemaVersion !== VALUATION_MARK_SCHEMA_VERSION) {
    return undefined;
  }
  try {
    return createValuationMark(input);
  } catch {
    return undefined;
  }
}

function valueOpenLot(
  accounting: RealizedTradeAccounting,
  lot: RealizedTradeAccounting["openBasisLots"][number],
  mark: ValuationMark,
): OpenLotValuation {
  const priceDelta = accounting.direction === "LONG"
    ? subtractDecimal(mark.markPrice, lot.entryPrice)
    : subtractDecimal(lot.entryPrice, mark.markPrice);
  const grossUnrealizedPnl = multiplyDecimal(
    multiplyDecimal(priceDelta, lot.remainingQuantity),
    accounting.pnlValuePerPriceUnitPerQuantity,
  );
  return Object.freeze({
    entryFillId: lot.entryFillId,
    entryPrice: lot.entryPrice,
    remainingQuantity: lot.remainingQuantity,
    entryFilledAt: lot.entryFilledAt,
    markPrice: mark.markPrice,
    grossUnrealizedPnl,
  });
}

/** Values only Task027A's authoritative current FIFO open basis at the supplied resolved mark. */
export function projectUnrealizedTradeValuation(
  attempt: AuthoritativeValuationAttempt,
  accountingSpec: RealizedAccountingSpec,
  valuationMark: ValuationMark,
): UnrealizedTradeValuationResult {
  const accountingProjection = projectRealizedTradeAccounting(attempt, accountingSpec);
  if (accountingProjection.status === "REALIZED_ACCOUNTING_REJECTED") {
    return Object.freeze({
      status: "UNREALIZED_VALUATION_REJECTED",
      reason: "REALIZED_ACCOUNTING_REJECTED",
      accountingProjection,
    });
  }
  const accounting = accountingProjection.accounting;
  const mark = validateMark(valuationMark);
  if (mark === undefined) return rejected("VALUATION_MARK_INVALID");
  if (mark.instrumentId !== accounting.instrumentId) {
    return rejected("VALUATION_MARK_INSTRUMENT_MISMATCH");
  }
  if (mark.markAsOf < accounting.accountingAsOf) {
    return rejected("VALUATION_MARK_PRECEDES_ACCOUNTING");
  }

  const openLotValuations = accounting.openBasisLots.map((lot) => valueOpenLot(accounting, lot, mark));
  if (openLotValuations.length !== accounting.openBasisLots.length) {
    return rejected("OPEN_BASIS_VALUATION_INCOHERENT");
  }

  let valuedQuantity: DecimalString = ZERO;
  let grossUnrealizedPnl: DecimalString = decimalString("0");
  for (let index = 0; index < openLotValuations.length; index += 1) {
    const valued = openLotValuations[index];
    const basis = accounting.openBasisLots[index];
    if (
      valued === undefined
      || basis === undefined
      || valued.entryFillId !== basis.entryFillId
      || compareDecimal(valued.remainingQuantity, basis.remainingQuantity) !== 0
    ) return rejected("OPEN_BASIS_VALUATION_INCOHERENT");
    valuedQuantity = addDecimal(valuedQuantity, valued.remainingQuantity);
    grossUnrealizedPnl = addDecimal(grossUnrealizedPnl, valued.grossUnrealizedPnl);
  }
  if (
    compareDecimal(valuedQuantity, accounting.openQuantity) !== 0
    || (compareDecimal(accounting.openQuantity, ZERO) === 0 && openLotValuations.length !== 0)
  ) return rejected("OPEN_BASIS_VALUATION_INCOHERENT");

  const valuation = Object.freeze({
    schemaVersion: UNREALIZED_TRADE_VALUATION_SCHEMA_VERSION,
    executionAttemptId: accounting.executionAttemptId,
    executionPlanId: accounting.executionPlanId,
    tradeIntentId: accounting.tradeIntentId,
    candidateId: accounting.candidateId,
    instrumentId: accounting.instrumentId,
    valuationMethod: "FIFO_OPEN_BASIS_MARK_TO_MARKET_V1" as const,
    direction: accounting.direction,
    valuationModel: accounting.valuationModel,
    pnlCurrency: accounting.pnlCurrency,
    pnlValuePerPriceUnitPerQuantity: accounting.pnlValuePerPriceUnitPerQuantity,
    openQuantity: accounting.openQuantity,
    markPrice: mark.markPrice,
    markAsOf: mark.markAsOf,
    grossUnrealizedPnl,
    openLotValuations: Object.freeze(openLotValuations),
    accountingAsOf: accounting.accountingAsOf,
    realizedAccounting: accounting,
  });
  return Object.freeze({ status: "UNREALIZED_VALUATION_PROJECTED", valuation });
}

export class TradeValuationEngine {
  project(
    attempt: AuthoritativeValuationAttempt,
    accountingSpec: RealizedAccountingSpec,
    valuationMark: ValuationMark,
  ): UnrealizedTradeValuationResult {
    return projectUnrealizedTradeValuation(attempt, accountingSpec, valuationMark);
  }
}
