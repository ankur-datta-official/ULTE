import { describe, expect, it, vi } from "vitest";
import {
  brokerAdapterId,
  compareIdempotencyClaim,
  createBrokerAdapterDescriptor,
  createBrokerFailure,
  createIdempotencyRecord,
  fingerprintEntryCancellation,
  fingerprintEntrySubmission,
  fingerprintProtectionRequest,
  type BrokerAdapter,
  type IdempotencyClaimInput,
  type IdempotencyClaimResult,
  type IdempotencyOperation,
  type IdempotencyOutcomeInput,
  type IdempotencyRecord,
  type IdempotencyRecordStatus,
  type IdempotencyRepository,
  type RequestFingerprint,
} from "@ulte/broker-adapters";
import {
  createAdapterCapabilities,
  createCancellationAcknowledgement,
  createCancellationRejection,
  createEntryAcknowledgement,
  createEntryRejection,
  createProtectionAcknowledgement,
  createProtectionRejection,
  type EntryCancellationRequest,
  type EntrySubmissionRequest,
  type ProtectionRequest,
} from "@ulte/execution-engine";
import { createInstrumentId, positiveDecimalString } from "@ulte/instrument-model";
import {
  createReconciliationRequest,
  createReconciliationRequestFromRequirement,
  orchestrateEntryCancellation,
  orchestrateEntrySubmission,
  orchestrateProtectionSubmission,
  reconcileExecutionOutcome,
  type ReconciliationObservation,
  type ReconciliationProvider,
} from "./index.js";

const capabilities = createAdapterCapabilities({
  supportsClientIdempotency: false,
  supportsCloseOnlyExit: true,
  supportsNativeBracketProtection: false,
  supportsProtectionModification: true,
  supportsOrderCancellation: true,
  supportsPartialFillReporting: true,
});

const instrumentId = createInstrumentId({
  venue: "TEST",
  venueSymbol: "ABC",
  instrumentKind: "CFD",
});

function entry(overrides: Partial<EntrySubmissionRequest> = {}): EntrySubmissionRequest {
  return Object.freeze({
    kind: "ENTRY",
    executionAttemptId: "attempt-1",
    idempotencyKey: "entry-key-1",
    instrumentId,
    side: "BUY",
    quantity: positiveDecimalString("1"),
    limitPrice: positiveDecimalString("100"),
    ...overrides,
  });
}

function protection(overrides: Partial<ProtectionRequest> = {}): ProtectionRequest {
  return Object.freeze({
    kind: "PROTECTION",
    executionAttemptId: "attempt-1",
    protectionRequestId: "protection-1",
    idempotencyKey: "protection-key-1",
    instrumentId,
    mode: "MANAGED_PROTECTION",
    exitSide: "SELL",
    protectedQuantity: positiveDecimalString("1"),
    targetCumulativeProtectedQuantity: positiveDecimalString("1"),
    stopTriggerPrice: positiveDecimalString("90"),
    targetPrice: positiveDecimalString("130"),
    ...overrides,
  });
}

function cancellation(overrides: Partial<EntryCancellationRequest> = {}): EntryCancellationRequest {
  return Object.freeze({
    kind: "ENTRY_CANCELLATION",
    executionAttemptId: "attempt-1",
    cancellationRequestId: "cancel-1",
    idempotencyKey: "cancel-key-1",
    adapterOrderId: "order-1",
    ...overrides,
  });
}

function key(adapterId: string, idempotencyKey: string): string {
  return `${adapterId}\u0000${idempotencyKey}`;
}

class FakeRepository implements IdempotencyRepository {
  readonly records = new Map<string, IdempotencyRecord>();
  readonly events: string[] = [];
  readonly durableEnvironments: string[] = [];

  async claim(input: IdempotencyClaimInput): Promise<IdempotencyClaimResult> {
    this.events.push("claim");
    this.durableEnvironments.push(input.environment);
    const existing = this.records.get(key(input.adapterId, input.idempotencyKey));
    const comparison = compareIdempotencyClaim(existing, input);
    if (comparison.status === "CONFLICT") {
      return { status: "CONFLICT", reason: comparison.reason, record: existing! };
    }
    if (comparison.status === "EXISTING_SAME_REQUEST") {
      return { status: "EXISTING_SAME_REQUEST", record: existing! };
    }
    const record = createIdempotencyRecord({
      adapterId: input.adapterId,
      environment: input.environment,
      idempotencyKey: input.idempotencyKey,
      executionAttemptId: input.executionAttemptId,
      operation: input.operation,
      requestFingerprint: input.requestFingerprint,
      status: "CLAIMED",
      createdAt: input.claimedAt,
      updatedAt: input.claimedAt,
    });
    this.records.set(key(input.adapterId, input.idempotencyKey), record);
    return { status: "CLAIMED_NEW", record };
  }

  async read(adapterId: ReturnType<typeof brokerAdapterId>, idempotencyKey: string): Promise<IdempotencyRecord | undefined> {
    return this.records.get(key(adapterId, idempotencyKey));
  }

  async recordOutcome(input: IdempotencyOutcomeInput): Promise<IdempotencyRecord> {
    this.events.push(`record:${input.status}`);
    this.durableEnvironments.push(input.environment);
    const mapKey = key(input.adapterId, input.idempotencyKey);
    const current = this.records.get(mapKey);
    if (current === undefined) throw new Error("missing record");
    if (current.requestFingerprint !== input.requestFingerprint) throw new Error("fingerprint conflict");
    if (current.environment !== input.environment) throw new Error("environment conflict");
    if (input.updatedAt < current.updatedAt) throw new RangeError("updatedAt moved backwards");
    const record = createIdempotencyRecord({
      adapterId: current.adapterId,
      environment: current.environment,
      idempotencyKey: current.idempotencyKey,
      executionAttemptId: current.executionAttemptId,
      operation: current.operation,
      requestFingerprint: current.requestFingerprint,
      status: input.status,
      createdAt: current.createdAt,
      updatedAt: input.updatedAt,
      ...(input.adapterOrderId === undefined
        ? current.adapterOrderId === undefined ? {} : { adapterOrderId: current.adapterOrderId }
        : { adapterOrderId: input.adapterOrderId }),
    });
    this.records.set(mapKey, record);
    return record;
  }

  preload(
    request: EntrySubmissionRequest,
    status: IdempotencyRecordStatus,
    updatedAt = 1_000,
    environment: "DRY_RUN" | "SANDBOX" | "LIVE" = "SANDBOX",
  ): IdempotencyRecord {
    return this.preloadRecord(
      request,
      "ENTRY_SUBMISSION",
      fingerprintEntrySubmission(request),
      status,
      updatedAt,
      undefined,
      environment,
    );
  }

  preloadRecord(
    request: { readonly executionAttemptId: string; readonly idempotencyKey: string },
    operation: IdempotencyOperation,
    requestFingerprint: RequestFingerprint,
    status: IdempotencyRecordStatus,
    updatedAt = 1_000,
    adapterOrderId?: string,
    environment: "DRY_RUN" | "SANDBOX" | "LIVE" = "SANDBOX",
  ): IdempotencyRecord {
    const record = createIdempotencyRecord({
      adapterId: "adapter-1",
      environment,
      idempotencyKey: request.idempotencyKey,
      executionAttemptId: request.executionAttemptId,
      operation,
      requestFingerprint,
      status,
      createdAt: 1_000,
      updatedAt,
      ...(adapterOrderId === undefined ? {} : { adapterOrderId }),
    });
    this.records.set(key("adapter-1", request.idempotencyKey), record);
    return record;
  }
}

function adapter(
  overrides: Partial<BrokerAdapter> = {},
  environment: "DRY_RUN" | "SANDBOX" | "LIVE" = "SANDBOX",
): BrokerAdapter {
  const descriptor = createBrokerAdapterDescriptor({
    adapterId: "adapter-1",
    environment,
    credentialProfileRef: "credential-ref-not-for-output",
    capabilities,
  });
  return {
    descriptor,
    capabilities,
    submitEntry: vi.fn(async (request: EntrySubmissionRequest) => createEntryAcknowledgement({
      executionAttemptId: request.executionAttemptId,
      idempotencyKey: request.idempotencyKey,
      adapterOrderId: "order-1",
      acknowledgedAt: 2_000,
    })),
    submitProtection: vi.fn(async (request: ProtectionRequest) => createProtectionAcknowledgement({
      executionAttemptId: request.executionAttemptId,
      protectionRequestId: request.protectionRequestId,
      idempotencyKey: request.idempotencyKey,
      protectedQuantity: request.protectedQuantity,
      acknowledgedAt: 2_000,
    })),
    cancelEntry: vi.fn(async (request: EntryCancellationRequest) => createCancellationAcknowledgement({
      executionAttemptId: request.executionAttemptId,
      cancellationRequestId: request.cancellationRequestId,
      idempotencyKey: request.idempotencyKey,
      adapterOrderId: request.adapterOrderId,
      acknowledgedAt: 2_000,
    })),
    ...overrides,
  };
}

function provider(observation: ReconciliationObservation): ReconciliationProvider {
  return { reconcile: vi.fn(async () => observation) };
}

describe("claim-first orchestration and durable replay", () => {
  it("claims and durably marks SUBMITTED before the adapter call, then confirms", async () => {
    const repository = new FakeRepository();
    const broker = adapter({
      submitEntry: vi.fn(async (request) => {
        repository.events.push("adapter");
        expect((await repository.read(brokerAdapterId("adapter-1"), request.idempotencyKey))?.status)
          .toBe("SUBMITTED");
        return createEntryAcknowledgement({
          executionAttemptId: request.executionAttemptId,
          idempotencyKey: request.idempotencyKey,
          adapterOrderId: "order-1",
          acknowledgedAt: 2_000,
        });
      }),
    });
    const result = await orchestrateEntrySubmission({
      adapter: broker,
      idempotencyRepository: repository,
      request: entry(),
      occurredAt: 2_000,
    });
    expect(result.status).toBe("CONFIRMED");
    expect(repository.events).toEqual([
      "claim",
      "record:SUBMITTED",
      "adapter",
      "record:CONFIRMED",
    ]);
    expect(result.record.adapterOrderId).toBe("order-1");
    expect(result.record.environment).toBe("SANDBOX");
    expect(repository.durableEnvironments).toEqual(["SANDBOX", "SANDBOX", "SANDBOX"]);
  });

  it("conflicts across environments without calling the adapter", async () => {
    const repository = new FakeRepository();
    repository.preload(entry(), "CONFIRMED", 1_000, "SANDBOX");
    const liveAdapter = adapter({}, "LIVE");
    const result = await orchestrateEntrySubmission({
      adapter: liveAdapter,
      idempotencyRepository: repository,
      request: entry(),
      occurredAt: 2_000,
    });
    expect(result.status).toBe("IDEMPOTENCY_CONFLICT");
    expect(result.record.environment).toBe("SANDBOX");
    expect(liveAdapter.submitEntry).not.toHaveBeenCalled();
  });

  it("preserves same-environment existing-request behavior", async () => {
    const repository = new FakeRepository();
    repository.preload(entry(), "CONFIRMED", 1_000, "SANDBOX");
    const sandboxAdapter = adapter({}, "SANDBOX");
    const result = await orchestrateEntrySubmission({
      adapter: sandboxAdapter,
      idempotencyRepository: repository,
      request: entry(),
      occurredAt: 2_000,
    });
    expect(result.status).toBe("CONFIRMED");
    expect(result.record.environment).toBe("SANDBOX");
    expect(sandboxAdapter.submitEntry).not.toHaveBeenCalled();
  });

  it("replays existing confirmed and rejected records without an adapter call", async () => {
    for (const status of ["CONFIRMED", "REJECTED"] as const) {
      const repository = new FakeRepository();
      repository.preload(entry(), status);
      const broker = adapter();
      const result = await orchestrateEntrySubmission({
        adapter: broker,
        idempotencyRepository: repository,
        request: entry(),
        occurredAt: 2_000,
      });
      expect(result.status).toBe(status);
      expect(broker.submitEntry).not.toHaveBeenCalled();
    }
  });

  it("blocks CLAIMED, SUBMITTED, and OUTCOME_UNKNOWN restart states", async () => {
    for (const status of ["CLAIMED", "SUBMITTED", "OUTCOME_UNKNOWN"] as const) {
      const repository = new FakeRepository();
      repository.preload(entry(), status);
      const broker = adapter();
      const result = await orchestrateEntrySubmission({
        adapter: broker,
        idempotencyRepository: repository,
        request: entry(),
        occurredAt: 2_000,
      });
      expect(result.status).toBe("RECONCILIATION_REQUIRED");
      expect(broker.submitEntry).not.toHaveBeenCalled();
    }
  });

  it("hard-stops a same-key changed request as an idempotency conflict", async () => {
    const repository = new FakeRepository();
    repository.preload(entry(), "CONFIRMED");
    const broker = adapter();
    const changed = entry({ quantity: positiveDecimalString("2") });
    const result = await orchestrateEntrySubmission({
      adapter: broker,
      idempotencyRepository: repository,
      request: changed,
      occurredAt: 2_000,
    });
    expect(result.status).toBe("IDEMPOTENCY_CONFLICT");
    expect(broker.submitEntry).not.toHaveBeenCalled();
  });

  it("persists a typed rejection as REJECTED", async () => {
    const repository = new FakeRepository();
    const broker = adapter({
      submitEntry: vi.fn(async (request) => createEntryRejection({
        executionAttemptId: request.executionAttemptId,
        idempotencyKey: request.idempotencyKey,
        adapterReasonCode: "VENUE_REJECTED",
        rejectedAt: 2_000,
      })),
    });
    const result = await orchestrateEntrySubmission({
      adapter: broker,
      idempotencyRepository: repository,
      request: entry(),
      occurredAt: 2_000,
    });
    expect(result.status).toBe("REJECTED");
    expect(result.record.status).toBe("REJECTED");
  });
});

describe("failure certainty and same-key retries", () => {
  it.each(["TIMEOUT", "NETWORK"] as const)(
    "persists %s unknown outcomes and never submits again after restart",
    async (category) => {
      const repository = new FakeRepository();
      const failure = createBrokerFailure({
        category,
        certainty: "OUTCOME_UNKNOWN",
        submissionExposure: "MAY_HAVE_BEEN_SUBMITTED",
      });
      const broker = adapter({ submitEntry: vi.fn(async () => { throw failure; }) });
      const first = await orchestrateEntrySubmission({
        adapter: broker,
        idempotencyRepository: repository,
        request: entry(),
        occurredAt: 2_000,
      });
      const second = await orchestrateEntrySubmission({
        adapter: broker,
        idempotencyRepository: repository,
        request: entry(),
        occurredAt: 3_000,
      });
      expect(first.status).toBe("RECONCILIATION_REQUIRED");
      expect(second.status).toBe("RECONCILIATION_REQUIRED");
      expect(broker.submitEntry).toHaveBeenCalledTimes(1);
      expect(second.record.status).toBe("OUTCOME_UNKNOWN");
    },
  );

  it("authorizes but does not perform a retry after definite pre-submission rate limiting", async () => {
    const repository = new FakeRepository();
    const failure = createBrokerFailure({
      category: "RATE_LIMIT",
      certainty: "DEFINITE_FAILURE",
      submissionExposure: "NOT_SUBMITTED",
    });
    const broker = adapter({ submitEntry: vi.fn(async () => { throw failure; }) });
    const result = await orchestrateEntrySubmission({
      adapter: broker,
      idempotencyRepository: repository,
      request: entry(),
      occurredAt: 2_000,
    });
    expect(result.status).toBe("RETRY_SAFE_SAME_KEY");
    expect(result.record.status).toBe("RETRY_AUTHORIZED");
    expect(broker.submitEntry).toHaveBeenCalledTimes(1);
    if (result.status === "RETRY_SAFE_SAME_KEY") {
      expect(result.authorization.idempotencyKey).toBe(entry().idempotencyKey);
      expect(result.authorization.requestFingerprint).toBe(fingerprintEntrySubmission(entry()));
    }
  });

  it("allows a subsequent explicit same-request retry and rejects mutation", async () => {
    const repository = new FakeRepository();
    repository.preload(entry(), "RETRY_AUTHORIZED");
    const broker = adapter();
    const changed = await orchestrateEntrySubmission({
      adapter: broker,
      idempotencyRepository: repository,
      request: entry({ quantity: positiveDecimalString("2") }),
      occurredAt: 2_000,
    });
    expect(changed.status).toBe("IDEMPOTENCY_CONFLICT");
    const same = await orchestrateEntrySubmission({
      adapter: broker,
      idempotencyRepository: repository,
      request: entry(),
      occurredAt: 2_000,
    });
    expect(same.status).toBe("CONFIRMED");
    expect(broker.submitEntry).toHaveBeenCalledTimes(1);
  });

  it("returns DO_NOT_RETRY for explicit permanent failures", async () => {
    const repository = new FakeRepository();
    const failure = createBrokerFailure({
      category: "AUTHENTICATION",
      certainty: "DEFINITE_FAILURE",
      submissionExposure: "NOT_SUBMITTED",
    });
    const broker = adapter({ submitEntry: vi.fn(async () => { throw failure; }) });
    const result = await orchestrateEntrySubmission({
      adapter: broker,
      idempotencyRepository: repository,
      request: entry(),
      occurredAt: 2_000,
    });
    expect(result.status).toBe("DO_NOT_RETRY");
    expect(result.record.status).toBe("FAILED_NOT_SUBMITTED");
  });
});

describe("operation routing and identity separation", () => {
  it("routes protection and cancellation to exactly their corresponding adapter methods", async () => {
    const repository = new FakeRepository();
    const broker = adapter();
    const protectionResult = await orchestrateProtectionSubmission({
      adapter: broker,
      idempotencyRepository: repository,
      request: protection(),
      occurredAt: 2_000,
    });
    const cancellationResult = await orchestrateEntryCancellation({
      adapter: broker,
      idempotencyRepository: repository,
      request: cancellation(),
      occurredAt: 2_000,
    });
    expect(protectionResult.status).toBe("CONFIRMED");
    expect(cancellationResult.status).toBe("CONFIRMED");
    expect(broker.submitProtection).toHaveBeenCalledTimes(1);
    expect(broker.cancelEntry).toHaveBeenCalledTimes(1);
    expect(broker.submitEntry).not.toHaveBeenCalled();
    expect(fingerprintProtectionRequest(protection())).not.toBe(fingerprintEntryCancellation(cancellation()));
  });

  it("persists protection and cancellation rejections", async () => {
    const repository = new FakeRepository();
    const broker = adapter({
      submitProtection: vi.fn(async (request) => createProtectionRejection({
        executionAttemptId: request.executionAttemptId,
        protectionRequestId: request.protectionRequestId,
        idempotencyKey: request.idempotencyKey,
        adapterReasonCode: "NO_PROTECTION",
        rejectedAt: 2_000,
      })),
      cancelEntry: vi.fn(async (request) => createCancellationRejection({
        executionAttemptId: request.executionAttemptId,
        cancellationRequestId: request.cancellationRequestId,
        idempotencyKey: request.idempotencyKey,
        adapterOrderId: request.adapterOrderId,
        adapterReasonCode: "NO_CANCEL",
        rejectedAt: 2_000,
      })),
    });
    expect((await orchestrateProtectionSubmission({
      adapter: broker,
      idempotencyRepository: repository,
      request: protection(),
      occurredAt: 2_000,
    })).status).toBe("REJECTED");
    expect((await orchestrateEntryCancellation({
      adapter: broker,
      idempotencyRepository: repository,
      request: cancellation(),
      occurredAt: 2_000,
    })).status).toBe("REJECTED");
  });
});

describe("reconciliation", () => {
  function setup(status: "SUBMITTED" | "OUTCOME_UNKNOWN" = "OUTCOME_UNKNOWN") {
    const repository = new FakeRepository();
    repository.preload(entry(), status, 2_000);
    const request = createReconciliationRequest({
      adapterId: "adapter-1",
      environment: "SANDBOX",
      executionAttemptId: entry().executionAttemptId,
      operation: "ENTRY_SUBMISSION",
      idempotencyKey: entry().idempotencyKey,
      requestFingerprint: fingerprintEntrySubmission(entry()),
    });
    return { repository, request };
  }

  it.each([
    ["CONFIRMED_ACCEPTED", "CONFIRMED"],
    ["CONFIRMED_REJECTED", "REJECTED"],
  ] as const)("persists %s as %s without submission", async (observationStatus, expected) => {
    const { repository, request } = setup();
    const broker = adapter();
    const result = await reconcileExecutionOutcome({
      provider: provider({ status: observationStatus, adapterOrderId: "order-1" }),
      idempotencyRepository: repository,
      request,
      occurredAt: 3_000,
    });
    expect(result.status).toBe(expected);
    expect(result.record.status).toBe(expected);
    expect(broker.submitEntry).not.toHaveBeenCalled();
  });

  it("keeps STILL_UNKNOWN blocked", async () => {
    const { repository, request } = setup();
    const result = await reconcileExecutionOutcome({
      provider: provider({ status: "STILL_UNKNOWN" }),
      idempotencyRepository: repository,
      request,
      occurredAt: 3_000,
    });
    expect(result.status).toBe("RECONCILIATION_REQUIRED");
    expect(result.record.status).toBe("OUTCOME_UNKNOWN");
  });

  it("rejects a reconciliation environment mismatch without calling the provider", async () => {
    const { repository, request } = setup();
    const liveRequest = createReconciliationRequest({ ...request, environment: "LIVE" });
    const reconciliationProvider = provider({ status: "CONFIRMED_ACCEPTED" });
    const result = await reconcileExecutionOutcome({
      provider: reconciliationProvider,
      idempotencyRepository: repository,
      request: liveRequest,
      occurredAt: 3_000,
    });
    expect(result.status).toBe("IDEMPOTENCY_CONFLICT");
    expect(reconciliationProvider.reconcile).not.toHaveBeenCalled();
  });

  it("CONFIRMED_NOT_SUBMITTED authorizes but does not automatically perform a same-key retry", async () => {
    const { repository, request } = setup();
    const reconciliationProvider = provider({ status: "CONFIRMED_NOT_SUBMITTED" });
    const result = await reconcileExecutionOutcome({
      provider: reconciliationProvider,
      idempotencyRepository: repository,
      request,
      occurredAt: 3_000,
    });
    expect(result.status).toBe("RETRY_SAFE_SAME_KEY");
    expect(result.record.status).toBe("RETRY_AUTHORIZED");
    if (result.status === "RETRY_SAFE_SAME_KEY") {
      expect(result.authorization.idempotencyKey).toBe(entry().idempotencyKey);
      expect(result.authorization.requestFingerprint).toBe(fingerprintEntrySubmission(entry()));
    }
    expect(reconciliationProvider.reconcile).toHaveBeenCalledTimes(1);
  });

  it("builds deterministic collision-safe request IDs and derives requests from requirements", async () => {
    const first = createReconciliationRequest({
      adapterId: "a|b",
      environment: "SANDBOX",
      executionAttemptId: "c",
      operation: "ENTRY_SUBMISSION",
      idempotencyKey: "key",
      requestFingerprint: "fingerprint" as RequestFingerprint,
    });
    const repeat = createReconciliationRequest({ ...first });
    const live = createReconciliationRequest({ ...first, environment: "LIVE" });
    const different = createReconciliationRequest({
      adapterId: "a",
      environment: "SANDBOX",
      executionAttemptId: "b|c",
      operation: "ENTRY_SUBMISSION",
      idempotencyKey: "key",
      requestFingerprint: "fingerprint" as RequestFingerprint,
    });
    expect(first.reconciliationRequestId).toBe(repeat.reconciliationRequestId);
    expect(first.reconciliationRequestId).not.toBe(live.reconciliationRequestId);
    expect(first.reconciliationRequestId).not.toBe(different.reconciliationRequestId);

    const repository = new FakeRepository();
    repository.preload(entry(), "OUTCOME_UNKNOWN");
    const blocked = await orchestrateEntrySubmission({
      adapter: adapter(),
      idempotencyRepository: repository,
      request: entry(),
      occurredAt: 2_000,
    });
    if (blocked.status !== "RECONCILIATION_REQUIRED") throw new Error("expected requirement");
    const derived = createReconciliationRequestFromRequirement(blocked.requirement);
    expect(derived.idempotencyKey).toBe(entry().idempotencyKey);
    expect(Object.isFrozen(derived)).toBe(true);
  });

  it("makes audit event IDs environment-specific", async () => {
    const sandboxEvents: Array<{ readonly eventId: string }> = [];
    const liveEvents: Array<{ readonly eventId: string }> = [];
    await orchestrateEntrySubmission({
      adapter: adapter({}, "SANDBOX"),
      idempotencyRepository: new FakeRepository(),
      request: entry(),
      occurredAt: 2_000,
      auditSink: { append: vi.fn(async (event) => { sandboxEvents.push(event); }) },
    });
    await orchestrateEntrySubmission({
      adapter: adapter({}, "LIVE"),
      idempotencyRepository: new FakeRepository(),
      request: entry(),
      occurredAt: 2_000,
      auditSink: { append: vi.fn(async (event) => { liveEvents.push(event); }) },
    });
    expect(sandboxEvents.map((event) => event.eventId))
      .not.toEqual(liveEvents.map((event) => event.eventId));
  });
});

describe("immutability, time, and audit isolation", () => {
  it("does not mutate requests or repository objects and deeply freezes public result objects", async () => {
    const request = entry();
    const before = JSON.stringify(request);
    const repository = new FakeRepository();
    const result = await orchestrateEntrySubmission({
      adapter: adapter(),
      idempotencyRepository: repository,
      request,
      occurredAt: 2_000,
    });
    expect(JSON.stringify(request)).toBe(before);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.record)).toBe(true);
    if (result.status === "CONFIRMED") expect(Object.isFrozen(result.acknowledgement)).toBe(true);
    expect(result.record.updatedAt).toBe(2_000);
  });

  it("propagates a backward durable update rejection before calling the adapter", async () => {
    const repository = new FakeRepository();
    repository.preload(entry(), "RETRY_AUTHORIZED", 3_000);
    const broker = adapter();
    await expect(orchestrateEntrySubmission({
      adapter: broker,
      idempotencyRepository: repository,
      request: entry(),
      occurredAt: 2_000,
    })).rejects.toThrow("updatedAt moved backwards");
    expect(broker.submitEntry).not.toHaveBeenCalled();
  });

  it("reports audit failure without changing execution truth or exposing credential references", async () => {
    const repository = new FakeRepository();
    const seen: unknown[] = [];
    const result = await orchestrateEntrySubmission({
      adapter: adapter(),
      idempotencyRepository: repository,
      request: entry(),
      occurredAt: 2_000,
      auditSink: { append: vi.fn(async (event) => { seen.push(event); throw new Error("audit down"); }) },
    });
    expect(result.status).toBe("CONFIRMED");
    expect(result.auditDelivery).toBe("FAILED");
    expect(JSON.stringify(seen)).not.toContain("credential-ref-not-for-output");
  });
});
