import { describe, expect, it } from "vitest";
import { subtractNonNegative } from "@ulte/exact-decimal";
import {
  createExitFillEvent,
  createFillEvent,
  type ExecutionAttempt,
  type ExitFillEvent,
  type FillEvent,
} from "@ulte/execution-engine";
import {
  createInstrumentId,
  nonNegativeDecimalString,
  positiveDecimalString,
  unixMs,
} from "@ulte/instrument-model";
import { createLinearInstrumentSizingSpec } from "@ulte/position-sizing-engine";
import {
  TRADE_COST_EVENT_SCHEMA_VERSION,
  TradeCostAccountingEngine,
  createTradeCostEvent,
  projectTradeCostAccounting,
  type TradeCostEvent,
  type TradeCostEventInput,
  type TradeCostType,
} from "./index.js";

const instrument = createInstrumentId({ venue: "TEST", venueSymbol: "ABC", instrumentKind: "CFD" });
const otherInstrument = createInstrumentId({ venue: "TEST", venueSymbol: "XYZ", instrumentKind: "CFD" });

interface AttemptOptions {
  readonly entrySide?: "BUY" | "SELL";
  readonly entryQuantity?: string;
  readonly exitQuantity?: string;
  readonly entryAt?: number;
  readonly exitAt?: number;
  readonly terminal?: boolean;
}

function attempt(options: AttemptOptions = {}): ExecutionAttempt {
  const entrySide = options.entrySide ?? "BUY";
  const exitSide = entrySide === "BUY" ? "SELL" : "BUY";
  const entryQuantity = options.entryQuantity ?? "0";
  const exitQuantity = options.exitQuantity ?? "0";
  const entries: readonly FillEvent[] = entryQuantity === "0" ? Object.freeze([]) : Object.freeze([
    createFillEvent({
      executionAttemptId: "attempt-cost-1",
      adapterOrderId: "ORDER-COST-1",
      fillId: "F1",
      filledQuantity: entryQuantity,
      fillPrice: "100",
      filledAt: options.entryAt ?? 1_001,
    }),
  ]);
  const exits: readonly ExitFillEvent[] = exitQuantity === "0" ? Object.freeze([]) : Object.freeze([
    createExitFillEvent({
      executionAttemptId: "attempt-cost-1",
      protectionRequestId: "PROTECT-COST-1",
      exitSide,
      exitLeg: "PROFIT_TARGET",
      fillId: "X1",
      filledQuantity: exitQuantity,
      fillPrice: entrySide === "BUY" ? "105" : "95",
      filledAt: options.exitAt ?? 1_007,
    }),
  ]);
  const filled = nonNegativeDecimalString(entryQuantity);
  const exited = nonNegativeDecimalString(exitQuantity);
  const open = subtractNonNegative(filled, exited);
  const terminal = options.terminal === true;
  const latest = options.exitAt ?? options.entryAt ?? 900;
  return Object.freeze({
    status: "EXECUTION_ATTEMPT_READY",
    schemaVersion: "EXECUTION_ATTEMPT_V2",
    executionAttemptId: "attempt-cost-1",
    executionPlanId: "plan-cost-1",
    tradeIntentId: "intent-cost-1",
    candidateId: "candidate-cost-1",
    instrumentId: instrument,
    preparedAsOf: unixMs(900),
    entrySide,
    exitSide,
    quantity: positiveDecimalString(entryQuantity === "0" ? "10" : entryQuantity),
    quantityUnit: "contracts",
    entryPrice: positiveDecimalString("100"),
    stopTriggerPrice: positiveDecimalString(entrySide === "BUY" ? "90" : "110"),
    targetPrice: positiveDecimalString(entrySide === "BUY" ? "130" : "70"),
    approvedRiskAmount: positiveDecimalString("100"),
    actualRiskAmount: positiveDecimalString("100"),
    netRewardRiskBps: "30000",
    state: terminal ? "EXIT_FILLED" : entryQuantity === "0" ? "ENTRY_WORKING" : exitQuantity === "0" ? "ENTRY_FILLED" : "EXIT_PARTIALLY_FILLED",
    entryOrderStatus: terminal || entryQuantity !== "0" ? "FILLED" : "WORKING",
    submissionIdempotencyKey: "entry-key",
    protectionMode: "MANAGED_PROTECTION",
    adapterOrderId: "ORDER-COST-1",
    filledEntryQuantity: filled,
    protectedQuantity: exitQuantity === "0" ? nonNegativeDecimalString("0") : filled,
    exitedQuantity: exited,
    unprotectedFilledQuantity: exitQuantity === "0" ? filled : nonNegativeDecimalString("0"),
    ...(entryQuantity === "0" ? {} : { lastFillPrice: positiveDecimalString("100") }),
    processedFills: entries,
    processedExitFills: exits,
    acknowledgedProtections: Object.freeze([]),
    lastExecutionEventAt: unixMs(latest),
  });
}

function spec(pnlCurrency = "USD") {
  return createLinearInstrumentSizingSpec({
    valuationModel: "LINEAR_PRICE_PNL",
    instrumentId: instrument,
    pnlCurrency,
    quantityUnit: "contracts",
    quantityStep: "0.01",
    minimumQuantity: "0.01",
    maximumQuantity: "100",
    pnlValuePerPriceUnitPerQuantity: "1",
  });
}

function event(overrides: Partial<TradeCostEventInput> = {}): TradeCostEvent {
  return createTradeCostEvent({
    costEventId: "cost-1",
    executionAttemptId: "attempt-cost-1",
    instrumentId: instrument,
    costType: "COMMISSION",
    effect: "DEBIT",
    amount: "1.25",
    currency: "USD",
    effectiveAt: 900,
    source: "TEST_LEDGER",
    ...overrides,
  });
}

function projected(source: ExecutionAttempt, events: readonly TradeCostEvent[] = []) {
  const result = projectTradeCostAccounting(source, spec(), events);
  expect(result.status).toBe("TRADE_COST_ACCOUNTING_PROJECTED");
  if (result.status !== "TRADE_COST_ACCOUNTING_PROJECTED") throw new Error(result.reason);
  return result.accounting;
}

describe("canonical trade cost events", () => {
  it("creates a frozen canonical positive monetary event", () => {
    const created = event();
    expect(created).toMatchObject({ schemaVersion: TRADE_COST_EVENT_SCHEMA_VERSION, amount: "1.25" });
    expect(Object.isFrozen(created)).toBe(true);
  });

  it.each(["0", "0.00", "-1", "-0"])("rejects non-positive amount %s", (amount) => {
    expect(() => event({ amount })).toThrow();
  });

  it.each([
    ["costType", { costType: "TAX" }],
    ["effect", { effect: "CHARGE" }],
    ["effectiveAt", { effectiveAt: -1 }],
    ["source", { source: "" }],
    ["costEventId", { costEventId: " cost " }],
    ["executionAttemptId", { executionAttemptId: "" }],
    ["instrumentId", { instrumentId: "ABC" }],
    ["currency", { currency: "" }],
    ["schemaVersion", { schemaVersion: "OTHER" }],
  ] as const)("rejects malformed %s", (_field, override) => {
    expect(() => event(override as Partial<TradeCostEventInput>)).toThrow();
  });
});

describe("authoritative trade cost aggregation", () => {
  it("projects exact canonical zero totals with no events", () => {
    const accounting = projected(attempt());
    expect(accounting).toMatchObject({
      grossDebitCostAmount: "0",
      grossCreditCostAmount: "0",
      netCostAmount: "0",
      costEventCount: 0,
      costEvents: [],
      executionAccountingAsOf: 900,
      costAccountingAsOf: 900,
    });
    expect(accounting.netCostAmount).not.toBe("-0");
  });

  it.each([
    ["COMMISSION", "1.25"],
    ["EXCHANGE_FEE", "0.40"],
    ["BROKER_FEE", "0.10"],
    ["FUNDING", "0.5"],
    ["BORROW_COST", "0.25"],
  ] as const)("aggregates a %s debit", (costType, amount) => {
    const accounting = projected(attempt(), [event({ costType, amount })]);
    expect(accounting).toMatchObject({ grossDebitCostAmount: amount.replace(/0$/, ""), grossCreditCostAmount: "0" });
    expect(accounting.netCostAmount).toBe(accounting.grossDebitCostAmount);
  });

  it("aggregates funding received and credit exceeding debit as negative net cost", () => {
    const funding = projected(attempt(), [event({ costType: "FUNDING", effect: "CREDIT", amount: "0.75" })]);
    expect(funding).toMatchObject({ grossDebitCostAmount: "0", grossCreditCostAmount: "0.75", netCostAmount: "-0.75" });
    const rebate = projected(attempt(), [
      event({ costEventId: "debit", amount: "0.25" }),
      event({ costEventId: "credit", effect: "CREDIT", amount: "1.25" }),
    ]);
    expect(rebate.netCostAmount).toBe("-1");
  });

  it("aggregates commission and rebate with mixed scales", () => {
    const accounting = projected(attempt(), [
      event({ costEventId: "commission", amount: "1.2500" }),
      event({ costEventId: "rebate", effect: "CREDIT", amount: "0.25" }),
    ]);
    expect(accounting).toMatchObject({ grossDebitCostAmount: "1.25", grossCreditCostAmount: "0.25", netCostAmount: "1" });
  });

  it("aggregates the five-type checkpoint solely by effect", () => {
    const values: readonly [string, TradeCostType, "DEBIT" | "CREDIT", string][] = [
      ["1", "COMMISSION", "DEBIT", "1.25"],
      ["2", "EXCHANGE_FEE", "DEBIT", "0.40"],
      ["3", "BROKER_FEE", "DEBIT", "0.10"],
      ["4", "FUNDING", "CREDIT", "0.50"],
      ["5", "BORROW_COST", "DEBIT", "0.25"],
    ];
    const accounting = projected(attempt(), values.map(([costEventId, costType, effect, amount]) =>
      event({ costEventId, costType, effect, amount })));
    expect(accounting).toMatchObject({ grossDebitCostAmount: "2", grossCreditCostAmount: "0.5", netCostAmount: "1.5" });
  });

  it("canonicalizes an exact debit-credit zero without negative zero", () => {
    const accounting = projected(attempt(), [
      event({ costEventId: "d", amount: "1.000" }),
      event({ costEventId: "c", effect: "CREDIT", amount: "1" }),
    ]);
    expect(accounting.netCostAmount).toBe("0");
    expect(accounting.netCostAmount).not.toBe("-0");
  });
});

describe("binding, chronology, and canonical ledger behavior", () => {
  it.each([
    ["COST_EVENT_EXECUTION_ATTEMPT_MISMATCH", { executionAttemptId: "other" }],
    ["COST_EVENT_INSTRUMENT_MISMATCH", { instrumentId: otherInstrument }],
    ["COST_EVENT_CURRENCY_MISMATCH", { currency: "EUR" }],
    ["COST_EVENT_PRECEDES_ATTEMPT", { effectiveAt: 899 }],
  ] as const)("rejects %s", (reason, override) => {
    const result = projectTradeCostAccounting(attempt(), spec(), [event(override)]);
    expect(result).toEqual({ status: "TRADE_COST_ACCOUNTING_REJECTED", reason });
  });

  it("allows equality with preparedAsOf and an event before current execution accounting", () => {
    const source = attempt({ entryQuantity: "1", entryAt: 1_005 });
    const accounting = projected(source, [event({ effectiveAt: 900 })]);
    expect(accounting.executionAccountingAsOf).toBe(1_005);
    expect(accounting.costAccountingAsOf).toBe(1_005);
  });

  it("allows a post-close event and advances only the cost as-of", () => {
    const source = attempt({ entryQuantity: "1", exitQuantity: "1", entryAt: 1_001, exitAt: 1_007, terminal: true });
    const accounting = projected(source, [event({ costType: "EXCHANGE_FEE", amount: "0.30", effectiveAt: 1_010 })]);
    expect(accounting.positionExposure.exposureState).toBe("CLOSED");
    expect(accounting.executionAccountingAsOf).toBe(1_007);
    expect(accounting.costAccountingAsOf).toBe(1_010);
  });

  it("fails closed on duplicate IDs even when payloads are identical", () => {
    const same = event();
    const result = projectTradeCostAccounting(attempt(), spec(), [same, same]);
    expect(result).toEqual({ status: "TRADE_COST_ACCOUNTING_REJECTED", reason: "DUPLICATE_COST_EVENT_ID" });
  });

  it("accepts distinct same-time IDs and orders by time then ID", () => {
    const accounting = projected(attempt(), [
      event({ costEventId: "z", effectiveAt: 902 }),
      event({ costEventId: "b", effectiveAt: 901 }),
      event({ costEventId: "a", effectiveAt: 901 }),
    ]);
    expect(accounting.costEvents.map(({ costEventId }) => costEventId)).toEqual(["a", "b", "z"]);
    expect(accounting.costAccountingAsOf).toBe(902);
  });

  it("produces equal canonical output for reversed input", () => {
    const events = [event({ costEventId: "b", effectiveAt: 902 }), event({ costEventId: "a", effectiveAt: 901 })];
    expect(projected(attempt(), events)).toEqual(projected(attempt(), [...events].reverse()));
  });

  it("rejects forged malformed event objects without throwing", () => {
    const forged = { ...event(), amount: "0" } as unknown as TradeCostEvent;
    expect(projectTradeCostAccounting(attempt(), spec(), [forged])).toEqual({
      status: "TRADE_COST_ACCOUNTING_REJECTED",
      reason: "COST_EVENT_INVALID",
    });
  });
});

describe("upstream preservation, immutability, and determinism", () => {
  it("preserves the exact Task027A and PositionExposure references", () => {
    const accounting = projected(attempt(), [event()]);
    expect(accounting.positionExposure).toBe(accounting.realizedAccounting.positionExposure);
    expect(Object.isFrozen(accounting.realizedAccounting)).toBe(true);
    expect(Object.isFrozen(accounting.positionExposure)).toBe(true);
  });

  it("preserves Task027A rejection including nested PositionExposure rejection", () => {
    const source = attempt();
    const malformed = Object.freeze({ ...source, filledEntryQuantity: nonNegativeDecimalString("1") });
    const result = projectTradeCostAccounting(malformed, spec(), []);
    expect(result.status).toBe("TRADE_COST_ACCOUNTING_REJECTED");
    if (result.status !== "TRADE_COST_ACCOUNTING_REJECTED") throw new Error("expected rejection");
    expect(result.reason).toBe("REALIZED_ACCOUNTING_REJECTED");
    expect(result.realizedAccountingProjection?.status).toBe("REALIZED_ACCOUNTING_REJECTED");
    expect(result.realizedAccountingProjection?.reason).toBe("POSITION_EXPOSURE_REJECTED");
    expect(result.realizedAccountingProjection?.positionProjection?.status).toBe("POSITION_EXPOSURE_REJECTED");
  });

  it("preserves a non-position Task027A rejection exactly", () => {
    const source = attempt({ entryQuantity: "1" });
    const malformed = Object.freeze({ ...source, processedFills: Object.freeze([]) });
    const result = projectTradeCostAccounting(malformed, spec(), []);
    expect(result).toMatchObject({
      status: "TRADE_COST_ACCOUNTING_REJECTED",
      reason: "REALIZED_ACCOUNTING_REJECTED",
      realizedAccountingProjection: { status: "REALIZED_ACCOUNTING_REJECTED", reason: "ENTRY_FILL_HISTORY_INCOHERENT" },
    });
  });

  it("does not mutate inputs and deeply freezes newly owned output boundaries", () => {
    const source = attempt();
    const accountingSpec = spec();
    const inputEvent = event();
    const inputEvents = Object.freeze([inputEvent]);
    const sourceBefore = JSON.stringify(source);
    const specBefore = JSON.stringify(accountingSpec);
    const eventBefore = JSON.stringify(inputEvent);
    const result = projectTradeCostAccounting(source, accountingSpec, inputEvents);
    expect(JSON.stringify(source)).toBe(sourceBefore);
    expect(JSON.stringify(accountingSpec)).toBe(specBefore);
    expect(JSON.stringify(inputEvent)).toBe(eventBefore);
    expect(inputEvents[0]).toBe(inputEvent);
    expect(Object.isFrozen(result)).toBe(true);
    if (result.status !== "TRADE_COST_ACCOUNTING_PROJECTED") throw new Error(result.reason);
    expect(Object.isFrozen(result.accounting)).toBe(true);
    expect(Object.isFrozen(result.accounting.costEvents)).toBe(true);
    expect(result.accounting.costEvents.every(Object.isFrozen)).toBe(true);
  });

  it("is deterministic across repeats and fresh engine instances for LONG and SHORT", () => {
    const events = [event({ effect: "CREDIT", amount: "0.5" }), event({ costEventId: "fee", amount: "1" })];
    const long = attempt({ entrySide: "BUY", entryQuantity: "1" });
    const short = attempt({ entrySide: "SELL", entryQuantity: "1" });
    const first = projectTradeCostAccounting(long, spec(), events);
    expect(projectTradeCostAccounting(long, spec(), events)).toEqual(first);
    expect(new TradeCostAccountingEngine().project(long, spec(), events)).toEqual(first);
    const shortResult = projected(short, events);
    expect(shortResult.netCostAmount).toBe("0.5");
    expect(shortResult.netCostAmount).toBe(projected(long, events).netCostAmount);
  });

  it("does not expose aggregate overrides, rates, net PnL, tax, FX, slippage, or account fields", () => {
    const accounting = projected(attempt(), [event()]);
    for (const field of [
      "commissionRate", "feeRate", "notional", "netRealizedPnl", "netTotalPnl", "tax",
      "fxRate", "slippage", "portfolio", "accountEquity", "cashBalance",
    ]) expect(accounting).not.toHaveProperty(field);
  });
});
