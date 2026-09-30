import { describe, expect, it } from "vitest";
import { createInstrumentId } from "@ulte/instrument-model";
import {
  READY_EXECUTION_PLAN_RECOVERY_DATA_SCHEMA_VERSION,
  createExecutionMarketSnapshot,
  createExecutionPreparationConfig,
  createInstrumentExecutionSpec,
  prepareExecutionPlan,
  type ReadyExecutionPlan,
  type ReadyExecutionPlanRecoveryDataV2,
  type ReadyExecutionPlanRecoverySelectorV2,
} from "@ulte/execution-preparation-engine";
import {
  PHASE33A_AS_OF,
  PHASE33A_EXECUTION_AS_OF,
  PHASE33A_INSTRUMENT,
  createReadyTradeIntentRecoveryFixture,
} from "../../../tests/integration/phase33a-recovery-fixture.js";
import {
  acknowledgeEntrySubmission,
  acknowledgeProtection,
  applyEntryFill,
  createAdapterCapabilities,
  createExecutionAttempt,
  requestEntrySubmission,
  requestEntryCancellation,
  requestProtection,
  restoreExecutionAttemptFromEvidence,
  validateExecutionAttemptRecoveryEvidence,
  type ExecutionAttempt,
  type ExecutionAttemptRecoveryEvidenceV1,
  type ExecutionAttemptRecoveryTransition,
  type ProtectionRequest,
} from "./index.js";

const otherInstrument = createInstrumentId({ venue: "TEST", venueSymbol: "XYZ", instrumentKind: "SPOT" });
const capabilities = createAdapterCapabilities({
  supportsClientIdempotency: false,
  supportsCloseOnlyExit: true,
  supportsNativeBracketProtection: false,
  supportsProtectionModification: true,
  supportsOrderCancellation: true,
  supportsPartialFillReporting: true,
});

function selector(plan: ReadyExecutionPlan): ReadyExecutionPlanRecoverySelectorV2 {
  const {
    executionPlanId, tradeIntentId, candidateId, instrumentId, intentAsOf, marketSnapshotAsOf,
    preparedAsOf, direction, entrySide, exitSide, quantity, quantityUnit, accountCurrency,
    entryInstruction, protectiveStopInstruction, profitTargetInstruction, priceTick, quantityStep,
    bidAtPreparation, askAtPreparation, intentAgeMs, quoteAgeMs, entryDeviationBps,
    approvedRiskAmount, actualRiskAmount, netRewardRiskBps,
  } = plan;
  return {
    executionPlanId, tradeIntentId, candidateId, instrumentId, intentAsOf, marketSnapshotAsOf,
    preparedAsOf, direction, entrySide, exitSide, quantity, quantityUnit, accountCurrency,
    entryInstruction: { ...entryInstruction },
    protectiveStopInstruction: { ...protectiveStopInstruction },
    profitTargetInstruction: { ...profitTargetInstruction },
    priceTick, quantityStep, bidAtPreparation, askAtPreparation, intentAgeMs, quoteAgeMs,
    entryDeviationBps, approvedRiskAmount, actualRiskAmount, netRewardRiskBps,
  };
}

const intentFixture = createReadyTradeIntentRecoveryFixture("12");
const marketSnapshot = {
  instrumentId: PHASE33A_INSTRUMENT,
  asOf: PHASE33A_AS_OF + 50,
  bid: intentFixture.tradeIntent.entryReferencePrice,
  ask: intentFixture.tradeIntent.entryReferencePrice,
};
const instrumentExecutionSpec = {
  instrumentId: PHASE33A_INSTRUMENT,
  priceTick: "1",
  quantityStep: "1",
  minimumQuantity: "1",
  maximumQuantity: "100",
};
const preparationConfig = { maxIntentAgeMs: 100, maxQuoteAgeMs: 50, maxEntryDeviationBps: 100 };
const prepared = prepareExecutionPlan({
  tradeIntent: intentFixture.tradeIntent,
  executionAsOf: PHASE33A_EXECUTION_AS_OF,
  marketSnapshot: createExecutionMarketSnapshot(marketSnapshot),
  instrumentExecutionSpec: createInstrumentExecutionSpec(instrumentExecutionSpec),
  config: createExecutionPreparationConfig(preparationConfig),
});
if (prepared.status !== "EXECUTION_PLAN_READY") throw new Error(prepared.status);
const authoritativePlan = prepared;
const authoritativeRecoveryData: ReadyExecutionPlanRecoveryDataV2 = {
  recoverySchemaVersion: READY_EXECUTION_PLAN_RECOVERY_DATA_SCHEMA_VERSION,
  tradeIntentEvidence: intentFixture.recoveryEvidence,
  marketSnapshot,
  instrumentExecutionSpec,
  config: preparationConfig,
  executionAsOf: PHASE33A_EXECUTION_AS_OF,
  expectedPlan: selector(authoritativePlan),
};

function plan(): ReadyExecutionPlan {
  return authoritativePlan;
}

function created(source = authoritativePlan): ExecutionAttempt {
  const result = createExecutionAttempt(source);
  if (result.status !== "EXECUTION_ATTEMPT_READY") throw new Error("fixture plan rejected");
  return result;
}

function evidence(
  transitions: readonly ExecutionAttemptRecoveryTransition[] = [],
): ExecutionAttemptRecoveryEvidenceV1 {
  const source = plan();
  const attempt = created();
  return {
    schemaVersion: "EXECUTION_ATTEMPT_RECOVERY_EVIDENCE_V1",
    identity: {
      executionAttemptId: attempt.executionAttemptId,
      executionPlanId: source.executionPlanId,
      tradeIntentId: source.tradeIntentId,
      candidateId: source.candidateId,
      instrumentId: source.instrumentId,
    },
    initialization: { executionPlanRecoveryData: structuredClone(authoritativeRecoveryData) },
    transitions,
  };
}

function submissionTransitions(at = 1_000): readonly ExecutionAttemptRecoveryTransition[] {
  const attempt = created();
  return [
    { kind: "ENTRY_SUBMISSION_REQUESTED", adapterCapabilities: capabilities },
    {
      kind: "ENTRY_SUBMISSION_ACKNOWLEDGED",
      acknowledgement: {
        executionAttemptId: attempt.executionAttemptId,
        idempotencyKey: attempt.submissionIdempotencyKey,
        adapterOrderId: "ORDER-1",
        acknowledgedAt: at,
      },
    },
  ];
}

function entryFill(
  fillId: string,
  filledQuantity: string,
  filledAt: number,
  overrides: Partial<Extract<ExecutionAttemptRecoveryTransition, { kind: "ENTRY_FILL_APPLIED" }>["fill"]> = {},
): Extract<ExecutionAttemptRecoveryTransition, { kind: "ENTRY_FILL_APPLIED" }> {
  const attempt = created();
  return {
    kind: "ENTRY_FILL_APPLIED",
    fill: {
      executionAttemptId: attempt.executionAttemptId,
      adapterOrderId: "ORDER-1",
      fillId,
      filledQuantity,
      fillPrice: "100.25",
      filledAt,
      ...overrides,
    },
  };
}

function acknowledgedProtectionFixture(): {
  readonly transitions: readonly ExecutionAttemptRecoveryTransition[];
  readonly request: ProtectionRequest;
} {
  const first = created();
  const submission = requestEntrySubmission(first, capabilities);
  if (submission.status !== "ENTRY_SUBMISSION_READY") throw new Error("submission fixture rejected");
  const acknowledgement = acknowledgeEntrySubmission(submission.attempt, {
    executionAttemptId: first.executionAttemptId,
    idempotencyKey: first.submissionIdempotencyKey,
    adapterOrderId: "ORDER-1",
    acknowledgedAt: 1_000,
  });
  const filled = applyEntryFill(acknowledgement.attempt, entryFill("FILL-1", "2", 1_001).fill);
  const request = requestProtection(filled.attempt);
  if (request.status !== "PROTECTION_REQUEST_READY") throw new Error("protection fixture rejected");
  const transitions: readonly ExecutionAttemptRecoveryTransition[] = [
    ...submissionTransitions(),
    entryFill("FILL-1", "2", 1_001),
    { kind: "PROTECTION_REQUESTED" },
    {
      kind: "PROTECTION_ACKNOWLEDGED",
      acknowledgement: {
        executionAttemptId: first.executionAttemptId,
        protectionRequestId: request.request.protectionRequestId,
        idempotencyKey: request.request.idempotencyKey,
        protectedQuantity: request.request.targetCumulativeProtectedQuantity,
        acknowledgedAt: 1_002,
      },
    },
  ];
  return { transitions, request: request.request };
}

function restored(source: ExecutionAttemptRecoveryEvidenceV1): ExecutionAttempt {
  const result = restoreExecutionAttemptFromEvidence(source);
  expect(result.status).toBe("EXECUTION_ATTEMPT_RESTORED");
  if (result.status !== "EXECUTION_ATTEMPT_RESTORED") throw new Error("recovery fixture rejected");
  return result.executionAttempt;
}

describe("execution authority recovery evidence", () => {
  it("initializes the attempt from the exact single restored plan", () => {
    const result = restoreExecutionAttemptFromEvidence(evidence());
    expect(result.status).toBe("EXECUTION_ATTEMPT_RESTORED");
    if (result.status !== "EXECUTION_ATTEMPT_RESTORED") return;
    expect(result.executionPlan).toEqual(authoritativePlan);
    expect(result.executionAttempt).toMatchObject({
      executionPlanId: result.executionPlan.executionPlanId,
      tradeIntentId: result.executionPlan.tradeIntentId,
      candidateId: result.executionPlan.candidateId,
      instrumentId: result.executionPlan.instrumentId,
    });
  });

  it("restores the exact current-schema minimal attempt and stable identity", () => {
    const source = evidence();
    const attempt = restored(source);
    expect(attempt).toEqual(created());
    expect(attempt).toMatchObject({
      schemaVersion: "EXECUTION_ATTEMPT_V3",
      executionAttemptId: source.identity.executionAttemptId,
      executionPlanId: source.identity.executionPlanId,
      tradeIntentId: authoritativePlan.tradeIntentId,
      candidateId: authoritativePlan.candidateId,
      instrumentId: PHASE33A_INSTRUMENT,
    });
  });

  it("separates structural validation from lifecycle replay acceptance", () => {
    const source = evidence([{ kind: "PROTECTION_REQUESTED" }]);
    expect(validateExecutionAttemptRecoveryEvidence(source).status)
      .toBe("EXECUTION_ATTEMPT_RECOVERY_EVIDENCE_VALID");
    expect(restoreExecutionAttemptFromEvidence(source)).toMatchObject({
      status: "EXECUTION_ATTEMPT_RESTORATION_REJECTED",
      reason: "EXECUTION_TRANSITION_REJECTED",
      transitionIndex: 0,
      authorityReason: "INVALID_TRANSITION",
    });
  });

  it("rejects a compensated sparse top-level transition array without throwing", () => {
    const transitions = new Array<ExecutionAttemptRecoveryTransition>(1);
    (transitions as any).extra = "compensating-key";
    const source = { ...evidence(), transitions };

    expect(() => validateExecutionAttemptRecoveryEvidence(source)).not.toThrow();
    expect(validateExecutionAttemptRecoveryEvidence(source)).toEqual({
      status: "EXECUTION_ATTEMPT_RECOVERY_EVIDENCE_INVALID",
      reason: "INVALID_RECOVERY_EVIDENCE",
    });
    expect(() => restoreExecutionAttemptFromEvidence(source)).not.toThrow();
    expect(restoreExecutionAttemptFromEvidence(source)).toEqual({
      status: "EXECUTION_ATTEMPT_RESTORATION_REJECTED",
      reason: "INVALID_RECOVERY_EVIDENCE",
    });
  });

  it("rejects a compensated sparse transition array with valid entries around the hole", () => {
    const transitions = new Array<ExecutionAttemptRecoveryTransition>(3);
    transitions[0] = submissionTransitions()[0]!;
    transitions[2] = submissionTransitions()[1]!;
    (transitions as any).extra = "compensating-key";
    const source = { ...evidence(), transitions };

    expect(validateExecutionAttemptRecoveryEvidence(source)).toMatchObject({
      status: "EXECUTION_ATTEMPT_RECOVERY_EVIDENCE_INVALID",
      reason: "INVALID_RECOVERY_EVIDENCE",
    });
    expect(restoreExecutionAttemptFromEvidence(source)).toMatchObject({
      status: "EXECUTION_ATTEMPT_RESTORATION_REJECTED",
      reason: "INVALID_RECOVERY_EVIDENCE",
    });
  });

  it("rejects a compensated sparse array nested in initialization evidence", () => {
    const source = structuredClone(evidence());
    const proposedRiskGroupIds = new Array<string>(1);
    (proposedRiskGroupIds as any).extra = "compensating-key";
    Reflect.set(
      source.initialization.executionPlanRecoveryData.tradeIntentEvidence.portfolioRisk,
      "proposedRiskGroupIds",
      proposedRiskGroupIds,
    );

    expect(validateExecutionAttemptRecoveryEvidence(source)).toMatchObject({
      status: "EXECUTION_ATTEMPT_RECOVERY_EVIDENCE_INVALID",
      reason: "INVALID_RECOVERY_EVIDENCE",
    });
    expect(restoreExecutionAttemptFromEvidence(source)).toMatchObject({
      status: "EXECUTION_ATTEMPT_RESTORATION_REJECTED",
      reason: "INVALID_RECOVERY_EVIDENCE",
    });
  });

  it("continues accepting dense normal transition arrays", () => {
    const source = evidence(submissionTransitions());

    expect(validateExecutionAttemptRecoveryEvidence(source).status)
      .toBe("EXECUTION_ATTEMPT_RECOVERY_EVIDENCE_VALID");
    expect(restoreExecutionAttemptFromEvidence(source).status)
      .toBe("EXECUTION_ATTEMPT_RESTORED");
  });

  it.each([
    ["direction/side incoherence", (data: any) => { data.expectedPlan.direction = "DOWN"; }],
    ["instruction quantity incoherence", (data: any) => {
      data.expectedPlan.profitTargetInstruction.quantity = "1";
    }],
    ["risk/preparation incoherence", (data: any) => { data.expectedPlan.actualRiskAmount = "30"; }],
    ["legacy recovery schema", (data: any) => {
      data.recoverySchemaVersion = "READY_EXECUTION_PLAN_RECOVERY_DATA_V1";
    }],
  ])("does not promote semantically invalid plan checkpoint data: %s", (_label, mutate) => {
    const source = evidence();
    mutate(source.initialization.executionPlanRecoveryData);
    expect(restoreExecutionAttemptFromEvidence(source)).toMatchObject({
      status: "EXECUTION_ATTEMPT_RESTORATION_REJECTED",
      reason: "INVALID_RECOVERY_EVIDENCE",
    });
  });

  it("restores entry submission acknowledgement and ordered partial fills", () => {
    const attempt = restored(evidence([
      ...submissionTransitions(),
      entryFill("FILL-1", "0.5", 1_001),
      entryFill("FILL-2", "0.5", 1_002),
    ]));
    expect(attempt.entryOrderStatus).toBe("WORKING");
    expect(attempt.filledEntryQuantity).toBe("1");
    expect(attempt.processedFills.map(({ fillId }) => fillId)).toEqual(["FILL-1", "FILL-2"]);
  });

  it("preserves authority duplicate-fill semantics", () => {
    const fill = entryFill("FILL-1", "0.5", 1_001);
    const attempt = restored(evidence([...submissionTransitions(), fill, fill]));
    expect(attempt.filledEntryQuantity).toBe("0.5");
    expect(attempt.processedFills).toHaveLength(1);
  });

  it("fails closed on a conflicting duplicate fill", () => {
    const first = entryFill("FILL-1", "0.5", 1_001);
    const conflicting = entryFill("FILL-1", "0.75", 1_001);
    expect(restoreExecutionAttemptFromEvidence(evidence([
      ...submissionTransitions(), first, conflicting,
    ]))).toMatchObject({
      status: "EXECUTION_ATTEMPT_RESTORATION_REJECTED",
      reason: "EXECUTION_TRANSITION_REJECTED",
      authorityReason: "DUPLICATE_FILL_CONFLICT",
    });
  });

  it("restores protection request acknowledgement", () => {
    const fixture = acknowledgedProtectionFixture();
    const attempt = restored(evidence(fixture.transitions));
    expect(attempt.state).toBe("PROTECTED");
    expect(attempt.protectedQuantity).toBe("2");
    expect(attempt.acknowledgedProtections).toHaveLength(1);
  });

  it("restores protection rejection", () => {
    const fixture = acknowledgedProtectionFixture();
    const prefix = fixture.transitions.slice(0, -1);
    const attempt = restored(evidence([...prefix, {
      kind: "PROTECTION_REJECTED",
      rejection: {
        executionAttemptId: created().executionAttemptId,
        protectionRequestId: fixture.request.protectionRequestId,
        idempotencyKey: fixture.request.idempotencyKey,
        adapterReasonCode: "VENUE_REJECTED",
        rejectedAt: 1_002,
      },
    }]));
    expect(attempt.state).toBe("FAILED");
    expect(attempt.protectionFailureReason).toBe("VENUE_REJECTED");
  });

  it.each([
    ["partial", "1", "EXIT_PARTIALLY_FILLED"],
    ["full", "2", "EXIT_FILLED"],
  ] as const)("restores a %s exit fill", (_label, quantity, state) => {
    const fixture = acknowledgedProtectionFixture();
    const attempt = restored(evidence([...fixture.transitions, {
      kind: "EXIT_FILL_APPLIED",
      fill: {
        executionAttemptId: created().executionAttemptId,
        protectionRequestId: fixture.request.protectionRequestId,
        exitSide: "SELL",
        exitLeg: "PROTECTIVE_STOP",
        fillId: "EXIT-1",
        filledQuantity: quantity,
        fillPrice: "90",
        filledAt: 1_003,
      },
    }]));
    expect(attempt.exitedQuantity).toBe(quantity);
    expect(attempt.state).toBe(state);
  });

  it("preserves duplicate and conflicting exit-fill authority semantics", () => {
    const fixture = acknowledgedProtectionFixture();
    const exit: ExecutionAttemptRecoveryTransition = {
      kind: "EXIT_FILL_APPLIED",
      fill: {
        executionAttemptId: created().executionAttemptId,
        protectionRequestId: fixture.request.protectionRequestId,
        exitSide: "SELL",
        exitLeg: "PROFIT_TARGET",
        fillId: "EXIT-1",
        filledQuantity: "1",
        fillPrice: "130",
        filledAt: 1_003,
      },
    };
    expect(restored(evidence([...fixture.transitions, exit, exit])).processedExitFills).toHaveLength(1);
    const conflict: ExecutionAttemptRecoveryTransition = {
      ...exit,
      fill: { ...exit.fill, filledQuantity: "0.5" },
    };
    expect(restoreExecutionAttemptFromEvidence(evidence([...fixture.transitions, exit, conflict])))
      .toMatchObject({
        status: "EXECUTION_ATTEMPT_RESTORATION_REJECTED",
        authorityReason: "DUPLICATE_EXIT_FILL_CONFLICT",
      });
  });

  it.each(["acknowledged", "rejected"] as const)("restores %s cancellation", (outcome) => {
    const attempt = created();
    const working = restored(evidence([...submissionTransitions()]));
    const requested = requestEntryCancellation(working);
    if (requested.status !== "CANCELLATION_REQUEST_READY") throw new Error("cancellation fixture rejected");
    const requestId = requested.request.cancellationRequestId;
    const key = requested.request.idempotencyKey;
    const terminal: ExecutionAttemptRecoveryTransition = outcome === "acknowledged"
      ? {
          kind: "ENTRY_CANCELLATION_ACKNOWLEDGED",
          acknowledgement: {
            executionAttemptId: attempt.executionAttemptId,
            cancellationRequestId: requestId,
            idempotencyKey: key,
            adapterOrderId: "ORDER-1",
            acknowledgedAt: 1_001,
          },
        }
      : {
          kind: "ENTRY_CANCELLATION_REJECTED",
          rejection: {
            executionAttemptId: attempt.executionAttemptId,
            cancellationRequestId: requestId,
            idempotencyKey: key,
            adapterOrderId: "ORDER-1",
            adapterReasonCode: "TOO_LATE",
            rejectedAt: 1_001,
          },
        };
    const result = restored(evidence([
      ...submissionTransitions(), { kind: "ENTRY_CANCELLATION_REQUESTED" }, terminal,
    ]));
    expect(result.state).toBe(outcome === "acknowledged" ? "CANCELED" : "ENTRY_WORKING");
    expect(result.pendingCancellationRequest).toBeUndefined();
  });

  it("rejects out-of-order lifecycle evidence through execution authority", () => {
    expect(restoreExecutionAttemptFromEvidence(evidence([
      ...submissionTransitions(), entryFill("FILL-1", "1", 999),
    ]))).toMatchObject({
      status: "EXECUTION_ATTEMPT_RESTORATION_REJECTED",
      authorityReason: "OUT_OF_ORDER_EXECUTION_EVENT",
    });
  });

  it("rejects cross-attempt transition evidence", () => {
    const source = evidence([entryFill("FILL-1", "1", 1_001, { executionAttemptId: "other-attempt" })]);
    expect(restoreExecutionAttemptFromEvidence(source)).toMatchObject({
      status: "EXECUTION_ATTEMPT_RESTORATION_REJECTED",
      reason: "RECOVERY_IDENTITY_INCOHERENT",
    });
  });

  it("rejects cross-instrument identity evidence", () => {
    const source = evidence();
    const conflicting = { ...source, identity: { ...source.identity, instrumentId: otherInstrument } };
    expect(restoreExecutionAttemptFromEvidence(conflicting)).toMatchObject({
      status: "EXECUTION_ATTEMPT_RESTORATION_REJECTED",
      reason: "RECOVERY_IDENTITY_INCOHERENT",
    });
  });

  it("rejects unsupported schemas and malformed IDs", () => {
    const source = evidence();
    expect(restoreExecutionAttemptFromEvidence({ ...source, schemaVersion: "V2" })).toMatchObject({
      status: "EXECUTION_ATTEMPT_RESTORATION_REJECTED",
      reason: "UNSUPPORTED_RECOVERY_SCHEMA",
    });
    expect(restoreExecutionAttemptFromEvidence({
      ...source, identity: { ...source.identity, executionAttemptId: " attempt " },
    })).toMatchObject({
      status: "EXECUTION_ATTEMPT_RESTORATION_REJECTED",
      reason: "INVALID_RECOVERY_EVIDENCE",
    });
  });

  it("does not mutate caller evidence and freezes result wrappers", () => {
    const source = evidence(submissionTransitions());
    const transitions = source.transitions;
    const initialization = source.initialization;
    const result = restoreExecutionAttemptFromEvidence(source);
    expect(source.transitions).toBe(transitions);
    expect(source.initialization).toBe(initialization);
    expect(Object.isFrozen(result)).toBe(true);
  });
});
