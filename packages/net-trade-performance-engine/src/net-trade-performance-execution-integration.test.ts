import { describe, expect, it } from "vitest";
import {
  acknowledgeEntrySubmission,
  acknowledgeProtection,
  applyEntryFill,
  applyExitFill,
  createAdapterCapabilities,
  createExecutionAttempt,
  requestEntrySubmission,
  requestProtection,
  type ExecutionAttempt,
  type ProtectionRequest,
} from "@ulte/execution-engine";
import { createInstrumentId, positiveDecimalString, unixMs } from "@ulte/instrument-model";
import type { ReadyExecutionPlan } from "@ulte/execution-preparation-engine";
import { createLinearInstrumentSizingSpec } from "@ulte/position-sizing-engine";
import {
  createTradeCostEvent,
  projectTradeCostAccounting,
  type TradeCostEvent,
  type TradeCostType,
} from "@ulte/trade-cost-accounting-engine";
import { projectTradePerformanceSnapshot } from "@ulte/trade-performance-engine";
import { createValuationMark } from "@ulte/trade-valuation-engine";
import {
  projectNetTradePerformanceFromAuthorities,
  projectNetTradePerformanceSnapshot,
} from "./index.js";

const instrument = createInstrumentId({ venue: "TEST", venueSymbol: "ABC", instrumentKind: "CFD" });
const capabilities = createAdapterCapabilities({
  supportsClientIdempotency: false,
  supportsCloseOnlyExit: true,
  supportsNativeBracketProtection: false,
  supportsProtectionModification: true,
  supportsOrderCancellation: true,
  supportsPartialFillReporting: true,
});
const accountingSpec = createLinearInstrumentSizingSpec({
  valuationModel: "LINEAR_PRICE_PNL",
  instrumentId: instrument,
  pnlCurrency: "USD",
  quantityUnit: "contracts",
  quantityStep: "0.01",
  minimumQuantity: "0.01",
  maximumQuantity: "100",
  pnlValuePerPriceUnitPerQuantity: "1",
});

function plan(): ReadyExecutionPlan {
  const quantity = positiveDecimalString("5");
  return Object.freeze({
    status: "EXECUTION_PLAN_READY",
    schemaVersion: "EXECUTION_PLAN_V1",
    executionPlanId: "plan-net-integration",
    tradeIntentId: "intent-net-integration",
    candidateId: "candidate-net-integration",
    instrumentId: instrument,
    intentAsOf: unixMs(800),
    marketSnapshotAsOf: unixMs(850),
    preparedAsOf: unixMs(900),
    direction: "UP",
    entrySide: "BUY",
    exitSide: "SELL",
    quantity,
    quantityUnit: "contracts",
    entryInstruction: Object.freeze({ kind: "ENTRY_LIMIT", side: "BUY", price: positiveDecimalString("100"), quantity, positionEffect: "OPEN" }),
    protectiveStopInstruction: Object.freeze({ kind: "PROTECTIVE_STOP_TRIGGER", side: "SELL", triggerPrice: positiveDecimalString("90"), quantity, positionEffect: "CLOSE" }),
    profitTargetInstruction: Object.freeze({ kind: "PROFIT_TARGET_LIMIT", side: "SELL", price: positiveDecimalString("130"), quantity, positionEffect: "CLOSE" }),
    priceTick: positiveDecimalString("0.01"),
    quantityStep: positiveDecimalString("0.01"),
    bidAtPreparation: positiveDecimalString("99.99"),
    askAtPreparation: positiveDecimalString("100"),
    intentAgeMs: 100,
    quoteAgeMs: 50,
    entryDeviationBps: "0",
    approvedRiskAmount: positiveDecimalString("50"),
    actualRiskAmount: positiveDecimalString("50"),
    netRewardRiskBps: "30000",
  });
}

function entered(): ExecutionAttempt {
  const created = createExecutionAttempt(plan());
  if (created.status !== "EXECUTION_ATTEMPT_READY") throw new Error("attempt creation failed");
  const submitted = requestEntrySubmission(created, capabilities);
  if (submitted.status !== "ENTRY_SUBMISSION_READY") throw new Error("submission request failed");
  const acknowledged = acknowledgeEntrySubmission(submitted.attempt, {
    executionAttemptId: created.executionAttemptId,
    idempotencyKey: submitted.request.idempotencyKey,
    adapterOrderId: "ORDER-NET-INTEGRATION",
    acknowledgedAt: 1_000,
  });
  if (acknowledged.status !== "EXECUTION_ATTEMPT_UPDATED") throw new Error("acknowledgement failed");
  const fill = applyEntryFill(acknowledged.attempt, {
    executionAttemptId: created.executionAttemptId,
    adapterOrderId: "ORDER-NET-INTEGRATION",
    fillId: "F1",
    filledQuantity: "2.75",
    fillPrice: "100",
    filledAt: 1_001,
  });
  if (fill.status !== "EXECUTION_ATTEMPT_UPDATED") throw new Error("entry fill failed");
  return fill.attempt;
}

function protect(source: ExecutionAttempt, at: number) {
  const requested = requestProtection(source);
  if (requested.status !== "PROTECTION_REQUEST_READY") throw new Error("protection request failed");
  const accepted = acknowledgeProtection(requested.attempt, {
    executionAttemptId: source.executionAttemptId,
    protectionRequestId: requested.request.protectionRequestId,
    idempotencyKey: requested.request.idempotencyKey,
    protectedQuantity: requested.request.targetCumulativeProtectedQuantity,
    acknowledgedAt: at,
  });
  if (accepted.status !== "EXECUTION_ATTEMPT_UPDATED") throw new Error("protection acknowledgement failed");
  return { attempt: accepted.attempt, request: requested.request };
}

function exit(
  source: ExecutionAttempt,
  request: ProtectionRequest,
  fillId: string,
  quantity: string,
  price: string,
  at: number,
): ExecutionAttempt {
  const result = applyExitFill(source, {
    executionAttemptId: source.executionAttemptId,
    protectionRequestId: request.protectionRequestId,
    exitSide: source.exitSide,
    exitLeg: "PROFIT_TARGET",
    fillId,
    filledQuantity: quantity,
    fillPrice: price,
    filledAt: at,
  });
  if (result.status !== "EXECUTION_ATTEMPT_UPDATED") throw new Error("exit fill failed");
  return result.attempt;
}

function cost(
  source: ExecutionAttempt,
  id: string,
  costType: TradeCostType,
  effect: "DEBIT" | "CREDIT",
  amount: string,
  effectiveAt: number,
): TradeCostEvent {
  return createTradeCostEvent({
    costEventId: id,
    executionAttemptId: source.executionAttemptId,
    instrumentId: source.instrumentId,
    costType,
    effect,
    amount,
    currency: "USD",
    effectiveAt,
    source: "NET_INTEGRATION_LEDGER",
  });
}

function projected(
  source: ExecutionAttempt,
  price: string,
  markAsOf: number,
  costs: readonly TradeCostEvent[],
) {
  const result = projectNetTradePerformanceSnapshot(
    source,
    accountingSpec,
    createValuationMark({ instrumentId: instrument, markPrice: price, markAsOf }),
    costs,
  );
  expect(result.status).toBe("NET_TRADE_PERFORMANCE_PROJECTED");
  if (result.status !== "NET_TRADE_PERFORMANCE_PROJECTED") throw new Error(result.reason);
  return result.snapshot;
}

describe("real execution lifecycle to authoritative net performance", () => {
  it("projects open, partial, flat-active, reopened, closed, and late-cost checkpoints", () => {
    const entry = entered();
    const commission = cost(entry, "C1", "COMMISSION", "DEBIT", "1.25", 1_001);
    const open = projected(entry, "105", 1_001, [commission]);
    expect(open.positionExposure.exposureState).toBe("OPEN");
    expect(open).toMatchObject({ grossTotalPnl: "13.75", netCostAmount: "1.25", netTotalPnl: "12.5" });

    const firstProtection = protect(entry, 1_002);
    const partialAttempt = exit(firstProtection.attempt, firstProtection.request, "X1", "1.25", "105", 1_003);
    const exchange = cost(partialAttempt, "C2", "EXCHANGE_FEE", "DEBIT", "0.40", 1_003);
    const funding = cost(partialAttempt, "C3", "FUNDING", "CREDIT", "0.50", 1_002);
    const partial = projected(partialAttempt, "110", 1_003, [commission, exchange, funding]);
    expect(partial.positionExposure.exposureState).toBe("PARTIALLY_EXITED");
    expect(partial).toMatchObject({ grossTotalPnl: "21.25", netCostAmount: "1.15", netTotalPnl: "20.1" });

    const flatAttempt = exit(partialAttempt, firstProtection.request, "X2", "1.5", "90", 1_004);
    const flat = projected(flatAttempt, "120", 1_004, [commission]);
    expect(flat.positionExposure.exposureState).toBe("FLAT_ENTRY_ACTIVE");
    expect(flat).toMatchObject({ grossTotalPnl: "-8.75", netTotalPnl: "-10" });

    const reentry = applyEntryFill(flatAttempt, {
      executionAttemptId: flatAttempt.executionAttemptId,
      adapterOrderId: "ORDER-NET-INTEGRATION",
      fillId: "F2",
      filledQuantity: "2.25",
      fillPrice: "110",
      filledAt: 1_005,
    });
    if (reentry.status !== "EXECUTION_ATTEMPT_UPDATED") throw new Error("reentry failed");
    const reopened = projected(reentry.attempt, "120", 1_005, [commission]);
    expect(reopened).toMatchObject({ grossTotalPnl: "13.75", netTotalPnl: "12.5" });

    const secondProtection = protect(reentry.attempt, 1_006);
    const closedAttempt = exit(secondProtection.attempt, secondProtection.request, "X3", "2.25", "120", 1_007);
    const broker = cost(closedAttempt, "C4", "BROKER_FEE", "DEBIT", "0.10", 1_007);
    const borrow = cost(closedAttempt, "C5", "BORROW_COST", "DEBIT", "0.25", 1_010);
    const closed = projected(closedAttempt, "130", 1_007, [commission, exchange, funding, broker, borrow]);
    expect(closed.positionExposure.exposureState).toBe("CLOSED");
    expect(closed).toMatchObject({
      grossTotalPnl: "13.75",
      netCostAmount: "1.5",
      netTotalPnl: "12.25",
      executionAccountingAsOf: 1_007,
      valuationAsOf: 1_007,
      costAccountingAsOf: 1_010,
    });
  });

  it("composes independently established Task029A and Task030A authorities by reference", () => {
    const source = entered();
    const mark = createValuationMark({ instrumentId: instrument, markPrice: "105", markAsOf: 1_001 });
    const grossResult = projectTradePerformanceSnapshot(source, accountingSpec, mark);
    const costResult = projectTradeCostAccounting(source, accountingSpec, [
      cost(source, "C1", "COMMISSION", "DEBIT", "1.25", 1_001),
    ]);
    if (grossResult.status !== "TRADE_PERFORMANCE_PROJECTED") throw new Error(grossResult.reason);
    if (costResult.status !== "TRADE_COST_ACCOUNTING_PROJECTED") throw new Error(costResult.reason);
    const result = projectNetTradePerformanceFromAuthorities(grossResult.snapshot, costResult.accounting);
    expect(result.status).toBe("NET_TRADE_PERFORMANCE_PROJECTED");
    if (result.status !== "NET_TRADE_PERFORMANCE_PROJECTED") return;
    expect(result.snapshot.grossPerformance).toBe(grossResult.snapshot);
    expect(result.snapshot.costAccounting).toBe(costResult.accounting);
    expect(result.snapshot.positionExposure).toBe(grossResult.snapshot.positionExposure);
  });
});
