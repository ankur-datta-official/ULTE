import { describe, expect, it } from "vitest";
import {
  acknowledgeProtection,
  createAdapterCapabilities,
  createEntryAcknowledgement,
  createExecutionAttempt,
  createExitFillEvent,
  createFillEvent,
  requestEntrySubmission,
  requestProtection,
} from "@ulte/execution-engine";
import type { ReadyExecutionPlan } from "@ulte/execution-preparation-engine";
import { createInstrumentId, positiveDecimalString, unixMs } from "@ulte/instrument-model";
import { createLinearInstrumentSizingSpec } from "@ulte/position-sizing-engine";
import { applyRealtimeExecutionExitFill } from "@ulte/realtime-execution-exit-fill-engine";
import { applyRealtimeExecutionFill, initializeRealtimeExecutionFillLifecycle } from "@ulte/realtime-execution-fill-engine";
import type { ProtectionAcknowledgementAppliedResult } from "@ulte/realtime-execution-protection-lifecycle-engine";
import type { SubmissionConfirmedResult } from "@ulte/realtime-execution-submission-engine";
import { createTradeCostEvent, type TradeCostEvent } from "@ulte/trade-cost-accounting-engine";
import { RealtimeTradeCostAccountingEngine } from "./index.js";

const instrument = createInstrumentId({ venue: "TEST", venueSymbol: "INTEGRATION", instrumentKind: "CFD" });
const quantity = positiveDecimalString("2.75");
const capabilities = createAdapterCapabilities({
  supportsClientIdempotency: true,
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
  return Object.freeze({
    status: "EXECUTION_PLAN_READY",
    schemaVersion: "EXECUTION_PLAN_V1",
    executionPlanId: "integration-plan",
    tradeIntentId: "integration-intent",
    candidateId: "integration-candidate",
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
      kind: "PROTECTIVE_STOP_TRIGGER", side: "SELL", triggerPrice: positiveDecimalString("90"),
      quantity, positionEffect: "CLOSE",
    }),
    profitTargetInstruction: Object.freeze({
      kind: "PROFIT_TARGET_LIMIT", side: "SELL", price: positiveDecimalString("130"),
      quantity, positionEffect: "CLOSE",
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

function confirmedSubmission(): SubmissionConfirmedResult {
  const created = createExecutionAttempt(plan());
  if (created.status !== "EXECUTION_ATTEMPT_READY") throw new Error("attempt creation failed");
  const requested = requestEntrySubmission(created, capabilities);
  if (requested.status !== "ENTRY_SUBMISSION_READY") throw new Error("entry request failed");
  const acknowledgement = createEntryAcknowledgement({
    executionAttemptId: created.executionAttemptId,
    idempotencyKey: requested.request.idempotencyKey,
    adapterOrderId: "INTEGRATION-ORDER",
    acknowledgedAt: 1_000,
  });
  return Object.freeze({
    status: "SUBMISSION_CONFIRMED",
    preparationCycleId: "integration-cycle",
    submissionAsOf: unixMs(999),
    executionAttempt: requested.attempt,
    durableResult: Object.freeze({
      status: "CONFIRMED",
      idempotencyKey: requested.request.idempotencyKey,
      acknowledgement,
      record: Object.freeze({
        executionAttemptId: created.executionAttemptId,
        idempotencyKey: requested.request.idempotencyKey,
        adapterOrderId: acknowledgement.adapterOrderId,
      }),
    }),
  }) as unknown as SubmissionConfirmedResult;
}

function delivery(
  attemptId: string,
  id: string,
  costType: "COMMISSION" | "EXCHANGE_FEE" | "BROKER_FEE" | "FUNDING" | "BORROW_COST",
  effect: "DEBIT" | "CREDIT",
  amount: string,
  effectiveAt: number,
): TradeCostEvent {
  return createTradeCostEvent({
    costEventId: id,
    executionAttemptId: attemptId,
    instrumentId: instrument,
    costType,
    effect,
    amount,
    currency: "USD",
    effectiveAt,
    source: "INTEGRATION_PROVIDER",
  });
}

describe("real realtime lifecycle to observed cost accounting", () => {
  it("advances only when deliveries are observed, including duplicate transport and late post-close cost", () => {
    const submission = confirmedSubmission();
    const initialized = initializeRealtimeExecutionFillLifecycle(submission);
    if (initialized.status !== "FILL_LIFECYCLE_INITIALIZED") throw new Error("fill lifecycle initialization failed");
    const entryEvent = createFillEvent({
      executionAttemptId: initialized.executionAttempt.executionAttemptId,
      adapterOrderId: "INTEGRATION-ORDER",
      fillId: "ENTRY-1",
      filledQuantity: "2.75",
      fillPrice: "100",
      filledAt: 1_001,
    });
    const entry = applyRealtimeExecutionFill({
      submission,
      executionAttempt: initialized.executionAttempt,
      fill: entryEvent,
      observationAsOf: 1_001,
    });
    if (entry.status !== "FILL_APPLIED") throw new Error("entry fill failed");

    const engine = new RealtimeTradeCostAccountingEngine();
    const observedDeliveries: TradeCostEvent[] = [];
    const projectEntry = () => engine.project({
      sourceKind: "ENTRY_FILL" as const,
      fillLifecycle: entry,
      accountingSpec,
      observedCostEvents: observedDeliveries,
    });
    const c1 = delivery(entry.executionAttempt.executionAttemptId, "C1", "COMMISSION", "DEBIT", "1.25", 1_001);
    const c2 = delivery(entry.executionAttempt.executionAttemptId, "C2", "FUNDING", "CREDIT", "0.50", 1_002);
    const c5 = delivery(entry.executionAttempt.executionAttemptId, "C5", "BORROW_COST", "DEBIT", "0.25", 1_010);

    expect(observedDeliveries).not.toContain(c5);
    observedDeliveries.push(c1);
    expect(projectEntry()).toMatchObject({
      status: "TRADE_COST_ACCOUNTING_PROJECTED", accounting: { netCostAmount: "1.25" },
    });
    observedDeliveries.push(c2);
    expect(projectEntry()).toMatchObject({
      status: "TRADE_COST_ACCOUNTING_PROJECTED", accounting: { netCostAmount: "0.75" },
    });
    const withoutDuplicate = projectEntry();
    observedDeliveries.push(c1);
    const withDuplicate = projectEntry();
    expect(withDuplicate).toMatchObject({
      status: "TRADE_COST_ACCOUNTING_PROJECTED",
      observedDeliveryCount: 3,
      uniqueCostEventCount: 2,
      duplicateDeliveryCount: 1,
      accounting: { netCostAmount: "0.75" },
    });
    if (withoutDuplicate.status !== "TRADE_COST_ACCOUNTING_PROJECTED"
      || withDuplicate.status !== "TRADE_COST_ACCOUNTING_PROJECTED") throw new Error("entry cost projection failed");
    expect(withDuplicate.accounting).toEqual(withoutDuplicate.accounting);
    observedDeliveries.pop();

    const requested = requestProtection(entry.executionAttempt);
    if (requested.status !== "PROTECTION_REQUEST_READY") throw new Error("protection request failed");
    const acknowledgement = {
      executionAttemptId: entry.executionAttempt.executionAttemptId,
      protectionRequestId: requested.request.protectionRequestId,
      idempotencyKey: requested.request.idempotencyKey,
      protectedQuantity: requested.request.targetCumulativeProtectedQuantity,
      acknowledgedAt: 1_002,
    };
    const acknowledged = acknowledgeProtection(requested.attempt, acknowledgement);
    if (acknowledged.status !== "EXECUTION_ATTEMPT_UPDATED") throw new Error("protection acknowledgement failed");
    const protectionLifecycle: ProtectionAcknowledgementAppliedResult = Object.freeze({
      status: "PROTECTION_ACKNOWLEDGEMENT_APPLIED",
      preparationCycleId: "integration-cycle",
      protectionAsOf: unixMs(1_002),
      observationAsOf: unixMs(1_002),
      acknowledgement: acknowledged.attempt.acknowledgedProtections[0]!.acknowledgement,
      executionAttempt: acknowledged.attempt,
      transitionResult: acknowledged,
    });

    const partialEvent = createExitFillEvent({
      executionAttemptId: entry.executionAttempt.executionAttemptId,
      protectionRequestId: requested.request.protectionRequestId,
      exitSide: "SELL",
      exitLeg: "PROFIT_TARGET",
      fillId: "EXIT-1",
      filledQuantity: "1.25",
      fillPrice: "105",
      filledAt: 1_003,
    });
    const partial = applyRealtimeExecutionExitFill({
      protectionLifecycle,
      executionAttempt: protectionLifecycle.executionAttempt,
      exitFill: partialEvent,
      observationAsOf: 1_003,
    });
    if (partial.status !== "EXIT_FILL_APPLIED") throw new Error("partial exit failed");
    observedDeliveries.push(delivery(entry.executionAttempt.executionAttemptId, "C3", "EXCHANGE_FEE", "DEBIT", "0.40", 1_003));
    expect(engine.project({
      sourceKind: "EXIT_FILL", exitFillLifecycle: partial, accountingSpec, observedCostEvents: observedDeliveries,
    })).toMatchObject({
      status: "TRADE_COST_ACCOUNTING_PROJECTED",
      accounting: { netCostAmount: "1.15", positionExposure: { exposureState: "PARTIALLY_EXITED" } },
    });

    const closeEvent = createExitFillEvent({
      executionAttemptId: entry.executionAttempt.executionAttemptId,
      protectionRequestId: requested.request.protectionRequestId,
      exitSide: "SELL",
      exitLeg: "PROFIT_TARGET",
      fillId: "EXIT-2",
      filledQuantity: "1.5",
      fillPrice: "105",
      filledAt: 1_007,
    });
    const closed = applyRealtimeExecutionExitFill({
      protectionLifecycle,
      executionAttempt: partial.executionAttempt,
      exitFill: closeEvent,
      observationAsOf: 1_007,
    });
    if (closed.status !== "EXIT_FILL_APPLIED") throw new Error("close failed");
    observedDeliveries.push(delivery(entry.executionAttempt.executionAttemptId, "C4", "BROKER_FEE", "DEBIT", "0.10", 1_007));
    const beforeLate = engine.project({
      sourceKind: "EXIT_FILL", exitFillLifecycle: closed, accountingSpec, observedCostEvents: observedDeliveries,
    });
    expect(beforeLate).toMatchObject({
      status: "TRADE_COST_ACCOUNTING_PROJECTED",
      accounting: { netCostAmount: "1.25", positionExposure: { exposureState: "CLOSED" } },
    });
    expect(observedDeliveries).not.toContain(c5);

    observedDeliveries.push(c5);
    expect(observedDeliveries).toContain(c5);
    const afterLate = engine.project({
      sourceKind: "EXIT_FILL", exitFillLifecycle: closed, accountingSpec, observedCostEvents: observedDeliveries,
    });
    expect(afterLate).toMatchObject({
      status: "TRADE_COST_ACCOUNTING_PROJECTED",
      accounting: {
        grossDebitCostAmount: "2", grossCreditCostAmount: "0.5", netCostAmount: "1.5",
        executionAccountingAsOf: 1_007, costAccountingAsOf: 1_010,
        positionExposure: { exposureState: "CLOSED" },
      },
    });

    const conflict = { ...c1, amount: positiveDecimalString("9") } as TradeCostEvent;
    expect(engine.project({
      sourceKind: "EXIT_FILL",
      exitFillLifecycle: closed,
      accountingSpec,
      observedCostEvents: [...observedDeliveries, conflict],
    })).toMatchObject({
      status: "TRADE_COST_ACCOUNTING_REJECTED", reason: "CONFLICTING_DUPLICATE_COST_EVENT_ID",
    });

    expect(Object.keys(engine)).toEqual([]);
  });
});
