import { describe, expect, it } from "vitest";
import {
  brokerAdapterId,
  createIdempotencyRecord,
  fingerprintProtectionRequest,
  type RequestFingerprint,
} from "@ulte/broker-adapters";
import {
  acknowledgeEntrySubmission,
  applyEntryFill,
  createAdapterCapabilities,
  createEntryAcknowledgement,
  createExecutionAttempt,
  createFillEvent,
  createProtectionAcknowledgement,
  requestEntrySubmission,
  requestProtection,
  type AdapterCapabilities,
  type ExecutionAttempt,
  type ProtectionAcknowledgement,
  type ProtectionRequest,
} from "@ulte/execution-engine";
import {
  createInstrumentId,
  positiveDecimalString,
  unixMs,
} from "@ulte/instrument-model";
import type {
  ProtectionConfirmedResult,
  RealtimeExecutionProtectionResult,
} from "@ulte/realtime-execution-protection-engine";
import {
  applyRealtimeExecutionProtectionAcknowledgement,
  RealtimeExecutionProtectionLifecycleEngine,
} from "./index.js";

const instrument = createInstrumentId({ venue: "TEST", venueSymbol: "ABC", instrumentKind: "CFD" });
const managedCapabilities = createAdapterCapabilities({
  supportsClientIdempotency: true,
  supportsCloseOnlyExit: true,
  supportsNativeBracketProtection: false,
  supportsProtectionModification: false,
  supportsOrderCancellation: true,
  supportsPartialFillReporting: true,
});
const nativeCapabilities = createAdapterCapabilities({
  ...managedCapabilities,
  supportsNativeBracketProtection: true,
});

function readyAttempt(capabilities: AdapterCapabilities = managedCapabilities): ExecutionAttempt {
  const preparation = Object.freeze({
    status: "EXECUTION_PLAN_READY",
    schemaVersion: "EXECUTION_PLAN_V1",
    executionPlanId: "plan-1",
    tradeIntentId: "intent-1",
    candidateId: "candidate-1",
    instrumentId: instrument,
    intentAsOf: unixMs(900),
    marketSnapshotAsOf: unixMs(1_000),
    preparedAsOf: unixMs(1_000),
    direction: "UP",
    entrySide: "BUY",
    exitSide: "SELL",
    quantity: positiveDecimalString("10"),
    quantityUnit: "contract",
    entryInstruction: Object.freeze({
      kind: "ENTRY_LIMIT", side: "BUY", price: positiveDecimalString("100"),
      quantity: positiveDecimalString("10"), positionEffect: "OPEN",
    }),
    protectiveStopInstruction: Object.freeze({
      kind: "PROTECTIVE_STOP_TRIGGER", side: "SELL", triggerPrice: positiveDecimalString("90.25"),
      quantity: positiveDecimalString("10"), positionEffect: "CLOSE",
    }),
    profitTargetInstruction: Object.freeze({
      kind: "PROFIT_TARGET_LIMIT", side: "SELL", price: positiveDecimalString("131.75"),
      quantity: positiveDecimalString("10"), positionEffect: "CLOSE",
    }),
    priceTick: positiveDecimalString("0.01"),
    quantityStep: positiveDecimalString("0.01"),
    bidAtPreparation: positiveDecimalString("99.99"),
    askAtPreparation: positiveDecimalString("100"),
    intentAgeMs: 100,
    quoteAgeMs: 0,
    entryDeviationBps: "0",
    approvedRiskAmount: positiveDecimalString("97.5"),
    actualRiskAmount: positiveDecimalString("97.5"),
    netRewardRiskBps: "32564",
  } as const);
  const created = createExecutionAttempt(preparation);
  if (created.status !== "EXECUTION_ATTEMPT_READY") throw new Error("fixture attempt rejected");
  const requested = requestEntrySubmission(created, capabilities);
  if (requested.status !== "ENTRY_SUBMISSION_READY") throw new Error("fixture entry unsupported");
  const acknowledged = acknowledgeEntrySubmission(requested.attempt, createEntryAcknowledgement({
    executionAttemptId: requested.attempt.executionAttemptId,
    idempotencyKey: requested.attempt.submissionIdempotencyKey,
    adapterOrderId: "entry-order-1",
    acknowledgedAt: 1_100,
  }));
  if (acknowledged.status !== "EXECUTION_ATTEMPT_UPDATED") throw new Error("fixture acknowledgement failed");
  return acknowledged.attempt;
}

function filledAttempt(
  quantity: string,
  capabilities: AdapterCapabilities = managedCapabilities,
  prior?: ExecutionAttempt,
  fillId = "fill-1",
  filledAt = 1_200,
): ExecutionAttempt {
  const attempt = prior ?? readyAttempt(capabilities);
  const fill = createFillEvent({
    executionAttemptId: attempt.executionAttemptId,
    adapterOrderId: attempt.adapterOrderId!,
    fillId,
    filledQuantity: quantity,
    fillPrice: "100.10",
    filledAt,
  });
  const transition = applyEntryFill(attempt, fill);
  if (transition.status !== "EXECUTION_ATTEMPT_UPDATED") throw new Error("fixture fill failed");
  return transition.attempt;
}

function confirmed(
  filledQuantity = "2.75",
  capabilities: AdapterCapabilities = managedCapabilities,
  options: {
    readonly attempt?: ExecutionAttempt;
    readonly protectionAsOf?: number;
    readonly acknowledgedAt?: number;
    readonly acknowledgement?: ProtectionAcknowledgement;
  } = {},
): ProtectionConfirmedResult {
  const filled = options.attempt ?? filledAttempt(filledQuantity, capabilities);
  const policy = requestProtection(filled);
  if (policy.status !== "PROTECTION_REQUEST_READY") throw new Error("fixture protection not ready");
  const request = policy.request;
  const protectionAsOf = unixMs(options.protectionAsOf ?? 1_300);
  const acknowledgement = options.acknowledgement ?? createProtectionAcknowledgement({
    executionAttemptId: request.executionAttemptId,
    protectionRequestId: request.protectionRequestId,
    idempotencyKey: request.idempotencyKey,
    protectedQuantity: request.targetCumulativeProtectedQuantity,
    acknowledgedAt: options.acknowledgedAt ?? 1_400,
  });
  const fingerprint = fingerprintProtectionRequest(request);
  const record = createIdempotencyRecord({
    idempotencyKey: request.idempotencyKey,
    adapterId: "adapter-1",
    environment: "SANDBOX",
    executionAttemptId: request.executionAttemptId,
    operation: "PROTECTION_SUBMISSION",
    requestFingerprint: fingerprint,
    status: "CONFIRMED",
    createdAt: protectionAsOf,
    updatedAt: protectionAsOf,
  });
  return Object.freeze({
    status: "PROTECTION_CONFIRMED",
    preparationCycleId: "preparation-1",
    protectionAsOf,
    executionAttempt: policy.attempt,
    protectionRequest: request,
    executionPolicyResult: policy,
    durableResult: Object.freeze({
      status: "CONFIRMED",
      operation: "PROTECTION_SUBMISSION",
      idempotencyKey: request.idempotencyKey,
      requestFingerprint: fingerprint,
      auditDelivery: "NOT_CONFIGURED",
      record,
      acknowledgement,
    }),
  });
}

function apply(result: ProtectionConfirmedResult, attempt = result.executionAttempt, observationAsOf = 1_400) {
  return applyRealtimeExecutionProtectionAcknowledgement({
    protectionResult: result,
    executionAttempt: attempt,
    observationAsOf,
  });
}

function replaceAcknowledgement(
  source: ProtectionConfirmedResult,
  acknowledgement: ProtectionAcknowledgement | undefined,
): ProtectionConfirmedResult {
  const durableResult = Object.freeze({
    ...source.durableResult,
    ...(acknowledgement === undefined ? { acknowledgement: undefined } : { acknowledgement }),
  });
  return Object.freeze({ ...source, durableResult });
}

describe("Task 024 outer status gating", () => {
  it.each([
    "NO_PROTECTION_ACTION",
    "PROTECTION_SUBMISSION_BLOCKED",
    "PROTECTION_REJECTED",
    "RECONCILIATION_REQUIRED",
    "DURABLE_PROTECTION_CONTROL",
  ] as const)("%s performs no lifecycle processing and needs no context", (status) => {
    const upstream = Object.freeze({
      status,
      preparationCycleId: "preparation-1",
      executionAttempt: confirmed().executionAttempt,
    }) as unknown as RealtimeExecutionProtectionResult;
    const output = applyRealtimeExecutionProtectionAcknowledgement({ protectionResult: upstream });
    expect(output).toEqual({
      status: "NO_PROTECTION_LIFECYCLE",
      preparationCycleId: "preparation-1",
      upstreamStatus: status,
    });
    expect(Object.isFrozen(output)).toBe(true);
  });

  it("does not trust a pending-looking attempt under a blocked outer status", () => {
    const source = confirmed();
    const blocked = Object.freeze({
      status: "PROTECTION_SUBMISSION_BLOCKED",
      reason: "LIVE_EXECUTION_DEFERRED",
      preparationCycleId: source.preparationCycleId,
      protectionAsOf: source.protectionAsOf,
      executionAttempt: source.executionAttempt,
      executionPolicyResult: source.executionPolicyResult,
    }) as const;
    expect(applyRealtimeExecutionProtectionAcknowledgement({ protectionResult: blocked })).toMatchObject({
      status: "NO_PROTECTION_LIFECYCLE",
    });
    expect(source.executionAttempt.state).toBe("PROTECTION_PENDING");
  });
});

describe("Task 024 acknowledgement and durable coherence", () => {
  it("applies a valid confirmation whose durable fingerprints match the canonical request", () => {
    const source = confirmed();
    const output = apply(source);
    expect(output).toMatchObject({
      status: "PROTECTION_ACKNOWLEDGEMENT_APPLIED",
      executionAttempt: { protectedQuantity: "2.75" },
    });
  });

  it("rejects a meaningfully changed request when both durable fingerprints remain stale", () => {
    const source = confirmed();
    const changedRequest = Object.freeze({
      ...source.protectionRequest,
      targetPrice: positiveDecimalString("132"),
    });
    const changedAttempt = Object.freeze({
      ...source.executionAttempt,
      pendingProtectionRequest: changedRequest,
    });
    const changed = Object.freeze({
      ...source,
      protectionRequest: changedRequest,
      executionAttempt: changedAttempt,
      executionPolicyResult: Object.freeze({
        ...source.executionPolicyResult,
        request: changedRequest,
        attempt: changedAttempt,
      }),
    });
    const output = apply(changed);
    expect(output).toMatchObject({
      status: "PROTECTION_LIFECYCLE_REJECTED",
      reason: "PROTECTION_CONFIRMATION_INCOHERENT",
    });
    expect(output.executionAttempt).toBe(changedAttempt);
    expect(changedAttempt.state).toBe("PROTECTION_PENDING");
    expect(changedAttempt.protectedQuantity).toBe("0");
  });

  it("rejects matching arbitrary durable and record fingerprints", () => {
    const source = confirmed();
    const arbitraryFingerprint = "arbitrary-fingerprint" as RequestFingerprint;
    const changed = Object.freeze({
      ...source,
      durableResult: Object.freeze({
        ...source.durableResult,
        requestFingerprint: arbitraryFingerprint,
        record: Object.freeze({
          ...source.durableResult.record,
          requestFingerprint: arbitraryFingerprint,
        }),
      }),
    });
    const output = apply(changed);
    expect(output).toMatchObject({
      status: "PROTECTION_LIFECYCLE_REJECTED",
      reason: "PROTECTION_CONFIRMATION_INCOHERENT",
    });
    expect(output.executionAttempt).toBe(source.executionAttempt);
    expect(source.executionAttempt.state).toBe("PROTECTION_PENDING");
    expect(source.executionAttempt.protectedQuantity).toBe("0");
  });

  it("requires the actual durable acknowledgement and never synthesizes it", () => {
    const source = confirmed();
    const output = apply(replaceAcknowledgement(source, undefined));
    expect(output).toMatchObject({
      status: "PROTECTION_LIFECYCLE_REJECTED",
      reason: "CONFIRMED_PROTECTION_ACKNOWLEDGEMENT_MISSING",
    });
    expect(output.executionAttempt).toBe(source.executionAttempt);
  });

  it.each([
    ["executionAttemptId", "wrong-attempt"],
    ["protectionRequestId", "wrong-request"],
    ["idempotencyKey", "wrong-key"],
  ] as const)("rejects wrong acknowledgement %s", (field, value) => {
    const source = confirmed();
    const acknowledgement = createProtectionAcknowledgement({
      ...source.durableResult.acknowledgement!,
      [field]: value,
    });
    const output = apply(replaceAcknowledgement(source, acknowledgement));
    expect(output).toMatchObject({
      status: "PROTECTION_LIFECYCLE_REJECTED",
      reason: "PROTECTION_CONFIRMATION_INCOHERENT",
    });
    expect(source.executionAttempt.state).toBe("PROTECTION_PENDING");
  });

  it.each([
    ["record attempt", { executionAttemptId: "other-attempt" }],
    ["record key", { idempotencyKey: "other-key" }],
    ["record operation", { operation: "ENTRY_SUBMISSION" as const }],
    ["record status", { status: "SUBMITTED" as const }],
  ])("rejects incoherent durable %s", (_name, recordPatch) => {
    const source = confirmed();
    const changed = Object.freeze({
      ...source,
      durableResult: Object.freeze({
        ...source.durableResult,
        record: Object.freeze({ ...source.durableResult.record, ...recordPatch }),
      }),
    }) as ProtectionConfirmedResult;
    expect(apply(changed)).toMatchObject({
      status: "PROTECTION_LIFECYCLE_REJECTED",
      reason: "PROTECTION_CONFIRMATION_INCOHERENT",
    });
  });

  it("rejects an unrelated outer request or policy attempt", () => {
    const source = confirmed();
    const wrongRequest = Object.freeze({
      ...source.protectionRequest,
      protectionRequestId: "unrelated-request",
    }) as ProtectionRequest;
    const changed = Object.freeze({ ...source, protectionRequest: wrongRequest });
    expect(apply(changed)).toMatchObject({ reason: "PROTECTION_CONFIRMATION_INCOHERENT" });
  });

  it.each(["2.74", "2.76"])("delegates inconsistent quantity %s to acknowledgeProtection", (quantity) => {
    const source = confirmed();
    const acknowledgement = createProtectionAcknowledgement({
      ...source.durableResult.acknowledgement!,
      protectedQuantity: quantity,
    });
    const output = apply(replaceAcknowledgement(source, acknowledgement));
    expect(output).toMatchObject({
      status: "PROTECTION_LIFECYCLE_REJECTED",
      reason: "PROTECTION_REQUEST_MISMATCH",
      transitionResult: { reason: "PROTECTION_REQUEST_MISMATCH" },
    });
    expect(output.executionAttempt).toBe(source.executionAttempt);
  });
});

describe("Task 024 observation and chronology", () => {
  it.each([undefined, -1, 1.5, Number.NaN])("rejects invalid observation time %s", (observationAsOf) => {
    const source = confirmed();
    expect(applyRealtimeExecutionProtectionAcknowledgement({
      protectionResult: source,
      executionAttempt: source.executionAttempt,
      observationAsOf,
    })).toMatchObject({ reason: "INVALID_OBSERVATION_TIME" });
  });

  it("rejects a future acknowledgement and accepts exact observation equality", () => {
    const source = confirmed("2.75", managedCapabilities, { acknowledgedAt: 1_401 });
    expect(apply(source, source.executionAttempt, 1_400)).toMatchObject({
      reason: "PROTECTION_ACKNOWLEDGEMENT_OBSERVED_IN_FUTURE",
    });
    expect(apply(source, source.executionAttempt, 1_401)).toMatchObject({
      status: "PROTECTION_ACKNOWLEDGEMENT_APPLIED",
    });
  });

  it("rejects acknowledgement before Task 023 protectionAsOf", () => {
    const source = confirmed("2.75", managedCapabilities, { acknowledgedAt: 1_299 });
    expect(apply(source)).toMatchObject({
      reason: "PROTECTION_ACKNOWLEDGEMENT_CHRONOLOGY_INVALID",
    });
  });

  it("reuses execution-engine out-of-order chronology", () => {
    const source = confirmed("2.75", managedCapabilities, {
      protectionAsOf: 1_100,
      acknowledgedAt: 1_150,
    });
    expect(apply(source, source.executionAttempt, 1_200)).toMatchObject({
      reason: "OUT_OF_ORDER_EXECUTION_EVENT",
      transitionResult: { reason: "OUT_OF_ORDER_EXECUTION_EVENT" },
    });
  });
});

describe("Task 024 partial, full, and incremental protection", () => {
  it("applies exact partial managed protection without implying an exit", () => {
    const source = confirmed("2.75");
    const output = apply(source);
    expect(output).toMatchObject({
      status: "PROTECTION_ACKNOWLEDGEMENT_APPLIED",
      acknowledgement: { kind: "PROTECTION_ACCEPTED", protectedQuantity: "2.75" },
      executionAttempt: {
        state: "ENTRY_PARTIALLY_FILLED",
        entryOrderStatus: "WORKING",
        filledEntryQuantity: "2.75",
        protectedQuantity: "2.75",
        unprotectedFilledQuantity: "0",
        protectionMode: "MANAGED_PROTECTION",
        lastExecutionEventAt: 1_400,
      },
    });
    if (output.status !== "PROTECTION_ACKNOWLEDGEMENT_APPLIED") throw new Error("unexpected result");
    expect(output.executionAttempt.pendingProtectionRequest).toBeUndefined();
    expect("position" in output).toBe(false);
    expect("pnl" in output).toBe(false);
  });

  it.each([
    ["MANAGED_PROTECTION", managedCapabilities],
    ["NATIVE_BRACKET", nativeCapabilities],
  ] as const)("preserves full-fill %s semantics", (mode, capabilities) => {
    const source = confirmed("10", capabilities);
    const output = apply(source);
    expect(output).toMatchObject({
      status: "PROTECTION_ACKNOWLEDGEMENT_APPLIED",
      executionAttempt: {
        state: "PROTECTED",
        entryOrderStatus: "FILLED",
        protectionMode: mode,
        protectedQuantity: "10",
        unprotectedFilledQuantity: "0",
      },
    });
  });

  it("acknowledges a second incremental request using existing policy accumulation", () => {
    const firstSource = confirmed("2.75");
    const first = apply(firstSource);
    if (first.status !== "PROTECTION_ACKNOWLEDGEMENT_APPLIED") throw new Error("first protection failed");
    const afterMoreFill = filledAttempt("1.25", managedCapabilities, first.executionAttempt, "fill-2", 1_500);
    const secondSource = confirmed("ignored", managedCapabilities, {
      attempt: afterMoreFill,
      protectionAsOf: 1_600,
      acknowledgedAt: 1_700,
    });
    const second = apply(secondSource, secondSource.executionAttempt, 1_700);
    expect(second).toMatchObject({
      status: "PROTECTION_ACKNOWLEDGEMENT_APPLIED",
      acknowledgement: { protectedQuantity: "4" },
      executionAttempt: {
        state: "ENTRY_PARTIALLY_FILLED",
        filledEntryQuantity: "4",
        protectedQuantity: "4",
        unprotectedFilledQuantity: "0",
        lastExecutionEventAt: 1_700,
      },
    });
  });
});

describe("Task 024 current state, replay, atomicity, and immutability", () => {
  it.each([
    ["attempt identity", { executionAttemptId: "other-attempt" }],
    ["plan identity", { executionPlanId: "other-plan" }],
    ["instrument", { instrumentId: createInstrumentId({ venue: "TEST", venueSymbol: "XYZ", instrumentKind: "CFD" }) }],
    ["request state", { pendingProtectionRequest: undefined }],
  ])("rejects substituted current %s", (_name, patch) => {
    const source = confirmed();
    const current = Object.freeze({ ...source.executionAttempt, ...patch }) as ExecutionAttempt;
    const output = apply(source, current);
    expect(output).toMatchObject({ reason: "CURRENT_ATTEMPT_MISMATCH" });
    expect(output.executionAttempt).toBe(current);
  });

  it("is deterministic across function replay and fresh stateless projector instances", () => {
    const source = confirmed();
    const input = Object.freeze({
      protectionResult: source,
      executionAttempt: source.executionAttempt,
      observationAsOf: 1_400,
    });
    const first = applyRealtimeExecutionProtectionAcknowledgement(input);
    const second = applyRealtimeExecutionProtectionAcknowledgement(input);
    const third = new RealtimeExecutionProtectionLifecycleEngine().apply(input);
    const fourth = new RealtimeExecutionProtectionLifecycleEngine().apply(input);
    expect(second).toEqual(first);
    expect(third).toEqual(first);
    expect(fourth).toEqual(first);
  });

  it("rejects replay against the already-applied attempt without double protection", () => {
    const source = confirmed();
    const first = apply(source);
    if (first.status !== "PROTECTION_ACKNOWLEDGEMENT_APPLIED") throw new Error("first apply failed");
    const replay = apply(source, first.executionAttempt);
    expect(replay).toMatchObject({ reason: "CURRENT_ATTEMPT_MISMATCH" });
    expect(first.executionAttempt.protectedQuantity).toBe("2.75");
  });

  it("does not mutate or partially patch any caller-owned value", () => {
    const source = confirmed();
    const acknowledgement = source.durableResult.acknowledgement!;
    const attemptBefore = JSON.stringify(source.executionAttempt);
    const sourceBefore = JSON.stringify(source);
    const acknowledgementBefore = JSON.stringify(acknowledgement);
    const output = apply(source);
    expect(JSON.stringify(source.executionAttempt)).toBe(attemptBefore);
    expect(JSON.stringify(source)).toBe(sourceBefore);
    expect(JSON.stringify(acknowledgement)).toBe(acknowledgementBefore);
    expect(source.executionAttempt.state).toBe("PROTECTION_PENDING");
    expect(Object.isFrozen(output)).toBe(true);
    if (output.status !== "PROTECTION_ACKNOWLEDGEMENT_APPLIED") throw new Error("unexpected result");
    expect(Object.isFrozen(output.executionAttempt)).toBe(true);
    expect(output.executionAttempt).not.toBe(source.executionAttempt);
  });

  it("leaves the original pending snapshot unchanged after a conflicting acknowledgement", () => {
    const source = confirmed();
    const conflict = createProtectionAcknowledgement({
      ...source.durableResult.acknowledgement!,
      protectedQuantity: "9",
    });
    const output = apply(replaceAcknowledgement(source, conflict));
    expect(output).toMatchObject({ reason: "PROTECTION_REQUEST_MISMATCH" });
    expect(source.executionAttempt).toMatchObject({
      state: "PROTECTION_PENDING",
      protectedQuantity: "0",
      unprotectedFilledQuantity: "2.75",
    });
  });

  it("uses no adapter, repository, reconciliation, or provider dependency", () => {
    expect(RealtimeExecutionProtectionLifecycleEngine.length).toBe(0);
    const source = confirmed();
    expect(new RealtimeExecutionProtectionLifecycleEngine().apply({
      protectionResult: source,
      executionAttempt: source.executionAttempt,
      observationAsOf: 1_400,
    })).toMatchObject({ status: "PROTECTION_ACKNOWLEDGEMENT_APPLIED" });
    expect(brokerAdapterId("adapter-1")).toBe("adapter-1");
  });
});
