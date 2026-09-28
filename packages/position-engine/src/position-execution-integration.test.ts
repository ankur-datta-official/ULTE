import { describe, expect, it } from "vitest";
import {
  acknowledgeCancellation,
  acknowledgeEntrySubmission,
  acknowledgeProtection,
  applyEntryFill,
  applyExitFill,
  createAdapterCapabilities,
  createExecutionAttempt,
  requestEntryCancellation,
  requestEntrySubmission,
  requestProtection,
  type ExecutionAttempt,
  type ProtectionRequest,
} from "@ulte/execution-engine";
import { createInstrumentId, positiveDecimalString, unixMs } from "@ulte/instrument-model";
import type { ReadyExecutionPlan } from "@ulte/execution-preparation-engine";
import { projectPositionExposure } from "./index.js";

const instrument = createInstrumentId({ venue: "TEST", venueSymbol: "ABC", instrumentKind: "CFD" });
const capabilities = createAdapterCapabilities({
  supportsClientIdempotency: false,
  supportsCloseOnlyExit: true,
  supportsNativeBracketProtection: false,
  supportsProtectionModification: true,
  supportsOrderCancellation: true,
  supportsPartialFillReporting: true,
});

function plan(): ReadyExecutionPlan {
  const quantity = positiveDecimalString("10");
  return Object.freeze({
    status: "EXECUTION_PLAN_READY",
    schemaVersion: "EXECUTION_PLAN_V1",
    executionPlanId: "plan-integration",
    tradeIntentId: "intent-integration",
    candidateId: "candidate-integration",
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
      kind: "ENTRY_LIMIT", side: "BUY", price: positiveDecimalString("100"), quantity, positionEffect: "OPEN",
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
    approvedRiskAmount: positiveDecimalString("25"),
    actualRiskAmount: positiveDecimalString("20"),
    netRewardRiskBps: "30000",
  });
}

function expectUpdated(result: ReturnType<typeof applyEntryFill>): ExecutionAttempt {
  expect(result.status).toBe("EXECUTION_ATTEMPT_UPDATED");
  if (result.status !== "EXECUTION_ATTEMPT_UPDATED") throw new Error(result.reason);
  return result.attempt;
}

function protect(attempt: ExecutionAttempt, at: number): { attempt: ExecutionAttempt; request: ProtectionRequest } {
  const requested = requestProtection(attempt);
  expect(requested.status).toBe("PROTECTION_REQUEST_READY");
  if (requested.status !== "PROTECTION_REQUEST_READY") throw new Error("protection request failed");
  const acknowledged = acknowledgeProtection(requested.attempt, {
    executionAttemptId: attempt.executionAttemptId,
    protectionRequestId: requested.request.protectionRequestId,
    idempotencyKey: requested.request.idempotencyKey,
    protectedQuantity: requested.request.targetCumulativeProtectedQuantity,
    acknowledgedAt: at,
  });
  return { attempt: expectUpdated(acknowledged), request: requested.request };
}

function exposure(attempt: ExecutionAttempt) {
  const result = projectPositionExposure(attempt);
  expect(result.status).toBe("POSITION_EXPOSURE_PROJECTED");
  if (result.status !== "POSITION_EXPOSURE_PROJECTED") throw new Error(result.reason);
  return result.positionExposure;
}

describe("execution-to-position integration", () => {
  it("projects no exposure, early exit, later entry, cancellation, and authoritative close", () => {
    const created = createExecutionAttempt(plan());
    expect(created.status).toBe("EXECUTION_ATTEMPT_READY");
    if (created.status !== "EXECUTION_ATTEMPT_READY") return;
    expect(exposure(created)).toMatchObject({ openQuantity: "0", exposureState: "NO_EXPOSURE" });

    const submitted = requestEntrySubmission(created, capabilities);
    expect(submitted.status).toBe("ENTRY_SUBMISSION_READY");
    if (submitted.status !== "ENTRY_SUBMISSION_READY") return;
    const acknowledged = acknowledgeEntrySubmission(submitted.attempt, {
      executionAttemptId: created.executionAttemptId,
      idempotencyKey: submitted.request.idempotencyKey,
      adapterOrderId: "ORDER-1",
      acknowledgedAt: 1_000,
    });
    const working = expectUpdated(acknowledged);
    expect(exposure(working)).toMatchObject({ openQuantity: "0", exposureState: "NO_EXPOSURE" });

    const partial = expectUpdated(applyEntryFill(working, {
      executionAttemptId: created.executionAttemptId,
      adapterOrderId: "ORDER-1",
      fillId: "F1",
      filledQuantity: "2.75",
      fillPrice: "100",
      filledAt: 1_001,
    }));
    expect(exposure(partial)).toMatchObject({ filledEntryQuantity: "2.75", openQuantity: "2.75", exposureState: "OPEN" });

    const firstProtection = protect(partial, 1_002);
    const earlyExit = expectUpdated(applyExitFill(firstProtection.attempt, {
      executionAttemptId: created.executionAttemptId,
      protectionRequestId: firstProtection.request.protectionRequestId,
      exitSide: "SELL",
      exitLeg: "PROTECTIVE_STOP",
      fillId: "X1",
      filledQuantity: "2.75",
      fillPrice: "90",
      filledAt: 1_003,
    }));
    expect(exposure(earlyExit)).toMatchObject({
      filledEntryQuantity: "2.75",
      exitedQuantity: "2.75",
      openQuantity: "0",
      entryCanIncreaseExposure: true,
      exposureState: "FLAT_ENTRY_ACTIVE",
    });

    const laterEntry = expectUpdated(applyEntryFill(earlyExit, {
      executionAttemptId: created.executionAttemptId,
      adapterOrderId: "ORDER-1",
      fillId: "F2",
      filledQuantity: "1.25",
      fillPrice: "100",
      filledAt: 1_004,
    }));
    expect(exposure(laterEntry)).toMatchObject({
      filledEntryQuantity: "4", exitedQuantity: "2.75", openQuantity: "1.25", exposureState: "PARTIALLY_EXITED",
    });

    const secondProtection = protect(laterEntry, 1_005);
    const cancellation = requestEntryCancellation(secondProtection.attempt);
    expect(cancellation.status).toBe("CANCELLATION_REQUEST_READY");
    if (cancellation.status !== "CANCELLATION_REQUEST_READY") return;
    const canceled = expectUpdated(acknowledgeCancellation(cancellation.attempt, {
      executionAttemptId: created.executionAttemptId,
      cancellationRequestId: cancellation.request.cancellationRequestId,
      idempotencyKey: cancellation.request.idempotencyKey,
      adapterOrderId: "ORDER-1",
      acknowledgedAt: 1_006,
    }));
    expect(exposure(canceled)).toMatchObject({ openQuantity: "1.25", exposureState: "PARTIALLY_EXITED" });

    const finalExit = expectUpdated(applyExitFill(canceled, {
      executionAttemptId: created.executionAttemptId,
      protectionRequestId: secondProtection.request.protectionRequestId,
      exitSide: "SELL",
      exitLeg: "PROFIT_TARGET",
      fillId: "X2",
      filledQuantity: "1.25",
      fillPrice: "130",
      filledAt: 1_007,
    }));
    expect(finalExit).toMatchObject({ entryOrderStatus: "CANCELED", state: "EXIT_FILLED", exitedQuantity: "4" });
    expect(exposure(finalExit)).toMatchObject({
      openQuantity: "0", entryCanIncreaseExposure: false, exposureState: "CLOSED", executionAsOf: 1_007,
    });
  });
});
