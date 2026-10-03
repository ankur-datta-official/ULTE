import { describe, expect, it } from "vitest";
import { unixMs } from "@ulte/instrument-model";
import {
  classifyIdempotencyOutcome,
  createIdempotencyRecord,
  type IdempotencyOutcomeInput,
  type IdempotencyRecordStatus,
} from "./index.js";

const statuses: readonly IdempotencyRecordStatus[] = [
  "CLAIMED", "SUBMITTED", "CONFIRMED", "REJECTED", "OUTCOME_UNKNOWN",
  "RETRY_AUTHORIZED", "FAILED_NOT_SUBMITTED",
];
const legal: Record<IdempotencyRecordStatus, readonly IdempotencyOutcomeInput["status"][]> = {
  CLAIMED: ["SUBMITTED", "CONFIRMED", "REJECTED", "OUTCOME_UNKNOWN", "RETRY_AUTHORIZED"],
  SUBMITTED: ["CONFIRMED", "REJECTED", "OUTCOME_UNKNOWN", "RETRY_AUTHORIZED", "FAILED_NOT_SUBMITTED"],
  CONFIRMED: [],
  REJECTED: [],
  OUTCOME_UNKNOWN: ["CONFIRMED", "REJECTED", "RETRY_AUTHORIZED"],
  RETRY_AUTHORIZED: ["SUBMITTED"],
  FAILED_NOT_SUBMITTED: [],
};

function record(status: IdempotencyRecordStatus, adapterOrderId?: string) {
  return createIdempotencyRecord({
    adapterId: "adapter-1", environment: "SANDBOX", idempotencyKey: "key-1",
    executionAttemptId: "attempt-1", operation: "ENTRY_SUBMISSION",
    requestFingerprint: "fingerprint-1" as never, status,
    createdAt: 100, updatedAt: 100,
    ...(adapterOrderId === undefined ? {} : { adapterOrderId }),
  });
}

describe("idempotency outcome authority", () => {
  it("classifies every cross-status edge from the frozen graph", () => {
    for (const from of statuses) {
      for (const to of statuses.filter((value) => value !== "CLAIMED" && value !== from)) {
        const result = classifyIdempotencyOutcome(record(from), { status: to as IdempotencyOutcomeInput["status"], updatedAt: unixMs(101) });
        expect(result.status, `${from} -> ${to}`).toBe(legal[from].includes(to as IdempotencyOutcomeInput["status"])
          ? "APPLIED_TRANSITION" : "STATUS_CONFLICT");
        expect(result.record.status).toBe(result.status === "APPLIED_TRANSITION" ? to : from);
      }
    }
  });

  it("classifies same-state duplicates, the one enrichment, and forbidden new facts", () => {
    for (const status of statuses.filter((value) => value !== "CLAIMED")) {
      const target = status as IdempotencyOutcomeInput["status"];
      const empty = record(status);
      const duplicate = classifyIdempotencyOutcome(empty, { status: target, updatedAt: unixMs(101) });
      expect(duplicate.status, status).toBe("DUPLICATE_SAME");
      expect(duplicate.record).toBe(empty);
      const firstId = classifyIdempotencyOutcome(empty, { status: target, updatedAt: unixMs(101), adapterOrderId: "ORDER-1" });
      expect(firstId.status, status).toBe(status === "OUTCOME_UNKNOWN" ? "APPLIED_ENRICHMENT" : "STATUS_CONFLICT");
      const existing = record(status, "ORDER-1");
      for (const requestedId of [undefined, "ORDER-1"]) {
        const repeat = classifyIdempotencyOutcome(existing, { status: target, updatedAt: unixMs(102),
          ...(requestedId === undefined ? {} : { adapterOrderId: requestedId }) });
        expect(repeat.status, status).toBe("DUPLICATE_SAME");
        expect(repeat.record).toBe(existing);
      }
      expect(() => classifyIdempotencyOutcome(existing, { status: target, updatedAt: unixMs(102),
        adapterOrderId: "ORDER-2" })).toThrow(expect.objectContaining({ code: "ADAPTER_ORDER_ID_CONFLICT" }));
    }
  });

  it("persists enrichment time and leaves repeated delivery time unchanged", () => {
    const first = classifyIdempotencyOutcome(record("OUTCOME_UNKNOWN"), {
      status: "OUTCOME_UNKNOWN", adapterOrderId: "ORDER-1", updatedAt: unixMs(101),
    });
    expect(first).toMatchObject({ status: "APPLIED_ENRICHMENT", record: {
      status: "OUTCOME_UNKNOWN", adapterOrderId: "ORDER-1", updatedAt: 101,
    } });
    const repeat = classifyIdempotencyOutcome(first.record, {
      status: "OUTCOME_UNKNOWN", adapterOrderId: "ORDER-1", updatedAt: unixMs(102),
    });
    expect(repeat).toMatchObject({ status: "DUPLICATE_SAME", record: { updatedAt: 101 } });
    expect(repeat.record).toBe(first.record);
  });

  it("keeps terminal rows immutable and resolves equal-time terminal races", () => {
    for (const [first, second] of [["CONFIRMED", "REJECTED"], ["REJECTED", "CONFIRMED"]] as const) {
      const durable = record(first);
      expect(classifyIdempotencyOutcome(durable, { status: second, updatedAt: unixMs(100) }))
        .toMatchObject({ status: "STATUS_CONFLICT", record: durable });
      expect(classifyIdempotencyOutcome(durable, { status: first, updatedAt: unixMs(101),
        adapterOrderId: "ORDER-1" })).toMatchObject({ status: "STATUS_CONFLICT", record: durable });
    }
  });

  it("requires the explicit retry gate and rejects backward time", () => {
    expect(classifyIdempotencyOutcome(record("OUTCOME_UNKNOWN"), {
      status: "SUBMITTED", updatedAt: unixMs(101),
    }).status).toBe("STATUS_CONFLICT");
    expect(classifyIdempotencyOutcome(record("OUTCOME_UNKNOWN"), {
      status: "RETRY_AUTHORIZED", updatedAt: unixMs(101),
    }).status).toBe("APPLIED_TRANSITION");
    expect(classifyIdempotencyOutcome(record("RETRY_AUTHORIZED"), {
      status: "SUBMITTED", updatedAt: unixMs(101),
    }).status).toBe("APPLIED_TRANSITION");
    expect(() => classifyIdempotencyOutcome(record("OUTCOME_UNKNOWN"), {
      status: "OUTCOME_UNKNOWN", updatedAt: unixMs(99), adapterOrderId: "ORDER-1",
    })).toThrow("updatedAt cannot move backwards");
  });
});
