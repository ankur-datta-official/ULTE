import { describe, expect, it } from "vitest";
import {
  createAdapterCapabilities,
  type BrokerAdapter as ExecutionEngineAdapter,
  type EntryCancellationRequest,
  type EntrySubmissionRequest,
  type ProtectionRequest,
} from "@ulte/execution-engine";
import {
  createInstrumentId,
  positiveDecimalString,
  unixMs,
} from "@ulte/instrument-model";
import {
  assertBrokerAdapterConformance,
  brokerAdapterId,
  classifyRetryDisposition,
  compareIdempotencyClaim,
  createBrokerAdapterDescriptor,
  createBrokerAdapterRegistry,
  createBrokerAuditEvent,
  createBrokerFailure,
  createIdempotencyRecord,
  fingerprintEntryCancellation,
  fingerprintEntrySubmission,
  fingerprintProtectionRequest,
  type BrokerAdapter,
  type BrokerFailureCategory,
  type BrokerAdapterDescriptor,
  type RequestFingerprint,
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

function descriptor(
  adapterId = "adapter-one",
  credentialProfileRef = "sandbox-account",
): BrokerAdapterDescriptor {
  return createBrokerAdapterDescriptor({
    adapterId,
    environment: "SANDBOX",
    credentialProfileRef,
    capabilities,
  });
}

function adapter(adapterDescriptor: BrokerAdapterDescriptor): BrokerAdapter {
  const implementation: BrokerAdapter = {
    descriptor: adapterDescriptor,
    capabilities: adapterDescriptor.capabilities,
    submitEntry: async () => { throw new Error("not implemented"); },
    submitProtection: async () => { throw new Error("not implemented"); },
    cancelEntry: async () => { throw new Error("not implemented"); },
  };
  return implementation;
}

function entry(overrides: Partial<EntrySubmissionRequest> = {}): EntrySubmissionRequest {
  return Object.freeze({
    kind: "ENTRY",
    executionAttemptId: "attempt-1",
    idempotencyKey: "entry-key-1",
    instrumentId,
    side: "BUY",
    quantity: positiveDecimalString("1.0"),
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
    protectedQuantity: positiveDecimalString("1.0"),
    targetCumulativeProtectedQuantity: positiveDecimalString("1.0"),
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

function failure(category: BrokerFailureCategory, certainty: "DEFINITE_FAILURE" | "OUTCOME_UNKNOWN" = "DEFINITE_FAILURE") {
  return createBrokerFailure({
    category,
    certainty,
    submissionExposure: certainty === "OUTCOME_UNKNOWN" ? "MAY_HAVE_BEEN_SUBMITTED" : "NOT_SUBMITTED",
  });
}

describe("adapter identity and descriptor", () => {
  it("creates a frozen descriptor with explicit environment and frozen capabilities", () => {
    const result = descriptor();
    expect(result).toMatchObject({ adapterId: "adapter-one", environment: "SANDBOX" });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.capabilities)).toBe(true);
  });

  it.each(["", " adapter", "adapter "])("rejects invalid adapter ID %j", (adapterId) => {
    expect(() => descriptor(adapterId)).toThrow();
  });

  it.each(["", " profile", "profile "])("rejects invalid credential reference %j", (credentialProfileRef) => {
    expect(() => descriptor("adapter-one", credentialProfileRef)).toThrow();
  });

  it("copies only descriptor contract fields and excludes extraneous credential material", () => {
    const result = createBrokerAdapterDescriptor({
      adapterId: "adapter-one",
      environment: "DRY_RUN",
      credentialProfileRef: "profile-one",
      capabilities,
      unexpectedCredential: "must-not-copy",
    } as Parameters<typeof createBrokerAdapterDescriptor>[0] & { unexpectedCredential: string });
    expect(Object.keys(result)).toEqual(["adapterId", "environment", "credentialProfileRef", "capabilities"]);
    expect(JSON.stringify(result)).not.toContain("must-not-copy");
  });

  it("does not infer an environment", () => {
    expect(() => createBrokerAdapterDescriptor({
      adapterId: "adapter-one",
      credentialProfileRef: "profile-one",
      capabilities,
    } as Parameters<typeof createBrokerAdapterDescriptor>[0])).toThrow("explicit");
  });
});

describe("adapter registry", () => {
  it("preserves registration order and exact adapter instances", () => {
    const first = adapter(descriptor("first"));
    const second = adapter(descriptor("second"));
    const registry = createBrokerAdapterRegistry([second, first]);
    expect(registry.adapterIds).toEqual(["second", "first"]);
    expect(registry.get("first")).toBe(first);
    expect(registry.get("second")).toBe(second);
  });

  it("rejects duplicate IDs instead of replacing either adapter", () => {
    expect(() => createBrokerAdapterRegistry([
      adapter(descriptor("duplicate")),
      adapter(descriptor("duplicate", "another-profile")),
    ])).toThrow("Duplicate");
  });

  it("returns undefined for an unknown ID with no fallback", () => {
    expect(createBrokerAdapterRegistry([adapter(descriptor())]).get("unknown")).toBeUndefined();
  });

  it("exposes frozen registry state that cannot mutate internal lookup", () => {
    const registered = adapter(descriptor());
    const registry = createBrokerAdapterRegistry([registered]);
    expect(Object.isFrozen(registry)).toBe(true);
    expect(Object.isFrozen(registry.adapterIds)).toBe(true);
    expect(() => (registry.adapterIds as string[]).push("injected")).toThrow();
    expect(registry.get("adapter-one")).toBe(registered);
  });

  it("rejects a capability handshake mismatch", () => {
    const adapterDescriptor = descriptor();
    const mismatched: BrokerAdapter = {
      ...adapter(adapterDescriptor),
      capabilities: createAdapterCapabilities({
        ...adapterDescriptor.capabilities,
        supportsOrderCancellation: false,
      }),
    };
    expect(() => assertBrokerAdapterConformance(mismatched)).toThrow("do not match");
    expect(() => createBrokerAdapterRegistry([mismatched])).toThrow("do not match");
  });

  it("rejects a mutable or extended descriptor at the registry boundary", () => {
    const mutableDescriptor = {
      ...descriptor(),
      capabilities,
      unexpectedCredential: "must-not-enter-descriptor",
    } as BrokerAdapterDescriptor;
    expect(() => createBrokerAdapterRegistry([adapter(mutableDescriptor)])).toThrow();
  });
});

describe("request fingerprints", () => {
  it("is deterministic for identical and deeply equivalent entry requests", () => {
    const request = entry();
    expect(fingerprintEntrySubmission(request)).toBe(fingerprintEntrySubmission(request));
    expect(fingerprintEntrySubmission(entry())).toBe(fingerprintEntrySubmission(entry()));
  });

  it("changes for every tested material entry field", () => {
    const original = fingerprintEntrySubmission(entry());
    expect(fingerprintEntrySubmission(entry({ quantity: positiveDecimalString("2.0") }))).not.toBe(original);
    expect(fingerprintEntrySubmission(entry({ limitPrice: positiveDecimalString("101") }))).not.toBe(original);
    expect(fingerprintEntrySubmission(entry({ side: "SELL" }))).not.toBe(original);
  });

  it("is deterministic for protection and changes with quantities or prices", () => {
    const original = fingerprintProtectionRequest(protection());
    expect(fingerprintProtectionRequest(protection())).toBe(original);
    expect(fingerprintProtectionRequest(protection({ protectedQuantity: positiveDecimalString("0.5") }))).not.toBe(original);
    expect(fingerprintProtectionRequest(protection({ targetCumulativeProtectedQuantity: positiveDecimalString("1.5") }))).not.toBe(original);
    expect(fingerprintProtectionRequest(protection({ stopTriggerPrice: positiveDecimalString("91") }))).not.toBe(original);
    expect(fingerprintProtectionRequest(protection({ targetPrice: positiveDecimalString("131") }))).not.toBe(original);
  });

  it("is deterministic for cancellation and changes with each material identity", () => {
    const original = fingerprintEntryCancellation(cancellation());
    expect(fingerprintEntryCancellation(cancellation())).toBe(original);
    expect(fingerprintEntryCancellation(cancellation({ cancellationRequestId: "cancel-2" }))).not.toBe(original);
    expect(fingerprintEntryCancellation(cancellation({ adapterOrderId: "order-2" }))).not.toBe(original);
  });

  it("uses length prefixes so delimiter-like values remain unambiguous", () => {
    const first = entry({ executionAttemptId: "a:1", idempotencyKey: "b" });
    const second = entry({ executionAttemptId: "a", idempotencyKey: "1:b" });
    expect(fingerprintEntrySubmission(first)).not.toBe(fingerprintEntrySubmission(second));
  });

  it("does not mutate caller requests", () => {
    const request = protection();
    const before = JSON.stringify(request);
    fingerprintProtectionRequest(request);
    expect(JSON.stringify(request)).toBe(before);
  });
});

describe("durable idempotency model", () => {
  const adapterId = brokerAdapterId("adapter-one");
  const requestFingerprint = fingerprintEntrySubmission(entry());
  const existing = createIdempotencyRecord({
    idempotencyKey: "entry-key-1",
    adapterId,
    executionAttemptId: "attempt-1",
    operation: "ENTRY_SUBMISSION",
    requestFingerprint,
    status: "CLAIMED",
    createdAt: 1_000,
    updatedAt: 1_000,
  });

  it("creates a frozen caller-timed record", () => {
    expect(existing.createdAt).toBe(unixMs(1_000));
    expect(Object.isFrozen(existing)).toBe(true);
  });

  it("classifies absent and identical claims deterministically", () => {
    const claim = { adapterId, idempotencyKey: "entry-key-1", requestFingerprint };
    expect(compareIdempotencyClaim(undefined, claim)).toEqual({ status: "CLAIMED_NEW" });
    expect(compareIdempotencyClaim(existing, claim)).toEqual({ status: "EXISTING_SAME_REQUEST" });
  });

  it("classifies same-key, different-quantity entry as a conflict", () => {
    const changed = fingerprintEntrySubmission(entry({ quantity: positiveDecimalString("2.0") }));
    expect(changed).not.toBe(requestFingerprint);
    expect(compareIdempotencyClaim(existing, {
      adapterId,
      idempotencyKey: "entry-key-1",
      requestFingerprint: changed,
    })).toEqual({ status: "CONFLICT", reason: "IDEMPOTENCY_CONFLICT" });
  });
});

describe("normalized failures and retry classification", () => {
  it("preserves an opaque adapter reason and freezes the result", () => {
    const result = createBrokerFailure({
      category: "ORDER_REJECTED",
      certainty: "DEFINITE_FAILURE",
      submissionExposure: "NOT_SUBMITTED",
      adapterReasonCode: "opaque-42",
      sanitizedMessage: "Order was rejected",
    });
    expect(result.adapterReasonCode).toBe("opaque-42");
    expect(Object.isFrozen(result)).toBe(true);
  });

  it.each<BrokerFailureCategory>([
    "AUTHENTICATION",
    "AUTHORIZATION",
    "INVALID_REQUEST",
    "INSUFFICIENT_FUNDS",
    "ORDER_REJECTED",
    "IDEMPOTENCY_CONFLICT",
  ])("classifies %s as DO_NOT_RETRY", (category) => {
    expect(classifyRetryDisposition(failure(category))).toBe("DO_NOT_RETRY");
  });

  it.each<BrokerFailureCategory>(["RATE_LIMIT", "NETWORK"])(
    "classifies definite pre-submission %s failure as RETRY_SAFE",
    (category) => expect(classifyRetryDisposition(failure(category))).toBe("RETRY_SAFE"),
  );

  it.each<BrokerFailureCategory>(["TIMEOUT", "NETWORK"])(
    "requires reconciliation for %s with unknown outcome",
    (category) => expect(classifyRetryDisposition(failure(category, "OUTCOME_UNKNOWN"))).toBe("REQUIRES_RECONCILIATION"),
  );

  it("never treats possible submission as blindly retryable", () => {
    const result = createBrokerFailure({
      category: "RATE_LIMIT",
      certainty: "DEFINITE_FAILURE",
      submissionExposure: "MAY_HAVE_BEEN_SUBMITTED",
    });
    expect(classifyRetryDisposition(result)).toBe("REQUIRES_RECONCILIATION");
  });
});

describe("sanitized audit and credential boundary", () => {
  it("creates a frozen event containing only the defined non-secret fields", () => {
    const event = createBrokerAuditEvent({
      eventId: "event-1",
      occurredAt: 2_000,
      adapterId: "adapter-one",
      environment: "LIVE",
      executionAttemptId: "attempt-1",
      operation: "ENTRY_SUBMISSION",
      idempotencyKey: "entry-key-1",
      outcome: "REJECTED",
      normalizedFailureCategory: "ORDER_REJECTED",
    });
    expect(event).toEqual({
      eventId: "event-1",
      occurredAt: 2_000,
      adapterId: "adapter-one",
      environment: "LIVE",
      executionAttemptId: "attempt-1",
      operation: "ENTRY_SUBMISSION",
      idempotencyKey: "entry-key-1",
      outcome: "REJECTED",
      normalizedFailureCategory: "ORDER_REJECTED",
    });
    expect(Object.isFrozen(event)).toBe(true);
  });

  it("never propagates the credential profile reference into fingerprints, failures, or audit events", () => {
    const credentialReference = "prod-secret-profile";
    const adapterDescriptor = descriptor("adapter-one", credentialReference);
    const fingerprint = fingerprintEntrySubmission(entry());
    const normalizedFailure = failure("TIMEOUT", "OUTCOME_UNKNOWN");
    const event = createBrokerAuditEvent({
      eventId: "event-1",
      occurredAt: 2_000,
      adapterId: adapterDescriptor.adapterId,
      environment: adapterDescriptor.environment,
      executionAttemptId: "attempt-1",
      operation: "ENTRY_SUBMISSION",
      idempotencyKey: "entry-key-1",
      outcome: "OUTCOME_UNKNOWN",
      normalizedFailureCategory: normalizedFailure.category,
    });
    expect(fingerprint).not.toContain(credentialReference);
    expect(JSON.stringify(normalizedFailure)).not.toContain(credentialReference);
    expect(JSON.stringify(event)).not.toContain(credentialReference);
  });
});

describe("execution-engine compatibility", () => {
  it("a broker adapter is assignable to the execution-engine adapter contract", () => {
    const broker = adapter(descriptor());
    const executionAdapter: ExecutionEngineAdapter = broker;
    expect(executionAdapter.capabilities).toBe(broker.capabilities);
  });

  it("fingerprint results are opaque strings at runtime", () => {
    const result: RequestFingerprint = fingerprintEntrySubmission(entry());
    expect(typeof result).toBe("string");
  });
});
