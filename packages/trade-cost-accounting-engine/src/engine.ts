import { addDecimal, subtractDecimal } from "@ulte/exact-decimal";
import { decimalString, type DecimalString } from "@ulte/instrument-model";
import { projectRealizedTradeAccounting } from "@ulte/trade-accounting-engine";
import { createTradeCostEvent } from "./cost-event.js";
import {
  TRADE_COST_ACCOUNTING_SCHEMA_VERSION,
  TRADE_COST_EVENT_SCHEMA_VERSION,
  type AuthoritativeCostAccountingAttempt,
  type TradeCostAccounting,
  type TradeCostAccountingRejectedResult,
  type TradeCostAccountingRejectionReason,
  type TradeCostAccountingResult,
  type TradeCostAccountingSpec,
  type TradeCostEvent,
} from "./types.js";

const ZERO = decimalString("0");

function rejected(reason: TradeCostAccountingRejectionReason): TradeCostAccountingRejectedResult {
  return Object.freeze({ status: "TRADE_COST_ACCOUNTING_REJECTED", reason });
}

function canonicalEvents(events: readonly TradeCostEvent[]): readonly TradeCostEvent[] | undefined {
  const validated: TradeCostEvent[] = [];
  try {
    for (const event of events) {
      if ((event as { readonly schemaVersion?: unknown } | null)?.schemaVersion !== TRADE_COST_EVENT_SCHEMA_VERSION) {
        return undefined;
      }
      validated.push(createTradeCostEvent(event));
    }
  } catch {
    return undefined;
  }
  validated.sort((left, right) => {
    if (left.effectiveAt !== right.effectiveAt) return left.effectiveAt < right.effectiveAt ? -1 : 1;
    return left.costEventId < right.costEventId ? -1 : left.costEventId > right.costEventId ? 1 : 0;
  });
  return Object.freeze(validated);
}

function isCoherent(
  accounting: TradeCostAccounting,
  preparedAsOf: AuthoritativeCostAccountingAttempt["preparedAsOf"],
): boolean {
  return accounting.realizedAccounting.executionAttemptId === accounting.executionAttemptId
    && accounting.realizedAccounting.instrumentId === accounting.instrumentId
    && accounting.positionExposure === accounting.realizedAccounting.positionExposure
    && accounting.costAccountingAsOf >= accounting.realizedAccounting.accountingAsOf
    && accounting.costEventCount === accounting.costEvents.length
    && accounting.costEvents.every((event) =>
      event.executionAttemptId === accounting.executionAttemptId
      && event.instrumentId === accounting.instrumentId
      && event.currency === accounting.pnlCurrency
      && event.effectiveAt >= preparedAsOf);
}

/** Projects one authoritative attempt and its explicit monetary cost ledger. */
export function projectTradeCostAccounting(
  executionAttempt: AuthoritativeCostAccountingAttempt,
  accountingSpec: TradeCostAccountingSpec,
  costEvents: readonly TradeCostEvent[],
): TradeCostAccountingResult {
  const realizedProjection = projectRealizedTradeAccounting(executionAttempt, accountingSpec);
  if (realizedProjection.status === "REALIZED_ACCOUNTING_REJECTED") {
    return Object.freeze({
      status: "TRADE_COST_ACCOUNTING_REJECTED",
      reason: "REALIZED_ACCOUNTING_REJECTED",
      realizedAccountingProjection: realizedProjection,
    });
  }
  const realizedAccounting = realizedProjection.accounting;
  const events = canonicalEvents(costEvents);
  if (events === undefined) return rejected("COST_EVENT_INVALID");

  let grossDebitCostAmount: DecimalString = ZERO;
  let grossCreditCostAmount: DecimalString = ZERO;
  let costAccountingAsOf = realizedAccounting.accountingAsOf;
  const costEventIds = new Set<string>();
  for (const event of events) {
    if (costEventIds.has(event.costEventId)) return rejected("DUPLICATE_COST_EVENT_ID");
    costEventIds.add(event.costEventId);
    if (event.executionAttemptId !== realizedAccounting.executionAttemptId) {
      return rejected("COST_EVENT_EXECUTION_ATTEMPT_MISMATCH");
    }
    if (event.instrumentId !== realizedAccounting.instrumentId) {
      return rejected("COST_EVENT_INSTRUMENT_MISMATCH");
    }
    if (event.currency !== realizedAccounting.pnlCurrency) {
      return rejected("COST_EVENT_CURRENCY_MISMATCH");
    }
    if (event.effectiveAt < executionAttempt.preparedAsOf) {
      return rejected("COST_EVENT_PRECEDES_ATTEMPT");
    }
    if (event.effect === "DEBIT") {
      grossDebitCostAmount = addDecimal(grossDebitCostAmount, event.amount);
    } else {
      grossCreditCostAmount = addDecimal(grossCreditCostAmount, event.amount);
    }
    if (event.effectiveAt > costAccountingAsOf) costAccountingAsOf = event.effectiveAt;
  }

  const accounting: TradeCostAccounting = Object.freeze({
    schemaVersion: TRADE_COST_ACCOUNTING_SCHEMA_VERSION,
    executionAttemptId: realizedAccounting.executionAttemptId,
    executionPlanId: realizedAccounting.executionPlanId,
    tradeIntentId: realizedAccounting.tradeIntentId,
    candidateId: realizedAccounting.candidateId,
    instrumentId: realizedAccounting.instrumentId,
    pnlCurrency: realizedAccounting.pnlCurrency,
    grossDebitCostAmount,
    grossCreditCostAmount,
    netCostAmount: subtractDecimal(grossDebitCostAmount, grossCreditCostAmount),
    costEventCount: events.length,
    costEvents: events,
    executionAccountingAsOf: realizedAccounting.accountingAsOf,
    costAccountingAsOf,
    positionExposure: realizedAccounting.positionExposure,
    realizedAccounting,
  });
  if (!isCoherent(accounting, executionAttempt.preparedAsOf)) {
    return rejected("COST_ACCOUNTING_INCOHERENT");
  }
  return Object.freeze({ status: "TRADE_COST_ACCOUNTING_PROJECTED", accounting });
}

export class TradeCostAccountingEngine {
  project(
    executionAttempt: AuthoritativeCostAccountingAttempt,
    accountingSpec: TradeCostAccountingSpec,
    costEvents: readonly TradeCostEvent[],
  ): TradeCostAccountingResult {
    return projectTradeCostAccounting(executionAttempt, accountingSpec, costEvents);
  }
}
