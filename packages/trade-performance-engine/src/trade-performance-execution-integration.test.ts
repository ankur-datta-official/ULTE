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
import {
  currencyCode, createInstrumentId, positiveDecimalString, unixMs } from "@ulte/instrument-model";
import type { ReadyExecutionPlan } from "@ulte/execution-preparation-engine";
import { createLinearInstrumentSizingSpec } from "@ulte/position-sizing-engine";
import { createValuationMark } from "@ulte/trade-valuation-engine";
import { projectTradePerformanceSnapshot } from "./index.js";

const instrument = createInstrumentId({ venue: "TEST", venueSymbol: "ABC", instrumentKind: "CFD" });

function plan(): ReadyExecutionPlan {
  const quantity = positiveDecimalString("5");
  return Object.freeze({
    status: "EXECUTION_PLAN_READY",
    schemaVersion: "EXECUTION_PLAN_V2",
    executionPlanId: "plan-performance-integration",
    tradeIntentId: "intent-performance-integration",
    candidateId: "candidate-performance-integration",
    instrumentId: instrument,
    intentAsOf: unixMs(800),
    marketSnapshotAsOf: unixMs(850),
    preparedAsOf: unixMs(900),
    direction: "UP",
    entrySide: "BUY",
    exitSide: "SELL",
    quantity,
    quantityUnit: "contracts", accountCurrency: currencyCode("USD"),
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

function projected(attempt: ExecutionAttempt, markPrice: string, markAsOf: number) {
  const result = projectTradePerformanceSnapshot(
    attempt,
    accountingSpec,
    createValuationMark({ instrumentId: instrument, markPrice, markAsOf }),
  );
  expect(result.status).toBe("TRADE_PERFORMANCE_PROJECTED");
  if (result.status !== "TRADE_PERFORMANCE_PROJECTED") throw new Error(result.reason);
  return result.snapshot;
}

function protect(attempt: ExecutionAttempt, acknowledgedAt: number) {
  const requested = requestProtection(attempt);
  expect(requested.status).toBe("PROTECTION_REQUEST_READY");
  if (requested.status !== "PROTECTION_REQUEST_READY") throw new Error("protection request failed");
  const accepted = acknowledgeProtection(requested.attempt, {
    executionAttemptId: attempt.executionAttemptId,
    protectionRequestId: requested.request.protectionRequestId,
    idempotencyKey: requested.request.idempotencyKey,
    protectedQuantity: requested.request.targetCumulativeProtectedQuantity,
    acknowledgedAt,
  });
  expect(accepted.status).toBe("EXECUTION_ATTEMPT_UPDATED");
  return { attempt: accepted.attempt, request: requested.request };
}

function exit(
  attempt: ExecutionAttempt,
  request: ProtectionRequest,
  fillId: string,
  filledQuantity: string,
  fillPrice: string,
  filledAt: number,
): ExecutionAttempt {
  const result = applyExitFill(attempt, {
    executionAttemptId: attempt.executionAttemptId,
    protectionRequestId: request.protectionRequestId,
    exitSide: attempt.exitSide,
    exitLeg: "PROFIT_TARGET",
    fillId,
    filledQuantity,
    fillPrice,
    filledAt,
  });
  expect(result.status).toBe("EXECUTION_ATTEMPT_UPDATED");
  return result.attempt;
}

describe("real execution lifecycle to authoritative trade performance", () => {
  it("aggregates all five Task029A lifecycle checkpoints", () => {
    const created = createExecutionAttempt(plan());
    expect(created.status).toBe("EXECUTION_ATTEMPT_READY");
    if (created.status !== "EXECUTION_ATTEMPT_READY") throw new Error("attempt creation failed");
    const submitted = requestEntrySubmission(created, capabilities);
    expect(submitted.status).toBe("ENTRY_SUBMISSION_READY");
    if (submitted.status !== "ENTRY_SUBMISSION_READY") throw new Error("entry submission request failed");
    const acknowledged = acknowledgeEntrySubmission(submitted.attempt, {
      executionAttemptId: created.executionAttemptId,
      idempotencyKey: submitted.request.idempotencyKey,
      adapterOrderId: "ORDER-PERFORMANCE",
      acknowledgedAt: 1_000,
    });
    expect(acknowledged.status).toBe("EXECUTION_ATTEMPT_UPDATED");

    const firstEntry = applyEntryFill(acknowledged.attempt, {
      executionAttemptId: created.executionAttemptId,
      adapterOrderId: "ORDER-PERFORMANCE",
      fillId: "F1",
      filledQuantity: "2.75",
      fillPrice: "100",
      filledAt: 1_001,
    });
    expect(firstEntry.status).toBe("EXECUTION_ATTEMPT_UPDATED");
    const checkpointA = projected(firstEntry.attempt, "105", 1_001);
    expect(checkpointA.positionExposure.exposureState).toBe("OPEN");
    expect(checkpointA).toMatchObject({ grossRealizedPnl: "0", grossUnrealizedPnl: "13.75", grossTotalPnl: "13.75" });

    const firstProtection = protect(firstEntry.attempt, 1_002);
    const partialExit = exit(firstProtection.attempt, firstProtection.request, "X1", "1.25", "105", 1_003);
    const checkpointB = projected(partialExit, "110", 1_003);
    expect(checkpointB.positionExposure.exposureState).toBe("PARTIALLY_EXITED");
    expect(checkpointB).toMatchObject({ grossRealizedPnl: "6.25", grossUnrealizedPnl: "15", grossTotalPnl: "21.25" });

    const flatActive = exit(partialExit, firstProtection.request, "X2", "1.5", "90", 1_004);
    const checkpointC = projected(flatActive, "120", 1_004);
    expect(checkpointC.positionExposure.exposureState).toBe("FLAT_ENTRY_ACTIVE");
    expect(checkpointC).toMatchObject({ grossRealizedPnl: "-8.75", grossUnrealizedPnl: "0", grossTotalPnl: "-8.75" });

    const laterEntry = applyEntryFill(flatActive, {
      executionAttemptId: created.executionAttemptId,
      adapterOrderId: "ORDER-PERFORMANCE",
      fillId: "F2",
      filledQuantity: "2.25",
      fillPrice: "110",
      filledAt: 1_005,
    });
    expect(laterEntry.status).toBe("EXECUTION_ATTEMPT_UPDATED");
    const checkpointD = projected(laterEntry.attempt, "120", 1_005);
    expect(checkpointD.positionExposure.exposureState).toBe("PARTIALLY_EXITED");
    expect(checkpointD).toMatchObject({ grossRealizedPnl: "-8.75", grossUnrealizedPnl: "22.5", grossTotalPnl: "13.75" });

    const secondProtection = protect(laterEntry.attempt, 1_006);
    const terminal = exit(secondProtection.attempt, secondProtection.request, "X3", "2.25", "120", 1_007);
    const checkpointE = projected(terminal, "130", 1_007);
    expect(checkpointE.positionExposure.exposureState).toBe("CLOSED");
    expect(checkpointE).toMatchObject({ grossRealizedPnl: "13.75", grossUnrealizedPnl: "0", grossTotalPnl: "13.75" });
  });
});
