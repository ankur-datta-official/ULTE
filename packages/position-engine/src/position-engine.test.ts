import { describe, expect, it } from "vitest";
import {
  acknowledgeEntrySubmission,
  applyEntryFill,
  createAdapterCapabilities,
  createExecutionAttempt,
  requestEntrySubmission,
  type ExecutionAttempt,
} from "@ulte/execution-engine";
import {
  currencyCode,
  createInstrumentId,
  nonNegativeDecimalString,
  positiveDecimalString,
  unixMs,
} from "@ulte/instrument-model";
import type { ReadyExecutionPlan } from "@ulte/execution-preparation-engine";
import {
  POSITION_EXPOSURE_SCHEMA_VERSION,
  PositionEngine,
  projectPositionExposure,
} from "./index.js";

const instrument = createInstrumentId({ venue: "TEST", venueSymbol: "ABC", instrumentKind: "CFD" });
const capabilities = createAdapterCapabilities({
  supportsClientIdempotency: false,
  supportsCloseOnlyExit: true,
  supportsNativeBracketProtection: false,
  supportsProtectionModification: true,
  supportsOrderCancellation: true,
  supportsPartialFillReporting: true,
});

function plan(overrides: Partial<ReadyExecutionPlan> = {}): ReadyExecutionPlan {
  const quantity = overrides.quantity ?? positiveDecimalString("10");
  const entrySide = overrides.entrySide ?? "BUY";
  const exitSide = overrides.exitSide ?? "SELL";
  return Object.freeze({
    status: "EXECUTION_PLAN_READY",
    schemaVersion: "EXECUTION_PLAN_V2",
    executionPlanId: "plan-1",
    tradeIntentId: "intent-1",
    candidateId: "candidate-1",
    instrumentId: instrument,
    intentAsOf: unixMs(800),
    marketSnapshotAsOf: unixMs(850),
    preparedAsOf: unixMs(900),
    direction: entrySide === "BUY" ? "UP" : "DOWN",
    entrySide,
    exitSide,
    quantity,
    quantityUnit: "contracts", accountCurrency: currencyCode("USD"),
    entryInstruction: Object.freeze({
      kind: "ENTRY_LIMIT", side: entrySide, price: positiveDecimalString("100"), quantity, positionEffect: "OPEN",
    }),
    protectiveStopInstruction: Object.freeze({
      kind: "PROTECTIVE_STOP_TRIGGER",
      side: exitSide,
      triggerPrice: positiveDecimalString(entrySide === "BUY" ? "90" : "110"),
      quantity,
      positionEffect: "CLOSE",
    }),
    profitTargetInstruction: Object.freeze({
      kind: "PROFIT_TARGET_LIMIT",
      side: exitSide,
      price: positiveDecimalString(entrySide === "BUY" ? "130" : "70"),
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
    ...overrides,
  });
}

function fresh(overrides: Partial<ReadyExecutionPlan> = {}): ExecutionAttempt {
  const result = createExecutionAttempt(plan(overrides));
  if (result.status !== "EXECUTION_ATTEMPT_READY") throw new Error("execution attempt creation failed");
  return result;
}

function working(overrides: Partial<ReadyExecutionPlan> = {}): ExecutionAttempt {
  const submitted = requestEntrySubmission(fresh(overrides), capabilities);
  if (submitted.status !== "ENTRY_SUBMISSION_READY") throw new Error("entry submission request failed");
  const acknowledged = acknowledgeEntrySubmission(submitted.attempt, {
    executionAttemptId: submitted.attempt.executionAttemptId,
    idempotencyKey: submitted.request.idempotencyKey,
    adapterOrderId: "ORDER-1",
    acknowledgedAt: 1_000,
  });
  if (acknowledged.status !== "EXECUTION_ATTEMPT_UPDATED") throw new Error("entry acknowledgement failed");
  return acknowledged.attempt;
}

function filled(quantity: string, requested = "10"): ExecutionAttempt {
  const attempt = working({ quantity: positiveDecimalString(requested) });
  const result = applyEntryFill(attempt, {
    executionAttemptId: attempt.executionAttemptId,
    adapterOrderId: "ORDER-1",
    fillId: "F1",
    filledQuantity: quantity,
    fillPrice: "100",
    filledAt: 1_001,
  });
  if (result.status !== "EXECUTION_ATTEMPT_UPDATED") throw new Error("entry fill failed");
  return result.attempt;
}

function forge(base: ExecutionAttempt, overrides: Partial<ExecutionAttempt>): ExecutionAttempt {
  return Object.freeze({ ...base, ...overrides });
}

function projected(attempt: ExecutionAttempt) {
  const result = projectPositionExposure(attempt);
  expect(result.status).toBe("POSITION_EXPOSURE_PROJECTED");
  if (result.status !== "POSITION_EXPOSURE_PROJECTED") throw new Error(result.reason);
  return result.positionExposure;
}

describe("position exposure projection", () => {
  it("projects the minimal immutable V1 schema without mutating the source", () => {
    const attempt = fresh();
    const before = JSON.stringify(attempt);
    const result = projectPositionExposure(attempt);
    expect(result.status).toBe("POSITION_EXPOSURE_PROJECTED");
    if (result.status !== "POSITION_EXPOSURE_PROJECTED") return;
    expect(result.positionExposure).toMatchObject({
      schemaVersion: POSITION_EXPOSURE_SCHEMA_VERSION,
      executionAttemptId: attempt.executionAttemptId,
      requestedQuantity: "10",
      filledEntryQuantity: "0",
      exitedQuantity: "0",
      openQuantity: "0",
      exposureState: "NO_EXPOSURE",
      executionAsOf: 900,
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.positionExposure)).toBe(true);
    expect(JSON.stringify(attempt)).toBe(before);
  });

  it("maps BUY to LONG and SELL to SHORT only from authoritative entry side", () => {
    expect(projected(fresh()).direction).toBe("LONG");
    expect(projected(fresh({ entrySide: "SELL", exitSide: "BUY" })).direction).toBe("SHORT");
  });

  it("rejects a same-side entry and exit", () => {
    expect(projectPositionExposure(forge(fresh(), { exitSide: "BUY" }))).toEqual({
      status: "POSITION_EXPOSURE_REJECTED",
      reason: "EXECUTION_SIDE_MISMATCH",
    });
  });

  it("keeps fresh and working zero-fill attempts as NO_EXPOSURE", () => {
    expect(projected(fresh()).exposureState).toBe("NO_EXPOSURE");
    const exposure = projected(working());
    expect(exposure).toMatchObject({ exposureState: "NO_EXPOSURE", entryCanIncreaseExposure: true, executionAsOf: 1_000 });
  });

  it("projects partial and full entries with no exits as OPEN", () => {
    expect(projected(filled("2.75"))).toMatchObject({ openQuantity: "2.75", exposureState: "OPEN" });
    expect(projected(filled("10"))).toMatchObject({ openQuantity: "10", exposureState: "OPEN" });
  });

  it("subtracts exact decimals and represents partial exits", () => {
    const attempt = forge(filled("10"), {
      protectedQuantity: nonNegativeDecimalString("10"),
      unprotectedFilledQuantity: nonNegativeDecimalString("0"),
      exitedQuantity: nonNegativeDecimalString("5.75"),
      state: "EXIT_PARTIALLY_FILLED",
      lastExecutionEventAt: unixMs(1_002),
    });
    expect(projected(attempt)).toMatchObject({ openQuantity: "4.25", exposureState: "PARTIALLY_EXITED" });
  });

  it("has no binary floating-point drift", () => {
    const attempt = forge(filled("0.3", "0.3"), {
      protectedQuantity: nonNegativeDecimalString("0.3"),
      unprotectedFilledQuantity: nonNegativeDecimalString("0"),
      exitedQuantity: nonNegativeDecimalString("0.2"),
      state: "EXIT_PARTIALLY_FILLED",
    });
    expect(projected(attempt).openQuantity).toBe("0.1");
  });

  it("keeps a fully exited current fill non-terminal while the entry is WORKING", () => {
    const attempt = forge(working(), {
      filledEntryQuantity: nonNegativeDecimalString("2.75"),
      protectedQuantity: nonNegativeDecimalString("2.75"),
      exitedQuantity: nonNegativeDecimalString("2.75"),
      unprotectedFilledQuantity: nonNegativeDecimalString("0"),
      state: "EXIT_PARTIALLY_FILLED",
      lastExecutionEventAt: unixMs(1_003),
    });
    expect(projected(attempt)).toMatchObject({
      openQuantity: "0",
      entryCanIncreaseExposure: true,
      exposureState: "FLAT_ENTRY_ACTIVE",
    });
  });

  it("reopens as PARTIALLY_EXITED when a later entry fill exceeds the earlier exit", () => {
    const attempt = forge(working(), {
      filledEntryQuantity: nonNegativeDecimalString("4"),
      protectedQuantity: nonNegativeDecimalString("2.75"),
      exitedQuantity: nonNegativeDecimalString("2.75"),
      unprotectedFilledQuantity: nonNegativeDecimalString("1.25"),
      state: "EXIT_PARTIALLY_FILLED",
      lastExecutionEventAt: unixMs(1_004),
    });
    expect(projected(attempt)).toMatchObject({ openQuantity: "1.25", exposureState: "PARTIALLY_EXITED" });
  });

  it.each(["FILLED", "CANCELED"] as const)("closes a fully exited %s entry only with terminal execution", (status) => {
    const attempt = forge(filled("10"), {
      entryOrderStatus: status,
      protectedQuantity: nonNegativeDecimalString("10"),
      unprotectedFilledQuantity: nonNegativeDecimalString("0"),
      exitedQuantity: nonNegativeDecimalString("10"),
      state: "EXIT_FILLED",
    });
    expect(projected(attempt)).toMatchObject({
      openQuantity: "0", exposureState: "CLOSED", entryCanIncreaseExposure: false,
    });
  });

  it("does not infer CLOSED from zero open quantity alone or from no historical entry exposure", () => {
    const incoherent = forge(filled("10"), {
      entryOrderStatus: "CANCELED",
      protectedQuantity: nonNegativeDecimalString("10"),
      unprotectedFilledQuantity: nonNegativeDecimalString("0"),
      exitedQuantity: nonNegativeDecimalString("10"),
      state: "EXIT_PARTIALLY_FILLED",
    });
    expect(projectPositionExposure(incoherent)).toMatchObject({
      status: "POSITION_EXPOSURE_REJECTED", reason: "INCOHERENT_TERMINAL_EXECUTION_STATE",
    });
    expect(projected(forge(fresh(), { entryOrderStatus: "CANCELED", state: "CANCELED" })).exposureState)
      .toBe("NO_EXPOSURE");
  });

  it("rejects an EXIT_FILLED execution claim that still has open or entry-active exposure", () => {
    const open = forge(filled("4"), { state: "EXIT_FILLED" });
    const entryActive = forge(working(), {
      filledEntryQuantity: nonNegativeDecimalString("2.75"),
      protectedQuantity: nonNegativeDecimalString("2.75"),
      exitedQuantity: nonNegativeDecimalString("2.75"),
      unprotectedFilledQuantity: nonNegativeDecimalString("0"),
      state: "EXIT_FILLED",
    });
    expect(projectPositionExposure(open)).toMatchObject({
      status: "POSITION_EXPOSURE_REJECTED", reason: "INCOHERENT_TERMINAL_EXECUTION_STATE",
    });
    expect(projectPositionExposure(entryActive)).toMatchObject({
      status: "POSITION_EXPOSURE_REJECTED", reason: "INCOHERENT_TERMINAL_EXECUTION_STATE",
    });
  });

  it("represents canceled partial-entry exposure as OPEN or PARTIALLY_EXITED", () => {
    const canceled = forge(working(), {
      entryOrderStatus: "CANCELED",
      filledEntryQuantity: nonNegativeDecimalString("4"),
      unprotectedFilledQuantity: nonNegativeDecimalString("4"),
      state: "ENTRY_CANCELED_WITH_EXPOSURE",
    });
    expect(projected(canceled)).toMatchObject({ openQuantity: "4", exposureState: "OPEN" });
    const partiallyExited = forge(canceled, {
      protectedQuantity: nonNegativeDecimalString("4"),
      unprotectedFilledQuantity: nonNegativeDecimalString("0"),
      exitedQuantity: nonNegativeDecimalString("1"),
      state: "EXIT_PARTIALLY_FILLED",
    });
    expect(projected(partiallyExited)).toMatchObject({ openQuantity: "3", exposureState: "PARTIALLY_EXITED" });
  });

  it.each([
    ["entry over requested", { filledEntryQuantity: "11", unprotectedFilledQuantity: "11" }, "ENTRY_QUANTITY_EXCEEDS_REQUESTED"],
    ["exit over entry", { filledEntryQuantity: "2", protectedQuantity: "2", exitedQuantity: "3", unprotectedFilledQuantity: "0" }, "EXIT_QUANTITY_EXCEEDS_ENTRY"],
    ["protection over entry", { filledEntryQuantity: "2", protectedQuantity: "3", unprotectedFilledQuantity: "0" }, "PROTECTED_QUANTITY_EXCEEDS_ENTRY"],
    ["incoherent unprotected", { filledEntryQuantity: "2", protectedQuantity: "1", unprotectedFilledQuantity: "2" }, "UNPROTECTED_QUANTITY_INCOHERENT"],
  ] as const)("rejects %s without correction", (_name, raw, reason) => {
    const attempt = forge(fresh(), {
      filledEntryQuantity: nonNegativeDecimalString(raw.filledEntryQuantity),
      protectedQuantity: nonNegativeDecimalString(raw.protectedQuantity ?? "0"),
      exitedQuantity: nonNegativeDecimalString(raw.exitedQuantity ?? "0"),
      unprotectedFilledQuantity: nonNegativeDecimalString(raw.unprotectedFilledQuantity),
    });
    expect(projectPositionExposure(attempt)).toEqual({ status: "POSITION_EXPOSURE_REJECTED", reason });
  });

  it("rejects unsupported or malformed execution attempts with frozen public results", () => {
    const unsupported = projectPositionExposure(forge(fresh(), {
      schemaVersion: "EXECUTION_ATTEMPT_V1" as ExecutionAttempt["schemaVersion"],
    }));
    const malformed = projectPositionExposure(forge(fresh(), {
      filledEntryQuantity: "NaN" as ExecutionAttempt["filledEntryQuantity"],
    }));
    expect(unsupported).toEqual({ status: "POSITION_EXPOSURE_REJECTED", reason: "EXECUTION_SCHEMA_UNSUPPORTED" });
    expect(malformed).toEqual({ status: "POSITION_EXPOSURE_REJECTED", reason: "INVALID_EXECUTION_ATTEMPT" });
    expect(Object.isFrozen(unsupported)).toBe(true);
    expect(Object.isFrozen(malformed)).toBe(true);
  });

  it("uses lastExecutionEventAt, falls back to preparedAsOf, and is deterministic across engine instances", () => {
    const attempt = working();
    expect(projected(fresh()).executionAsOf).toBe(900);
    expect(projected(attempt).executionAsOf).toBe(1_000);
    expect(projectPositionExposure(attempt)).toEqual(projectPositionExposure(attempt));
    expect(new PositionEngine().project(attempt)).toEqual(new PositionEngine().project(attempt));
  });

  it("omits historical protection and all accounting, valuation, and margin fields", () => {
    const attempt = forge(filled("4"), {
      protectedQuantity: nonNegativeDecimalString("4"),
      unprotectedFilledQuantity: nonNegativeDecimalString("0"),
      exitedQuantity: nonNegativeDecimalString("1"),
      state: "EXIT_PARTIALLY_FILLED",
    });
    const before = attempt.protectedQuantity;
    const exposure = projected(attempt) as unknown as Record<string, unknown>;
    for (const field of [
      "protectedQuantity", "currentProtectedOpenQuantity", "realizedPnL", "unrealizedPnL", "fee", "commission",
      "marketPrice", "margin", "leverage",
    ]) expect(exposure).not.toHaveProperty(field);
    expect(attempt.protectedQuantity).toBe(before);
  });
});
