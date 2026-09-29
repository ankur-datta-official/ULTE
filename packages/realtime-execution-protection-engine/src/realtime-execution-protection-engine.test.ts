import { describe, expect, it, vi } from "vitest";
import {
  brokerAdapterId,
  compareIdempotencyClaim,
  credentialProfileRef,
  createBrokerAdapterDescriptor,
  createBrokerAdapterRegistry,
  createBrokerFailure,
  createIdempotencyRecord,
  type BrokerAdapter,
  type ExecutionEnvironment,
  type IdempotencyClaimInput,
  type IdempotencyClaimResult,
  type IdempotencyOutcomeInput,
  type IdempotencyRecord,
  type IdempotencyRecordStatus,
  type IdempotencyRepository,
} from "@ulte/broker-adapters";
import {
  acknowledgeEntrySubmission,
  applyEntryFill,
  createAdapterCapabilities,
  createEntryAcknowledgement,
  createExecutionAttempt,
  createFillEvent,
  createProtectionAcknowledgement,
  createProtectionRejection,
  requestEntrySubmission,
  type AdapterCapabilities,
  type EntryCancellationRequest,
  type EntrySubmissionRequest,
  type ExecutionAttempt,
  type ProtectionRequest,
} from "@ulte/execution-engine";
import {
  currencyCode,
  createInstrumentId,
  positiveDecimalString,
  unixMs,
} from "@ulte/instrument-model";
import type { RealtimeExecutionFillResult } from "@ulte/realtime-execution-fill-engine";
import {
  RealtimeExecutionProtectionEngine,
  type RealtimeExecutionProtectionContext,
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
    schemaVersion: "EXECUTION_PLAN_V2",
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
    quantityUnit: "contract", accountCurrency: currencyCode("USD"),
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

function appliedFill(
  quantity = "10",
  capabilities: AdapterCapabilities = managedCapabilities,
  fillId = "fill-1",
  filledAt = 1_200,
): RealtimeExecutionFillResult {
  const attempt = readyAttempt(capabilities);
  const fill = createFillEvent({
    executionAttemptId: attempt.executionAttemptId,
    adapterOrderId: attempt.adapterOrderId!,
    fillId,
    filledQuantity: quantity,
    fillPrice: "100.10",
    filledAt,
  });
  const transitionResult = applyEntryFill(attempt, fill);
  if (transitionResult.status !== "EXECUTION_ATTEMPT_UPDATED") throw new Error("fixture fill failed");
  return Object.freeze({
    status: "FILL_APPLIED",
    preparationCycleId: "preparation-1",
    submissionAsOf: unixMs(1_050),
    observationAsOf: unixMs(filledAt),
    fill,
    executionAttempt: transitionResult.attempt,
    transitionResult,
  });
}

function nonActionable(status: "NO_FILL_PROCESSING" | "FILL_REJECTED" | "DUPLICATE_FILL") {
  if (status === "NO_FILL_PROCESSING") {
    return Object.freeze({
      status,
      preparationCycleId: "preparation-1",
      upstreamStatus: "NO_SUBMISSION",
    }) as RealtimeExecutionFillResult;
  }
  const applied = appliedFill("4");
  if (status === "DUPLICATE_FILL") return Object.freeze({ ...applied, status });
  return Object.freeze({
    status,
    reason: "INVALID_TRANSITION",
    preparationCycleId: "preparation-1",
    executionAttempt: "executionAttempt" in applied ? applied.executionAttempt : undefined,
  }) as RealtimeExecutionFillResult;
}

function storageKey(adapterId: string, idempotencyKey: string): string {
  return `${adapterId}\u0000${idempotencyKey}`;
}

class DurableMemoryRepository implements IdempotencyRepository {
  readonly records = new Map<string, IdempotencyRecord>();
  readonly events: string[] = [];

  async claim(input: IdempotencyClaimInput): Promise<IdempotencyClaimResult> {
    this.events.push("claim");
    const key = storageKey(input.adapterId, input.idempotencyKey);
    const existing = this.records.get(key);
    const comparison = compareIdempotencyClaim(existing, input);
    if (comparison.status === "CONFLICT") {
      return { status: "CONFLICT", reason: comparison.reason, record: existing! };
    }
    if (comparison.status === "EXISTING_SAME_REQUEST") {
      return { status: "EXISTING_SAME_REQUEST", record: existing! };
    }
    const record = createIdempotencyRecord({
      ...input,
      status: "CLAIMED",
      createdAt: input.claimedAt,
      updatedAt: input.claimedAt,
    });
    this.records.set(key, record);
    return { status: "CLAIMED_NEW", record };
  }

  async read(adapterId: ReturnType<typeof brokerAdapterId>, idempotencyKey: string) {
    return this.records.get(storageKey(adapterId, idempotencyKey));
  }

  async recordOutcome(input: IdempotencyOutcomeInput): Promise<IdempotencyRecord> {
    this.events.push(`record:${input.status}`);
    const key = storageKey(input.adapterId, input.idempotencyKey);
    const current = this.records.get(key);
    if (current === undefined) throw new Error("outcome without claim");
    if (current.environment !== input.environment) throw new Error("environment conflict");
    if (current.requestFingerprint !== input.requestFingerprint) throw new Error("fingerprint conflict");
    const next = createIdempotencyRecord({
      ...current,
      status: input.status,
      updatedAt: input.updatedAt,
      ...(input.adapterOrderId === undefined ? {} : { adapterOrderId: input.adapterOrderId }),
    });
    this.records.set(key, next);
    return next;
  }

  forceOnlyRecordStatus(status: IdempotencyRecordStatus): void {
    const [entry] = [...this.records.entries()];
    if (entry === undefined) throw new Error("record required");
    const [key, current] = entry;
    this.records.set(key, createIdempotencyRecord({ ...current, status }));
  }
}

function adapter(
  environment: ExecutionEnvironment = "SANDBOX",
  capabilities: AdapterCapabilities = managedCapabilities,
  overrides: Partial<BrokerAdapter> = {},
  profile = "credential-profile-1",
): BrokerAdapter {
  const descriptor = createBrokerAdapterDescriptor({
    adapterId: "adapter-1",
    environment,
    credentialProfileRef: profile,
    capabilities,
  });
  return {
    descriptor,
    capabilities,
    submitEntry: vi.fn(async (_request: EntrySubmissionRequest) => { throw new Error("forbidden"); }),
    submitProtection: vi.fn(async (request: ProtectionRequest) => createProtectionAcknowledgement({
      executionAttemptId: request.executionAttemptId,
      protectionRequestId: request.protectionRequestId,
      idempotencyKey: request.idempotencyKey,
      protectedQuantity: request.targetCumulativeProtectedQuantity,
      acknowledgedAt: 1_300,
    })),
    cancelEntry: vi.fn(async (_request: EntryCancellationRequest) => { throw new Error("forbidden"); }),
    ...overrides,
  };
}

function context(
  environment: ExecutionEnvironment = "SANDBOX",
  protectionAsOf = 1_300,
  profile = "credential-profile-1",
): RealtimeExecutionProtectionContext {
  return Object.freeze({
    executionEnvironment: environment,
    adapterId: brokerAdapterId("adapter-1"),
    credentialProfileRef: credentialProfileRef(profile),
    protectionAsOf,
  });
}

function engine(repository: DurableMemoryRepository, broker = adapter()) {
  return {
    broker,
    subject: new RealtimeExecutionProtectionEngine({
      adapterRegistry: createBrokerAdapterRegistry([broker]),
      idempotencyRepository: repository,
    }),
  };
}

describe("Task 022 eligibility and pre-claim controls", () => {
  it.each(["NO_FILL_PROCESSING", "FILL_REJECTED", "DUPLICATE_FILL"] as const)(
    "%s requires no context and performs no durable or adapter action",
    async (status) => {
      const repository = new DurableMemoryRepository();
      const { subject, broker } = engine(repository);
      await expect(subject.submit({ fillLifecycle: nonActionable(status) })).resolves.toMatchObject({
        status: "NO_PROTECTION_ACTION",
      });
      expect(repository.events).toEqual([]);
      expect(broker.submitProtection).not.toHaveBeenCalled();
      expect(broker.submitEntry).not.toHaveBeenCalled();
      expect(broker.cancelEntry).not.toHaveBeenCalled();
    },
  );

  it("asks existing policy about non-eligible execution state before requiring context", async () => {
    const repository = new DurableMemoryRepository();
    const lifecycle = appliedFill("4");
    if (lifecycle.status !== "FILL_APPLIED") throw new Error("fixture mismatch");
    const noExposure = Object.freeze({
      ...lifecycle,
      executionAttempt: Object.freeze({
        ...lifecycle.executionAttempt,
        filledEntryQuantity: "0" as const,
        unprotectedFilledQuantity: "0" as const,
      }),
    });
    const { subject, broker } = engine(repository);
    await expect(subject.submit({ fillLifecycle: noExposure })).resolves.toMatchObject({
      status: "NO_PROTECTION_ACTION",
      reason: "PROTECTION_POLICY_NOT_ACTIONABLE",
      executionPolicyResult: { reason: "NO_UNPROTECTED_FILLED_QUANTITY" },
    });
    expect(repository.events).toEqual([]);
    expect(broker.submitProtection).not.toHaveBeenCalled();
  });

  it("rejects malformed or early context before claim and permits a corrected retry", async () => {
    const repository = new DurableMemoryRepository();
    const lifecycle = appliedFill();
    const { subject, broker } = engine(repository);
    await expect(subject.submit({ fillLifecycle: lifecycle })).rejects.toThrow("context is required");
    await expect(subject.submit({ fillLifecycle: lifecycle, context: context("SANDBOX", 1_199) }))
      .rejects.toThrow("cannot precede");
    expect(repository.events).toEqual([]);
    expect(broker.submitProtection).not.toHaveBeenCalled();
    await expect(subject.submit({ fillLifecycle: lifecycle, context: context("SANDBOX", 1_200) }))
      .resolves.toMatchObject({ status: "PROTECTION_CONFIRMED" });
  });

  it("hard-blocks LIVE before registry resolution, durable claim, or adapter calls", async () => {
    const repository = new DurableMemoryRepository();
    const live = adapter("LIVE");
    const subject = new RealtimeExecutionProtectionEngine({
      adapterRegistry: createBrokerAdapterRegistry([]),
      idempotencyRepository: repository,
    });
    await expect(subject.submit({ fillLifecycle: appliedFill(), context: context("LIVE") }))
      .resolves.toMatchObject({
        status: "PROTECTION_SUBMISSION_BLOCKED",
        reason: "LIVE_EXECUTION_DEFERRED",
      });
    expect(repository.events).toEqual([]);
    expect(live.submitProtection).not.toHaveBeenCalled();
  });

  it("validates adapter, environment, and opaque credential binding before claim", async () => {
    const repository = new DurableMemoryRepository();
    const { subject, broker } = engine(repository);
    await expect(subject.submit({
      fillLifecycle: appliedFill(),
      context: { ...context(), adapterId: brokerAdapterId("missing") },
    })).rejects.toThrow("Unknown broker adapter");
    await expect(subject.submit({ fillLifecycle: appliedFill(), context: context("SANDBOX", 1_300, "other") }))
      .rejects.toThrow("credential profile");
    expect(repository.events).toEqual([]);
    expect(broker.submitProtection).not.toHaveBeenCalled();
  });

  it("blocks changed or unsafe adapter capabilities before claim", async () => {
    const repository = new DurableMemoryRepository();
    const unsafe = createAdapterCapabilities({
      ...managedCapabilities,
      supportsCloseOnlyExit: false,
      supportsPartialFillReporting: false,
    });
    const broker = adapter("SANDBOX", unsafe);
    const result = await engine(repository, broker).subject.submit({
      fillLifecycle: appliedFill(),
      context: context(),
    });
    expect(result).toMatchObject({
      status: "PROTECTION_SUBMISSION_BLOCKED",
      reason: "ADAPTER_PROTECTION_UNSUPPORTED",
    });
    expect(repository.events).toEqual([]);
    expect(broker.submitProtection).not.toHaveBeenCalled();
  });
});

describe("existing protection policy and durable orchestration", () => {
  it.each(["DRY_RUN", "SANDBOX"] as const)(
    "submits policy-generated managed protection in %s after CLAIM and SUBMITTED",
    async (environment) => {
      const repository = new DurableMemoryRepository();
      let broker!: BrokerAdapter;
      broker = adapter(environment, managedCapabilities, {
        submitProtection: vi.fn(async (request) => {
          repository.events.push("adapter");
          expect((await repository.read(brokerAdapterId("adapter-1"), request.idempotencyKey))?.status)
            .toBe("SUBMITTED");
          expect(request).toMatchObject({
            mode: "MANAGED_PROTECTION",
            exitSide: "SELL",
            protectedQuantity: "10",
            targetCumulativeProtectedQuantity: "10",
            stopTriggerPrice: "90.25",
            targetPrice: "131.75",
          });
          return createProtectionAcknowledgement({
            executionAttemptId: request.executionAttemptId,
            protectionRequestId: request.protectionRequestId,
            idempotencyKey: request.idempotencyKey,
            protectedQuantity: request.targetCumulativeProtectedQuantity,
            acknowledgedAt: 1_300,
          });
        }),
      });
      const result = await engine(repository, broker).subject.submit({
        fillLifecycle: appliedFill(),
        context: context(environment),
      });
      expect(result.status).toBe("PROTECTION_CONFIRMED");
      expect(repository.events).toEqual(["claim", "record:SUBMITTED", "adapter", "record:CONFIRMED"]);
      expect(broker.submitProtection).toHaveBeenCalledTimes(1);
      expect(broker.submitEntry).not.toHaveBeenCalled();
      expect(broker.cancelEntry).not.toHaveBeenCalled();
      if (result.status === "PROTECTION_CONFIRMED") {
        expect(result.protectionRequest).toBe(result.executionPolicyResult.request);
        expect(result.durableResult.acknowledgement).toMatchObject({
          kind: "PROTECTION_ACCEPTED",
          protectedQuantity: "10",
        });
      }
    },
  );

  it("uses exact incremental policy protection for partial fills without over-protection", async () => {
    const repository = new DurableMemoryRepository();
    const { subject, broker } = engine(repository);
    const result = await subject.submit({ fillLifecycle: appliedFill("2.75"), context: context() });
    expect(result).toMatchObject({
      status: "PROTECTION_CONFIRMED",
      protectionRequest: {
        protectedQuantity: "2.75",
        targetCumulativeProtectedQuantity: "2.75",
        stopTriggerPrice: "90.25",
        targetPrice: "131.75",
      },
      executionAttempt: { state: "PROTECTION_PENDING", filledEntryQuantity: "2.75" },
    });
    expect(broker.submitProtection).toHaveBeenCalledTimes(1);
  });

  it("preserves existing native mode rather than inventing an already-attached state", async () => {
    const repository = new DurableMemoryRepository();
    const broker = adapter("SANDBOX", nativeCapabilities);
    const result = await engine(repository, broker).subject.submit({
      fillLifecycle: appliedFill("10", nativeCapabilities),
      context: context(),
    });
    expect(result).toMatchObject({
      status: "PROTECTION_CONFIRMED",
      protectionRequest: { mode: "NATIVE_BRACKET", protectedQuantity: "10" },
    });
    expect(broker.submitProtection).toHaveBeenCalledTimes(1);
  });

  it("preserves a typed protection rejection", async () => {
    const repository = new DurableMemoryRepository();
    const broker = adapter("SANDBOX", managedCapabilities, {
      submitProtection: vi.fn(async (request) => createProtectionRejection({
        executionAttemptId: request.executionAttemptId,
        protectionRequestId: request.protectionRequestId,
        idempotencyKey: request.idempotencyKey,
        adapterReasonCode: "PROTECTION_DENIED",
        rejectedAt: 1_300,
      })),
    });
    const result = await engine(repository, broker).subject.submit({
      fillLifecycle: appliedFill(), context: context(),
    });
    expect(result).toMatchObject({
      status: "PROTECTION_REJECTED",
      durableResult: { rejection: { kind: "PROTECTION_REJECTED", adapterReasonCode: "PROTECTION_DENIED" } },
    });
  });

  it.each([
    ["confirmed", false],
    ["rejected", true],
  ] as const)("replays durable %s after engine restart with one total adapter call", async (_name, rejected) => {
    const repository = new DurableMemoryRepository();
    const broker = adapter("SANDBOX", managedCapabilities, rejected ? {
      submitProtection: vi.fn(async (request) => createProtectionRejection({
        executionAttemptId: request.executionAttemptId,
        protectionRequestId: request.protectionRequestId,
        idempotencyKey: request.idempotencyKey,
        adapterReasonCode: "NO",
        rejectedAt: 1_300,
      })),
    } : {});
    const lifecycle = appliedFill();
    const first = await engine(repository, broker).subject.submit({ fillLifecycle: lifecycle, context: context() });
    const second = await engine(repository, broker).subject.submit({ fillLifecycle: lifecycle, context: context() });
    expect(first.status).toBe(rejected ? "PROTECTION_REJECTED" : "PROTECTION_CONFIRMED");
    expect(second.status).toBe(rejected ? "PROTECTION_REJECTED" : "PROTECTION_CONFIRMED");
    expect(broker.submitProtection).toHaveBeenCalledTimes(1);
  });

  it.each(["CLAIMED", "SUBMITTED", "OUTCOME_UNKNOWN"] as const)(
    "does not blindly resubmit existing %s durable state",
    async (status) => {
      const repository = new DurableMemoryRepository();
      const broker = adapter();
      const lifecycle = appliedFill();
      await engine(repository, broker).subject.submit({ fillLifecycle: lifecycle, context: context() });
      repository.forceOnlyRecordStatus(status);
      const result = await engine(repository, broker).subject.submit({ fillLifecycle: lifecycle, context: context() });
      expect(result.status).toBe("RECONCILIATION_REQUIRED");
      expect(broker.submitProtection).toHaveBeenCalledTimes(1);
    },
  );

  it("turns a possibly exposed adapter throw into durable reconciliation across restart", async () => {
    const repository = new DurableMemoryRepository();
    const failure = createBrokerFailure({
      category: "TIMEOUT",
      certainty: "OUTCOME_UNKNOWN",
      submissionExposure: "MAY_HAVE_BEEN_SUBMITTED",
    });
    const broker = adapter("SANDBOX", managedCapabilities, {
      submitProtection: vi.fn(async () => { throw failure; }),
    });
    const lifecycle = appliedFill();
    const first = await engine(repository, broker).subject.submit({ fillLifecycle: lifecycle, context: context() });
    const second = await engine(repository, broker).subject.submit({ fillLifecycle: lifecycle, context: context() });
    expect(first).toMatchObject({
      status: "RECONCILIATION_REQUIRED",
      durableResult: { requirement: { reason: "ADAPTER_OUTCOME_UNKNOWN" } },
    });
    expect(second.status).toBe("RECONCILIATION_REQUIRED");
    expect(broker.submitProtection).toHaveBeenCalledTimes(1);
  });

  it("preserves cross-environment durable identity and credential-profile replay safety", async () => {
    const repository = new DurableMemoryRepository();
    const lifecycle = appliedFill();
    const sandbox = adapter("SANDBOX");
    await engine(repository, sandbox).subject.submit({ fillLifecycle: lifecycle, context: context("SANDBOX") });

    const dryRun = adapter("DRY_RUN");
    const conflict = await engine(repository, dryRun).subject.submit({
      fillLifecycle: lifecycle,
      context: context("DRY_RUN"),
    });
    expect(conflict).toMatchObject({
      status: "DURABLE_PROTECTION_CONTROL",
      durableResult: { status: "IDEMPOTENCY_CONFLICT" },
    });
    expect(dryRun.submitProtection).not.toHaveBeenCalled();

    const changedProfile = adapter("SANDBOX", managedCapabilities, {}, "credential-profile-2");
    const replay = await engine(repository, changedProfile).subject.submit({
      fillLifecycle: lifecycle,
      context: context("SANDBOX", 1_300, "credential-profile-2"),
    });
    expect(replay.status).toBe("PROTECTION_CONFIRMED");
    expect(changedProfile.submitProtection).not.toHaveBeenCalled();
  });

  it("uses durable arbitration for concurrent identical protection attempts", async () => {
    const repository = new DurableMemoryRepository();
    const broker = adapter();
    const lifecycle = appliedFill();
    const results = await Promise.all([
      engine(repository, broker).subject.submit({ fillLifecycle: lifecycle, context: context() }),
      engine(repository, broker).subject.submit({ fillLifecycle: lifecycle, context: context() }),
    ]);
    expect(broker.submitProtection).toHaveBeenCalledTimes(1);
    expect(results.map((result) => result.status).sort()).toEqual([
      "PROTECTION_CONFIRMED", "RECONCILIATION_REQUIRED",
    ]);
  });

  it("does not mutate inputs and freezes the public result", async () => {
    const repository = new DurableMemoryRepository();
    const lifecycle = appliedFill();
    const protectionContext = context();
    const before = JSON.stringify({ lifecycle, protectionContext });
    const result = await engine(repository).subject.submit({ fillLifecycle: lifecycle, context: protectionContext });
    expect(JSON.stringify({ lifecycle, protectionContext })).toBe(before);
    expect(Object.isFrozen(result)).toBe(true);
    expect("executionAttempt" in result && Object.isFrozen(result.executionAttempt)).toBe(true);
  });
});
