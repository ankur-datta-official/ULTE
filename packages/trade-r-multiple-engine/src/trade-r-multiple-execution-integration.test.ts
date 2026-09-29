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
import { createInstrumentId, currencyCode, positiveDecimalString, unixMs } from "@ulte/instrument-model";
import type { ReadyExecutionPlan } from "@ulte/execution-preparation-engine";
import { projectNetTradePerformanceSnapshot } from "@ulte/net-trade-performance-engine";
import { createLinearInstrumentSizingSpec } from "@ulte/position-sizing-engine";
import { createTradeCostEvent, type TradeCostEvent, type TradeCostType } from "@ulte/trade-cost-accounting-engine";
import { createValuationMark } from "@ulte/trade-valuation-engine";
import {
  createTradeRiskBasisFromExecutionAttempt,
  projectTradeRMultipleFromAuthorities,
  projectTradeRMultipleSnapshot,
  type TradeRiskBasis,
} from "./index.js";

const instrument = createInstrumentId({ venue: "TEST", venueSymbol: "R-INTEGRATION", instrumentKind: "CFD" });
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

function plan(direction: "UP" | "DOWN" = "UP"): ReadyExecutionPlan {
  const quantity = positiveDecimalString("5");
  const isLong = direction === "UP";
  const entrySide = isLong ? "BUY" : "SELL";
  const exitSide = isLong ? "SELL" : "BUY";
  return Object.freeze({
    status: "EXECUTION_PLAN_READY",
    schemaVersion: "EXECUTION_PLAN_V2",
    executionPlanId: `plan-r-${direction}`,
    tradeIntentId: `intent-r-${direction}`,
    candidateId: `candidate-r-${direction}`,
    instrumentId: instrument,
    intentAsOf: unixMs(800),
    marketSnapshotAsOf: unixMs(850),
    preparedAsOf: unixMs(900),
    direction,
    entrySide,
    exitSide,
    quantity,
    quantityUnit: "contracts",
    accountCurrency: currencyCode("USD"),
    entryInstruction: Object.freeze({ kind: "ENTRY_LIMIT", side: entrySide, price: positiveDecimalString("100"), quantity, positionEffect: "OPEN" }),
    protectiveStopInstruction: Object.freeze({ kind: "PROTECTIVE_STOP_TRIGGER", side: exitSide, triggerPrice: positiveDecimalString(isLong ? "90" : "110"), quantity, positionEffect: "CLOSE" }),
    profitTargetInstruction: Object.freeze({ kind: "PROFIT_TARGET_LIMIT", side: exitSide, price: positiveDecimalString(isLong ? "130" : "70"), quantity, positionEffect: "CLOSE" }),
    priceTick: positiveDecimalString("0.01"),
    quantityStep: positiveDecimalString("0.01"),
    bidAtPreparation: positiveDecimalString("99.99"),
    askAtPreparation: positiveDecimalString("100"),
    intentAgeMs: 100,
    quoteAgeMs: 50,
    entryDeviationBps: "0",
    approvedRiskAmount: positiveDecimalString("12"),
    actualRiskAmount: positiveDecimalString("10"),
    netRewardRiskBps: "30000",
  });
}

function entered(direction: "UP" | "DOWN" = "UP", quantity = "2.75"): ExecutionAttempt {
  const created = createExecutionAttempt(plan(direction));
  if (created.status !== "EXECUTION_ATTEMPT_READY") throw new Error("attempt creation failed");
  const submitted = requestEntrySubmission(created, capabilities);
  if (submitted.status !== "ENTRY_SUBMISSION_READY") throw new Error("submission failed");
  const acknowledged = acknowledgeEntrySubmission(submitted.attempt, {
    executionAttemptId: created.executionAttemptId,
    idempotencyKey: submitted.request.idempotencyKey,
    adapterOrderId: `ORDER-R-${direction}`,
    acknowledgedAt: 1_000,
  });
  if (acknowledged.status !== "EXECUTION_ATTEMPT_UPDATED") throw new Error("acknowledgement failed");
  const filled = applyEntryFill(acknowledged.attempt, {
    executionAttemptId: created.executionAttemptId,
    adapterOrderId: `ORDER-R-${direction}`,
    fillId: "F1",
    filledQuantity: quantity,
    fillPrice: "100",
    filledAt: 1_001,
  });
  if (filled.status !== "EXECUTION_ATTEMPT_UPDATED") throw new Error("entry fill failed");
  return filled.attempt;
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

function exit(source: ExecutionAttempt, request: ProtectionRequest, id: string, quantity: string, price: string, at: number) {
  const result = applyExitFill(source, {
    executionAttemptId: source.executionAttemptId,
    protectionRequestId: request.protectionRequestId,
    exitSide: source.exitSide,
    exitLeg: "PROFIT_TARGET",
    fillId: id,
    filledQuantity: quantity,
    fillPrice: price,
    filledAt: at,
  });
  if (result.status !== "EXECUTION_ATTEMPT_UPDATED") throw new Error("exit fill failed");
  return result.attempt;
}

function cost(source: ExecutionAttempt, id: string, type: TradeCostType, effect: "DEBIT" | "CREDIT", amount: string, at: number): TradeCostEvent {
  return createTradeCostEvent({
    costEventId: id,
    executionAttemptId: source.executionAttemptId,
    instrumentId: source.instrumentId,
    costType: type,
    effect,
    amount,
    currency: "USD",
    effectiveAt: at,
    source: "R_INTEGRATION_LEDGER",
  });
}

function net(source: ExecutionAttempt, price: string, at: number, costs: readonly TradeCostEvent[]) {
  const result = projectNetTradePerformanceSnapshot(
    source,
    accountingSpec,
    createValuationMark({ instrumentId: instrument, markPrice: price, markAsOf: at }),
    costs,
  );
  if (result.status !== "NET_TRADE_PERFORMANCE_PROJECTED") throw new Error(result.reason);
  return result.snapshot;
}

function ratio(source: ReturnType<typeof net>, basis: TradeRiskBasis) {
  const result = projectTradeRMultipleFromAuthorities(source, basis);
  if (result.status !== "TRADE_R_MULTIPLE_PROJECTED") throw new Error(result.reason);
  return result.snapshot;
}

describe("real execution and Task031A integration", () => {
  it("uses actual rather than approved risk across market, cost, lifecycle, and late-cost checkpoints", () => {
    const entry = entered();
    expect(entry).toMatchObject({ schemaVersion: "EXECUTION_ATTEMPT_V3", approvedRiskAmount: "12", actualRiskAmount: "10", accountCurrency: "USD" });
    const basisResult = createTradeRiskBasisFromExecutionAttempt(entry);
    if (basisResult.status !== "TRADE_RISK_BASIS_CREATED") throw new Error(basisResult.reason);
    const basis = basisResult.riskBasis;
    const commission = cost(entry, "C1", "COMMISSION", "DEBIT", "1.25", 1_001);
    const lowerCommission = cost(entry, "C-LOW", "COMMISSION", "DEBIT", "0.75", 1_001);

    const open = ratio(net(entry, "105", 1_001, [commission]), basis);
    const marketOnly = ratio(net(entry, "110", 1_002, [commission]), basis);
    const costOnly = ratio(net(entry, "105", 1_001, [lowerCommission]), basis);
    const both = ratio(net(entry, "110", 1_002, [lowerCommission]), basis);
    expect(open.positionExposure.exposureState).toBe("OPEN");
    expect(open.netRMultipleRatio).toEqual({ numerator: "12.5", denominator: "10" });
    expect(marketOnly.netRMultipleRatio).toEqual({ numerator: "26.25", denominator: "10" });
    expect(costOnly.netRMultipleRatio).toEqual({ numerator: "13", denominator: "10" });
    expect(both.netRMultipleRatio).toEqual({ numerator: "26.75", denominator: "10" });

    const firstProtection = protect(entry, 1_002);
    const partialAttempt = exit(firstProtection.attempt, firstProtection.request, "X1", "1.25", "105", 1_003);
    const exchange = cost(partialAttempt, "C2", "EXCHANGE_FEE", "DEBIT", "0.40", 1_003);
    const funding = cost(partialAttempt, "C3", "FUNDING", "CREDIT", "0.50", 1_002);
    const partial = ratio(net(partialAttempt, "110", 1_003, [commission, exchange, funding]), basis);
    expect(partial.positionExposure.exposureState).toBe("PARTIALLY_EXITED");
    expect(partial.netRMultipleRatio).toEqual({ numerator: "20.1", denominator: "10" });

    const flatAttempt = exit(partialAttempt, firstProtection.request, "X2", "1.5", "90", 1_004);
    const flat = ratio(net(flatAttempt, "120", 1_004, [commission]), basis);
    expect(flat.positionExposure.exposureState).toBe("FLAT_ENTRY_ACTIVE");
    expect(flat.netRMultipleRatio).toEqual({ numerator: "-10", denominator: "10" });

    const reentry = applyEntryFill(flatAttempt, {
      executionAttemptId: flatAttempt.executionAttemptId,
      adapterOrderId: "ORDER-R-UP",
      fillId: "F2",
      filledQuantity: "2.25",
      fillPrice: "110",
      filledAt: 1_005,
    });
    if (reentry.status !== "EXECUTION_ATTEMPT_UPDATED") throw new Error("reentry failed");
    const secondProtection = protect(reentry.attempt, 1_006);
    const closedAttempt = exit(secondProtection.attempt, secondProtection.request, "X3", "2.25", "120", 1_007);
    const beforeLate = ratio(net(closedAttempt, "130", 1_007, [commission]), basis);
    const broker = cost(closedAttempt, "C4", "BROKER_FEE", "DEBIT", "0.10", 1_007);
    const borrow = cost(closedAttempt, "C5", "BORROW_COST", "DEBIT", "0.15", 1_010);
    const late = ratio(net(closedAttempt, "130", 1_007, [commission, broker, borrow]), basis);
    expect(beforeLate.positionExposure.exposureState).toBe("CLOSED");
    expect(beforeLate.netRMultipleRatio).toEqual({ numerator: "12.5", denominator: "10" });
    expect(late.netRMultipleRatio).toEqual({ numerator: "12.25", denominator: "10" });
    expect(late.valuationAsOf).toBe(1_007);
    expect(late.costAccountingAsOf).toBe(1_010);

    for (const snapshot of [open, marketOnly, costOnly, both, partial, flat, beforeLate, late]) {
      expect(snapshot.riskBasis).toBe(basis);
      expect(snapshot.initialActualRiskAmount).toBe("10");
      expect(snapshot.riskBasisAsOf).toBe(900);
      expect(snapshot.netRMultipleRatio.denominator).toBe("10");
    }
  });

  it("uses one direction-independent formula for profitable and losing SHORT performance", () => {
    const short = entered("DOWN", "2");
    const basisResult = createTradeRiskBasisFromExecutionAttempt(short);
    if (basisResult.status !== "TRADE_RISK_BASIS_CREATED") throw new Error(basisResult.reason);
    const fee = cost(short, "SHORT-C1", "COMMISSION", "DEBIT", "1", 1_001);
    const profitable = ratio(net(short, "90", 1_001, [fee]), basisResult.riskBasis);
    const losing = ratio(net(short, "110", 1_002, [fee]), basisResult.riskBasis);
    expect(profitable.direction).toBe("SHORT");
    expect(profitable.netRMultipleRatio).toEqual({ numerator: "19", denominator: "10" });
    expect(losing.netRMultipleRatio).toEqual({ numerator: "-21", denominator: "10" });
  });

  it("accepts canonical zero performance and the convenience composition path", () => {
    const entry = entered();
    const netZero = net(entry, "100", 1_001, []);
    const result = projectTradeRMultipleSnapshot(entry, netZero);
    expect(result.status).toBe("TRADE_R_MULTIPLE_PROJECTED");
    if (result.status !== "TRADE_R_MULTIPLE_PROJECTED") return;
    expect(result.snapshot.netRMultipleRatio).toEqual({ numerator: "0", denominator: "10" });
  });
});
