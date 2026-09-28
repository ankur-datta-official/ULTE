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
  createInstrumentId,
  positiveDecimalString,
  unixMs,
} from "@ulte/instrument-model";
import type { ReadyExecutionPlan } from "@ulte/execution-preparation-engine";
import { createLinearInstrumentSizingSpec } from "@ulte/position-sizing-engine";
import { projectRealizedTradeAccounting } from "./index.js";

const instrument = createInstrumentId({ venue: "TEST", venueSymbol: "ABC", instrumentKind: "CFD" });

function plan(): ReadyExecutionPlan {
  const quantity = positiveDecimalString("5");
  return Object.freeze({
    status: "EXECUTION_PLAN_READY",
    schemaVersion: "EXECUTION_PLAN_V1",
    executionPlanId: "plan-accounting-integration",
    tradeIntentId: "intent-accounting-integration",
    candidateId: "candidate-accounting-integration",
    instrumentId: instrument,
    intentAsOf: unixMs(800),
    marketSnapshotAsOf: unixMs(850),
    preparedAsOf: unixMs(900),
    direction: "UP",
    entrySide: "BUY",
    exitSide: "SELL",
    quantity,
    quantityUnit: "contracts",
    entryInstruction: Object.freeze({
      kind: "ENTRY_LIMIT",
      side: "BUY",
      price: positiveDecimalString("100"),
      quantity,
      positionEffect: "OPEN",
    }),
    protectiveStopInstruction: Object.freeze({
      kind: "PROTECTIVE_STOP_TRIGGER",
      side: "SELL",
      triggerPrice: positiveDecimalString("90"),
      quantity,
      positionEffect: "CLOSE",
    }),
    profitTargetInstruction: Object.freeze({
      kind: "PROFIT_TARGET_LIMIT",
      side: "SELL",
      price: positiveDecimalString("130"),
      quantity,
      positionEffect: "CLOSE",
    }),
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

const valuation = createLinearInstrumentSizingSpec({
  valuationModel: "LINEAR_PRICE_PNL",
  instrumentId: instrument,
  pnlCurrency: "USD",
  quantityUnit: "contracts",
  quantityStep: "0.01",
  minimumQuantity: "0.01",
  maximumQuantity: "100",
  pnlValuePerPriceUnitPerQuantity: "1",
});

function projected(attempt: ExecutionAttempt) {
  const result = projectRealizedTradeAccounting(attempt, valuation);
  expect(result.status).toBe("REALIZED_ACCOUNTING_PROJECTED");
  if (result.status !== "REALIZED_ACCOUNTING_PROJECTED") throw new Error(result.reason);
  return result.accounting;
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

describe("execution lifecycle to authoritative realized accounting", () => {
  it("projects entry, partial exit, flat-active, later entry, and terminal-close checkpoints", () => {
    const created = createExecutionAttempt(plan());
    expect(created.status).toBe("EXECUTION_ATTEMPT_READY");
    if (created.status !== "EXECUTION_ATTEMPT_READY") throw new Error("attempt creation failed");
    const submitted = requestEntrySubmission(created, capabilities);
    expect(submitted.status).toBe("ENTRY_SUBMISSION_READY");
    if (submitted.status !== "ENTRY_SUBMISSION_READY") throw new Error("entry submission request failed");
    const acknowledged = acknowledgeEntrySubmission(submitted.attempt, {
      executionAttemptId: created.executionAttemptId,
      idempotencyKey: submitted.request.idempotencyKey,
      adapterOrderId: "ORDER-ACCOUNTING",
      acknowledgedAt: 1_000,
    });
    expect(acknowledged.status).toBe("EXECUTION_ATTEMPT_UPDATED");

    const firstEntryResult = applyEntryFill(acknowledged.attempt, {
      executionAttemptId: created.executionAttemptId,
      adapterOrderId: "ORDER-ACCOUNTING",
      fillId: "F1",
      filledQuantity: "2.75",
      fillPrice: "100",
      filledAt: 1_001,
    });
    expect(firstEntryResult.status).toBe("EXECUTION_ATTEMPT_UPDATED");
    const checkpointA = projected(firstEntryResult.attempt);
    expect(checkpointA).toMatchObject({ grossRealizedPnl: "0", openQuantity: "2.75" });
    expect(checkpointA.openBasisLots).toEqual([expect.objectContaining({ entryFillId: "F1", remainingQuantity: "2.75" })]);

    const firstProtection = protect(firstEntryResult.attempt, 1_002);
    const partialExit = exit(firstProtection.attempt, firstProtection.request, "X1", "1.25", "105", 1_003);
    const checkpointB = projected(partialExit);
    expect(checkpointB.grossRealizedPnl).toBe("6.25");
    expect(checkpointB.realizedMatches).toHaveLength(1);
    expect(checkpointB.openBasisLots[0]?.remainingQuantity).toBe("1.5");

    const flatActive = exit(partialExit, firstProtection.request, "X2", "1.5", "90", 1_004);
    const checkpointC = projected(flatActive);
    expect(checkpointC.positionExposure.exposureState).toBe("FLAT_ENTRY_ACTIVE");
    expect(checkpointC.grossRealizedPnl).toBe("-8.75");
    expect(checkpointC.openBasisLots).toEqual([]);

    const laterEntryResult = applyEntryFill(flatActive, {
      executionAttemptId: created.executionAttemptId,
      adapterOrderId: "ORDER-ACCOUNTING",
      fillId: "F2",
      filledQuantity: "2.25",
      fillPrice: "110",
      filledAt: 1_005,
    });
    expect(laterEntryResult.status).toBe("EXECUTION_ATTEMPT_UPDATED");
    const checkpointD = projected(laterEntryResult.attempt);
    expect(checkpointD.grossRealizedPnl).toBe("-8.75");
    expect(checkpointD.openBasisLots).toEqual([expect.objectContaining({
      entryFillId: "F2", entryPrice: "110", remainingQuantity: "2.25",
    })]);

    const secondProtection = protect(laterEntryResult.attempt, 1_006);
    const terminal = exit(secondProtection.attempt, secondProtection.request, "X3", "2.25", "120", 1_007);
    const checkpointE = projected(terminal);
    expect(checkpointE.positionExposure.exposureState).toBe("CLOSED");
    expect(checkpointE.grossRealizedPnl).toBe("13.75");
    expect(checkpointE.realizedMatches).toHaveLength(3);
    expect(checkpointE.openQuantity).toBe("0");
    expect(checkpointE.openBasisLots).toEqual([]);
  });
});
