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
import { createTradeCostEvent, projectTradeCostAccounting, type TradeCostEvent } from "./index.js";

const instrument = createInstrumentId({ venue: "TEST", venueSymbol: "ABC", instrumentKind: "CFD" });

function plan(direction: "UP" | "DOWN" = "UP", quantityValue = "2.75"): ReadyExecutionPlan {
  const quantity = positiveDecimalString(quantityValue);
  const isLong = direction === "UP";
  const entrySide = isLong ? "BUY" : "SELL";
  const exitSide = isLong ? "SELL" : "BUY";
  return Object.freeze({
    status: "EXECUTION_PLAN_READY",
    schemaVersion: "EXECUTION_PLAN_V1",
    executionPlanId: `plan-cost-${direction}`,
    tradeIntentId: `intent-cost-${direction}`,
    candidateId: `candidate-cost-${direction}`,
    instrumentId: instrument,
    intentAsOf: unixMs(800),
    marketSnapshotAsOf: unixMs(850),
    preparedAsOf: unixMs(900),
    direction,
    entrySide,
    exitSide,
    quantity,
    quantityUnit: "contracts",
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
    approvedRiskAmount: positiveDecimalString("50"),
    actualRiskAmount: positiveDecimalString("50"),
    netRewardRiskBps: "30000",
  });
}

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

function entered(direction: "UP" | "DOWN" = "UP", quantity = "2.75"): ExecutionAttempt {
  const created = createExecutionAttempt(plan(direction, quantity));
  expect(created.status).toBe("EXECUTION_ATTEMPT_READY");
  if (created.status !== "EXECUTION_ATTEMPT_READY") throw new Error("attempt creation failed");
  const submitted = requestEntrySubmission(created, capabilities);
  expect(submitted.status).toBe("ENTRY_SUBMISSION_READY");
  if (submitted.status !== "ENTRY_SUBMISSION_READY") throw new Error("submission request failed");
  const acknowledged = acknowledgeEntrySubmission(submitted.attempt, {
    executionAttemptId: created.executionAttemptId,
    idempotencyKey: submitted.request.idempotencyKey,
    adapterOrderId: `ORDER-COST-${direction}`,
    acknowledgedAt: 1_000,
  });
  expect(acknowledged.status).toBe("EXECUTION_ATTEMPT_UPDATED");
  const fill = applyEntryFill(acknowledged.attempt, {
    executionAttemptId: created.executionAttemptId,
    adapterOrderId: `ORDER-COST-${direction}`,
    fillId: `FILL-COST-${direction}`,
    filledQuantity: quantity,
    fillPrice: "100",
    filledAt: 1_001,
  });
  expect(fill.status).toBe("EXECUTION_ATTEMPT_UPDATED");
  return fill.attempt;
}

function protect(attempt: ExecutionAttempt): { readonly attempt: ExecutionAttempt; readonly request: ProtectionRequest } {
  const requested = requestProtection(attempt);
  expect(requested.status).toBe("PROTECTION_REQUEST_READY");
  if (requested.status !== "PROTECTION_REQUEST_READY") throw new Error("protection request failed");
  const acknowledged = acknowledgeProtection(requested.attempt, {
    executionAttemptId: attempt.executionAttemptId,
    protectionRequestId: requested.request.protectionRequestId,
    idempotencyKey: requested.request.idempotencyKey,
    protectedQuantity: requested.request.targetCumulativeProtectedQuantity,
    acknowledgedAt: 1_002,
  });
  expect(acknowledged.status).toBe("EXECUTION_ATTEMPT_UPDATED");
  return { attempt: acknowledged.attempt, request: requested.request };
}

function exit(attempt: ExecutionAttempt, request: ProtectionRequest, id: string, quantity: string, at: number): ExecutionAttempt {
  const result = applyExitFill(attempt, {
    executionAttemptId: attempt.executionAttemptId,
    protectionRequestId: request.protectionRequestId,
    exitSide: attempt.exitSide,
    exitLeg: "PROFIT_TARGET",
    fillId: id,
    filledQuantity: quantity,
    fillPrice: attempt.entrySide === "BUY" ? "105" : "95",
    filledAt: at,
  });
  expect(result.status).toBe("EXECUTION_ATTEMPT_UPDATED");
  return result.attempt;
}

function cost(
  attempt: ExecutionAttempt,
  id: string,
  costType: "COMMISSION" | "EXCHANGE_FEE" | "BROKER_FEE" | "FUNDING" | "BORROW_COST",
  effect: "DEBIT" | "CREDIT",
  amount: string,
  effectiveAt: number,
): TradeCostEvent {
  return createTradeCostEvent({
    costEventId: id,
    executionAttemptId: attempt.executionAttemptId,
    instrumentId: attempt.instrumentId,
    costType,
    effect,
    amount,
    currency: "USD",
    effectiveAt,
    source: "EXECUTION_INTEGRATION_LEDGER",
  });
}

function projected(attempt: ExecutionAttempt, events: readonly TradeCostEvent[]) {
  const result = projectTradeCostAccounting(attempt, accountingSpec, events);
  expect(result.status).toBe("TRADE_COST_ACCOUNTING_PROJECTED");
  if (result.status !== "TRADE_COST_ACCOUNTING_PROJECTED") throw new Error(result.reason);
  return result.accounting;
}

describe("real execution lifecycle to authoritative trade cost accounting", () => {
  it("projects entry, partial exit, close, and late post-close costs", () => {
    const entry = entered();
    const commission = cost(entry, "C1", "COMMISSION", "DEBIT", "1.25", 1_001);
    const checkpointA = projected(entry, [commission]);
    expect(checkpointA).toMatchObject({ grossDebitCostAmount: "1.25", grossCreditCostAmount: "0", netCostAmount: "1.25" });
    expect(checkpointA.positionExposure.exposureState).toBe("OPEN");

    const protectedEntry = protect(entry);
    const partial = exit(protectedEntry.attempt, protectedEntry.request, "X1", "1.25", 1_003);
    const exchangeFee = cost(partial, "C2", "EXCHANGE_FEE", "DEBIT", "0.40", 1_003);
    const funding = cost(partial, "C3", "FUNDING", "CREDIT", "0.50", 1_002);
    const checkpointB = projected(partial, [exchangeFee, commission, funding]);
    expect(checkpointB).toMatchObject({ grossDebitCostAmount: "1.65", grossCreditCostAmount: "0.5", netCostAmount: "1.15" });
    expect(checkpointB.positionExposure.exposureState).toBe("PARTIALLY_EXITED");

    const closed = exit(partial, protectedEntry.request, "X2", "1.5", 1_007);
    const brokerFee = cost(closed, "C4", "BROKER_FEE", "DEBIT", "0.10", 1_007);
    const borrowCost = cost(closed, "C5", "BORROW_COST", "DEBIT", "0.25", 1_010);
    const checkpointC = projected(closed, [borrowCost, funding, exchangeFee, brokerFee, commission]);
    expect(checkpointC).toMatchObject({
      grossDebitCostAmount: "2",
      grossCreditCostAmount: "0.5",
      netCostAmount: "1.5",
      executionAccountingAsOf: 1_007,
      costAccountingAsOf: 1_010,
    });
    expect(checkpointC.positionExposure.exposureState).toBe("CLOSED");
    expect(checkpointC).not.toHaveProperty("netTotalPnl");
  });

  it("aggregates costs identically for a real SHORT attempt", () => {
    const short = entered("DOWN", "1");
    const accounting = projected(short, [
      cost(short, "S1", "COMMISSION", "DEBIT", "1.25", 1_001),
      cost(short, "S2", "FUNDING", "CREDIT", "0.25", 1_001),
    ]);
    expect(accounting.positionExposure.direction).toBe("SHORT");
    expect(accounting).toMatchObject({ grossDebitCostAmount: "1.25", grossCreditCostAmount: "0.25", netCostAmount: "1" });
  });
});
