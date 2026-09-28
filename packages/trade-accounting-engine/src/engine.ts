import {
  addDecimal,
  compareDecimal,
  multiplyDecimal,
  subtractDecimal,
  subtractNonNegative,
} from "@ulte/exact-decimal";
import {
  createExitFillEvent,
  createFillEvent,
  type ExecutionAttempt,
  type ExitFillEvent,
  type FillEvent,
} from "@ulte/execution-engine";
import {
  decimalString,
  instrumentId,
  nonNegativeDecimalString,
  positiveDecimalString,
  type DecimalString,
  type NonNegativeDecimalString,
  type PositiveDecimalString,
} from "@ulte/instrument-model";
import {
  projectPositionExposure,
  type PositionExposure,
  type PositionExposureRejectedResult,
} from "@ulte/position-engine";
import {
  createLinearInstrumentSizingSpec,
  type LinearInstrumentSizingSpec,
} from "@ulte/position-sizing-engine";
import {
  REALIZED_TRADE_ACCOUNTING_SCHEMA_VERSION,
  type OpenBasisLot,
  type RealizedAccountingRejectedResult,
  type RealizedAccountingRejectionReason,
  type RealizedMatch,
  type RealizedTradeAccounting,
  type RealizedTradeAccountingResult,
} from "./types.js";

const ZERO = nonNegativeDecimalString("0");

interface MutableBasisLot {
  readonly entryFillId: string;
  readonly entryPrice: PositiveDecimalString;
  readonly originalQuantity: PositiveDecimalString;
  remainingQuantity: NonNegativeDecimalString;
  readonly entryFilledAt: FillEvent["filledAt"];
}

type ChronologyEvent =
  | { readonly kind: "ENTRY"; readonly sourceIndex: number; readonly event: FillEvent }
  | { readonly kind: "EXIT"; readonly sourceIndex: number; readonly event: ExitFillEvent };

function rejected(reason: RealizedAccountingRejectionReason): RealizedAccountingRejectedResult;
function rejected(
  reason: "POSITION_EXPOSURE_REJECTED",
  positionProjection: PositionExposureRejectedResult,
): RealizedAccountingRejectedResult;
function rejected(
  reason: RealizedAccountingRejectionReason,
  positionProjection?: PositionExposureRejectedResult,
): RealizedAccountingRejectedResult {
  return positionProjection === undefined
    ? Object.freeze({ status: "REALIZED_ACCOUNTING_REJECTED", reason })
    : Object.freeze({ status: "REALIZED_ACCOUNTING_REJECTED", reason, positionProjection });
}

function validateEntryHistory(attempt: ExecutionAttempt): readonly FillEvent[] | undefined {
  if (!Array.isArray(attempt.processedFills)) return undefined;
  const validated: FillEvent[] = [];
  let previousAt: number | undefined;
  try {
    for (const fill of attempt.processedFills) {
      const canonical = createFillEvent(fill);
      if (
        fill.kind !== "FILL"
        || canonical.executionAttemptId !== attempt.executionAttemptId
        || attempt.adapterOrderId === undefined
        || canonical.adapterOrderId !== attempt.adapterOrderId
        || (previousAt !== undefined && canonical.filledAt < previousAt)
      ) return undefined;
      previousAt = canonical.filledAt;
      validated.push(canonical);
    }
  } catch {
    return undefined;
  }
  return validated;
}

function validateExitHistory(attempt: ExecutionAttempt): readonly ExitFillEvent[] | undefined {
  if (!Array.isArray(attempt.processedExitFills)) return undefined;
  const validated: ExitFillEvent[] = [];
  let previousAt: number | undefined;
  try {
    for (const fill of attempt.processedExitFills) {
      const canonical = createExitFillEvent(fill);
      if (
        fill.kind !== "EXIT_FILL"
        || canonical.executionAttemptId !== attempt.executionAttemptId
        || canonical.exitSide !== attempt.exitSide
        || (previousAt !== undefined && canonical.filledAt < previousAt)
      ) return undefined;
      previousAt = canonical.filledAt;
      validated.push(canonical);
    }
  } catch {
    return undefined;
  }
  return validated;
}

function sumQuantities(fills: readonly (FillEvent | ExitFillEvent)[]): NonNegativeDecimalString {
  let total: DecimalString = ZERO;
  for (const fill of fills) total = addDecimal(total, fill.filledQuantity);
  return nonNegativeDecimalString(total);
}

function hasDuplicateFillId(entries: readonly FillEvent[], exits: readonly ExitFillEvent[]): boolean {
  const ids = new Set<string>();
  for (const fill of [...entries, ...exits]) {
    if (ids.has(fill.fillId)) return true;
    ids.add(fill.fillId);
  }
  return false;
}

function hasAmbiguousCrossKindTimestamp(entries: readonly FillEvent[], exits: readonly ExitFillEvent[]): boolean {
  const entryTimes = new Set<number>(entries.map((fill) => fill.filledAt));
  return exits.some((fill) => entryTimes.has(fill.filledAt));
}

function chronology(entries: readonly FillEvent[], exits: readonly ExitFillEvent[]): readonly ChronologyEvent[] {
  const events: ChronologyEvent[] = [
    ...entries.map((event, sourceIndex) => ({ kind: "ENTRY" as const, sourceIndex, event })),
    ...exits.map((event, sourceIndex) => ({ kind: "EXIT" as const, sourceIndex, event })),
  ];
  events.sort((left, right) => {
    const leftAt = left.event.filledAt;
    const rightAt = right.event.filledAt;
    if (leftAt !== rightAt) return leftAt < rightAt ? -1 : 1;
    return left.sourceIndex < right.sourceIndex ? -1 : left.sourceIndex > right.sourceIndex ? 1 : 0;
  });
  return events;
}

function matchPnl(
  direction: PositionExposure["direction"],
  entryPrice: PositiveDecimalString,
  exitPrice: PositiveDecimalString,
  quantity: PositiveDecimalString,
  multiplier: PositiveDecimalString,
): DecimalString {
  const priceDelta = direction === "LONG"
    ? subtractDecimal(exitPrice, entryPrice)
    : subtractDecimal(entryPrice, exitPrice);
  return multiplyDecimal(multiplyDecimal(priceDelta, quantity), multiplier);
}

function validateSpec(
  attempt: ExecutionAttempt,
  input: LinearInstrumentSizingSpec,
): LinearInstrumentSizingSpec | RealizedAccountingRejectedResult {
  if ((input as { readonly valuationModel?: unknown } | null)?.valuationModel !== "LINEAR_PRICE_PNL") {
    return rejected("UNSUPPORTED_VALUATION_MODEL");
  }
  try {
    instrumentId(attempt.instrumentId);
    const spec = createLinearInstrumentSizingSpec(input);
    if (spec.instrumentId !== attempt.instrumentId) return rejected("VALUATION_SPEC_INSTRUMENT_MISMATCH");
    if (spec.quantityUnit !== attempt.quantityUnit) return rejected("INVALID_ACCOUNTING_INPUT");
    return spec;
  } catch {
    return rejected("INVALID_ACCOUNTING_INPUT");
  }
}

/** Purely replays one authoritative execution attempt into exact FIFO realized accounting. */
export function projectRealizedTradeAccounting(
  attempt: ExecutionAttempt,
  accountingSpec: LinearInstrumentSizingSpec,
): RealizedTradeAccountingResult {
  const positionProjection = projectPositionExposure(attempt);
  if (positionProjection.status === "POSITION_EXPOSURE_REJECTED") {
    return rejected("POSITION_EXPOSURE_REJECTED", positionProjection);
  }
  const exposure = positionProjection.positionExposure;
  const spec = validateSpec(attempt, accountingSpec);
  if ("status" in spec) return spec;

  const entries = validateEntryHistory(attempt);
  if (entries === undefined || compareDecimal(sumQuantities(entries), exposure.filledEntryQuantity) !== 0) {
    return rejected("ENTRY_FILL_HISTORY_INCOHERENT");
  }
  const exits = validateExitHistory(attempt);
  if (exits === undefined || compareDecimal(sumQuantities(exits), exposure.exitedQuantity) !== 0) {
    return rejected("EXIT_FILL_HISTORY_INCOHERENT");
  }
  if (hasDuplicateFillId(entries, exits)) return rejected("DUPLICATE_FILL_ID");
  if (hasAmbiguousCrossKindTimestamp(entries, exits)) return rejected("AMBIGUOUS_FILL_CHRONOLOGY");

  const lots: MutableBasisLot[] = [];
  const matches: RealizedMatch[] = [];
  let grossRealizedPnl: DecimalString = decimalString("0");
  for (const item of chronology(entries, exits)) {
    if (item.kind === "ENTRY") {
      lots.push({
        entryFillId: item.event.fillId,
        entryPrice: item.event.fillPrice,
        originalQuantity: item.event.filledQuantity,
        remainingQuantity: item.event.filledQuantity,
        entryFilledAt: item.event.filledAt,
      });
      continue;
    }

    let exitRemaining: NonNegativeDecimalString = item.event.filledQuantity;
    for (const lot of lots) {
      if (compareDecimal(exitRemaining, ZERO) === 0) break;
      if (compareDecimal(lot.remainingQuantity, ZERO) === 0) continue;
      const matched = compareDecimal(lot.remainingQuantity, exitRemaining) <= 0
        ? lot.remainingQuantity
        : exitRemaining;
      const matchedQuantity = positiveDecimalString(matched);
      const pnl = matchPnl(
        exposure.direction,
        lot.entryPrice,
        item.event.fillPrice,
        matchedQuantity,
        spec.pnlValuePerPriceUnitPerQuantity,
      );
      matches.push(Object.freeze({
        entryFillId: lot.entryFillId,
        exitFillId: item.event.fillId,
        exitLeg: item.event.exitLeg,
        matchedQuantity,
        entryPrice: lot.entryPrice,
        exitPrice: item.event.fillPrice,
        grossRealizedPnl: pnl,
        entryFilledAt: lot.entryFilledAt,
        exitFilledAt: item.event.filledAt,
      }));
      grossRealizedPnl = addDecimal(grossRealizedPnl, pnl);
      lot.remainingQuantity = subtractNonNegative(lot.remainingQuantity, matchedQuantity);
      exitRemaining = subtractNonNegative(exitRemaining, matchedQuantity);
    }
    if (compareDecimal(exitRemaining, ZERO) !== 0) return rejected("EXIT_WITHOUT_AVAILABLE_BASIS");
  }

  const openBasisLots: OpenBasisLot[] = lots
    .filter((lot) => compareDecimal(lot.remainingQuantity, ZERO) > 0)
    .map((lot) => Object.freeze({
      entryFillId: lot.entryFillId,
      entryPrice: lot.entryPrice,
      originalQuantity: lot.originalQuantity,
      remainingQuantity: positiveDecimalString(lot.remainingQuantity),
      entryFilledAt: lot.entryFilledAt,
    }));
  const openBasisQuantity = openBasisLots.reduce<DecimalString>(
    (total, lot) => addDecimal(total, lot.remainingQuantity),
    ZERO,
  );
  if (compareDecimal(openBasisQuantity, exposure.openQuantity) !== 0) {
    return rejected("FINAL_OPEN_BASIS_INCOHERENT");
  }
  if (exposure.exposureState === "CLOSED" && openBasisLots.length !== 0) {
    return rejected("FINAL_OPEN_BASIS_INCOHERENT");
  }

  const accounting: RealizedTradeAccounting = Object.freeze({
    schemaVersion: REALIZED_TRADE_ACCOUNTING_SCHEMA_VERSION,
    executionAttemptId: attempt.executionAttemptId,
    executionPlanId: attempt.executionPlanId,
    tradeIntentId: attempt.tradeIntentId,
    candidateId: attempt.candidateId,
    instrumentId: attempt.instrumentId,
    accountingMethod: "FIFO_V1",
    direction: exposure.direction,
    valuationModel: spec.valuationModel,
    pnlCurrency: spec.pnlCurrency,
    pnlValuePerPriceUnitPerQuantity: spec.pnlValuePerPriceUnitPerQuantity,
    filledEntryQuantity: exposure.filledEntryQuantity,
    exitedQuantity: exposure.exitedQuantity,
    openQuantity: exposure.openQuantity,
    grossRealizedPnl,
    realizedMatches: Object.freeze(matches),
    openBasisLots: Object.freeze(openBasisLots),
    accountingAsOf: exposure.executionAsOf,
    positionExposure: exposure,
  });
  return Object.freeze({ status: "REALIZED_ACCOUNTING_PROJECTED", accounting });
}

export class TradeAccountingEngine {
  project(
    attempt: ExecutionAttempt,
    accountingSpec: LinearInstrumentSizingSpec,
  ): RealizedTradeAccountingResult {
    return projectRealizedTradeAccounting(attempt, accountingSpec);
  }
}
