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
  createInstrumentId,
  currencyCode,
  decimalString,
  positiveDecimalString,
  unixMs,
} from "@ulte/instrument-model";
import type { ReadyExecutionPlan } from "@ulte/execution-preparation-engine";
import { projectNetTradePerformanceSnapshot, type NetTradePerformanceSnapshot } from "@ulte/net-trade-performance-engine";
import { createLinearInstrumentSizingSpec } from "@ulte/position-sizing-engine";
import { createTradeCostEvent } from "@ulte/trade-cost-accounting-engine";
import { createValuationMark } from "@ulte/trade-valuation-engine";
import {
  TRADE_RISK_BASIS_METHOD,
  TRADE_RISK_BASIS_SCHEMA_VERSION,
  TRADE_R_MULTIPLE_SNAPSHOT_SCHEMA_VERSION,
  TradeRMultipleEngine,
  createTradeRiskBasisFromExecutionAttempt,
  projectTradeRMultipleFromAuthorities,
  projectTradeRMultipleSnapshot,
  type TradeRiskBasis,
} from "./index.js";

const instrument = createInstrumentId({ venue: "TEST", venueSymbol: "R-UNIT", instrumentKind: "CFD" });
const capabilities = createAdapterCapabilities({
  supportsClientIdempotency: false,
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
  const quantity = positiveDecimalString("5");
  return Object.freeze({
    status: "EXECUTION_PLAN_READY",
    schemaVersion: "EXECUTION_PLAN_V2",
    executionPlanId: "plan-r-unit",
    tradeIntentId: "intent-r-unit",
    candidateId: "candidate-r-unit",
    instrumentId: instrument,
    intentAsOf: unixMs(800),
    marketSnapshotAsOf: unixMs(850),
    preparedAsOf: unixMs(900),
    direction: "UP",
    entrySide: "BUY",
    exitSide: "SELL",
    quantity,
    quantityUnit: "contracts",
    accountCurrency: currencyCode("USD"),
    entryInstruction: Object.freeze({ kind: "ENTRY_LIMIT", side: "BUY", price: positiveDecimalString("100"), quantity, positionEffect: "OPEN" }),
    protectiveStopInstruction: Object.freeze({ kind: "PROTECTIVE_STOP_TRIGGER", side: "SELL", triggerPrice: positiveDecimalString("90"), quantity, positionEffect: "CLOSE" }),
    profitTargetInstruction: Object.freeze({ kind: "PROFIT_TARGET_LIMIT", side: "SELL", price: positiveDecimalString("130"), quantity, positionEffect: "CLOSE" }),
    priceTick: positiveDecimalString("0.01"),
    quantityStep: positiveDecimalString("0.01"),
    bidAtPreparation: positiveDecimalString("99.99"),
    askAtPreparation: positiveDecimalString("100"),
    intentAgeMs: 100,
    quoteAgeMs: 50,
    entryDeviationBps: "0",
    approvedRiskAmount: positiveDecimalString("12"),
    actualRiskAmount: positiveDecimalString("10"),
    netRewardRiskBps: "30000",
  });
}

function readyAttempt(): ExecutionAttempt {
  const created = createExecutionAttempt(plan());
  if (created.status !== "EXECUTION_ATTEMPT_READY") throw new Error("attempt creation failed");
  return created;
}

function authorities(): { attempt: ExecutionAttempt; net: NetTradePerformanceSnapshot; basis: TradeRiskBasis } {
  const created = readyAttempt();
  const submitted = requestEntrySubmission(created, capabilities);
  if (submitted.status !== "ENTRY_SUBMISSION_READY") throw new Error("submission failed");
  const acknowledged = acknowledgeEntrySubmission(submitted.attempt, {
    executionAttemptId: created.executionAttemptId,
    idempotencyKey: submitted.request.idempotencyKey,
    adapterOrderId: "ORDER-R-UNIT",
    acknowledgedAt: 1_000,
  });
  if (acknowledged.status !== "EXECUTION_ATTEMPT_UPDATED") throw new Error("acknowledgement failed");
  const filled = applyEntryFill(acknowledged.attempt, {
    executionAttemptId: created.executionAttemptId,
    adapterOrderId: "ORDER-R-UNIT",
    fillId: "F1",
    filledQuantity: "2.75",
    fillPrice: "100",
    filledAt: 1_001,
  });
  if (filled.status !== "EXECUTION_ATTEMPT_UPDATED") throw new Error("fill failed");
  const cost = createTradeCostEvent({
    costEventId: "C1",
    executionAttemptId: filled.attempt.executionAttemptId,
    instrumentId: filled.attempt.instrumentId,
    costType: "COMMISSION",
    effect: "DEBIT",
    amount: "1.25",
    currency: "USD",
    effectiveAt: 1_001,
    source: "R_UNIT_LEDGER",
  });
  const net = projectNetTradePerformanceSnapshot(
    filled.attempt,
    accountingSpec,
    createValuationMark({ instrumentId: instrument, markPrice: "105", markAsOf: 1_001 }),
    [cost],
  );
  if (net.status !== "NET_TRADE_PERFORMANCE_PROJECTED") throw new Error(net.reason);
  const basis = createTradeRiskBasisFromExecutionAttempt(filled.attempt);
  if (basis.status !== "TRADE_RISK_BASIS_CREATED") throw new Error(basis.reason);
  return { attempt: filled.attempt, net: net.snapshot, basis: basis.riskBasis };
}

function forgedAttempt(source: ExecutionAttempt, updates: Record<string, unknown>): ExecutionAttempt {
  return { ...source, ...updates } as unknown as ExecutionAttempt;
}

function forgedBasis(source: TradeRiskBasis, updates: Record<string, unknown>): TradeRiskBasis {
  return { ...source, ...updates } as unknown as TradeRiskBasis;
}

describe("authoritative execution risk basis", () => {
  it("uses ExecutionAttempt V3 actual risk, currency, and preparation boundary", () => {
    const attempt = readyAttempt();
    const result = createTradeRiskBasisFromExecutionAttempt(attempt);
    expect(result.status).toBe("TRADE_RISK_BASIS_CREATED");
    if (result.status !== "TRADE_RISK_BASIS_CREATED") return;
    expect(result.riskBasis).toEqual({
      schemaVersion: TRADE_RISK_BASIS_SCHEMA_VERSION,
      executionAttemptId: attempt.executionAttemptId,
      executionPlanId: attempt.executionPlanId,
      tradeIntentId: attempt.tradeIntentId,
      candidateId: attempt.candidateId,
      instrumentId: attempt.instrumentId,
      riskBasisMethod: TRADE_RISK_BASIS_METHOD,
      initialActualRiskAmount: "10",
      accountCurrency: "USD",
      riskBasisAsOf: 900,
    });
    expect(result.riskBasis.initialActualRiskAmount).not.toBe(attempt.approvedRiskAmount);
    expect(Object.isFrozen(result.riskBasis)).toBe(true);
    expect(Object.isFrozen(result)).toBe(true);
  });

  it.each([
    ["legacy schema", { schemaVersion: "EXECUTION_ATTEMPT_V2" }],
    ["empty attempt id", { executionAttemptId: "" }],
    ["empty plan id", { executionPlanId: "" }],
    ["empty intent id", { tradeIntentId: "" }],
    ["empty candidate id", { candidateId: "" }],
    ["malformed instrument", { instrumentId: "not-an-instrument" }],
    ["malformed time", { preparedAsOf: -1 }],
    ["malformed currency", { accountCurrency: "$" }],
    ["zero actual risk", { actualRiskAmount: "0" }],
    ["negative actual risk", { actualRiskAmount: "-1" }],
    ["zero approved risk", { approvedRiskAmount: "0" }],
    ["actual above approved", { actualRiskAmount: "13" }],
  ])("rejects %s", (_label, updates) => {
    const result = createTradeRiskBasisFromExecutionAttempt(forgedAttempt(readyAttempt(), updates));
    expect(result).toEqual({
      status: "TRADE_RISK_BASIS_REJECTED",
      reason: "INVALID_EXECUTION_RISK_BASIS",
    });
    expect(Object.isFrozen(result)).toBe(true);
  });
});

describe("authoritative net R-multiple composition", () => {
  it("preserves exact positive source amounts, authorities, clocks, and references", () => {
    const { net, basis } = authorities();
    const result = projectTradeRMultipleFromAuthorities(net, basis);
    expect(result.status).toBe("TRADE_R_MULTIPLE_PROJECTED");
    if (result.status !== "TRADE_R_MULTIPLE_PROJECTED") return;
    expect(result.snapshot).toMatchObject({
      schemaVersion: TRADE_R_MULTIPLE_SNAPSHOT_SCHEMA_VERSION,
      initialActualRiskAmount: "10",
      netTotalPnl: "12.5",
      netRMultipleRatio: { numerator: "12.5", denominator: "10" },
      pnlCurrency: "USD",
      accountCurrency: "USD",
      riskBasisAsOf: 900,
      executionAccountingAsOf: 1_001,
      valuationAsOf: 1_001,
      costAccountingAsOf: 1_001,
    });
    expect(result.snapshot.netPerformance).toBe(net);
    expect(result.snapshot.riskBasis).toBe(basis);
    expect(result.snapshot.positionExposure).toBe(net.positionExposure);
    expect(Object.isFrozen(result.snapshot.netRMultipleRatio)).toBe(true);
    expect(Object.isFrozen(result.snapshot)).toBe(true);
    expect(Object.isFrozen(result)).toBe(true);
  });

  it.each([
    ["executionAttemptId", "other-attempt"],
    ["executionPlanId", "other-plan"],
    ["tradeIntentId", "other-intent"],
    ["candidateId", "other-candidate"],
    ["instrumentId", createInstrumentId({ venue: "TEST", venueSymbol: "OTHER", instrumentKind: "CFD" })],
  ])("rejects incoherent %s", (field, value) => {
    const { net, basis } = authorities();
    const result = projectTradeRMultipleFromAuthorities(net, forgedBasis(basis, { [field]: value }));
    expect(result).toEqual({ status: "TRADE_R_MULTIPLE_REJECTED", reason: "R_MULTIPLE_AUTHORITY_INCOHERENT" });
  });

  it("rejects BDT risk against USD PnL without producing a snapshot", () => {
    const { net, basis } = authorities();
    const usdPerformance = Object.freeze({ ...net, netTotalPnl: decimalString("13.75") });
    const result = projectTradeRMultipleFromAuthorities(
      usdPerformance,
      forgedBasis(basis, { accountCurrency: currencyCode("BDT"), initialActualRiskAmount: positiveDecimalString("1000") }),
    );
    expect(result).toEqual({ status: "TRADE_R_MULTIPLE_REJECTED", reason: "R_MULTIPLE_CURRENCY_MISMATCH" });
    expect("snapshot" in result).toBe(false);
  });

  it.each([
    ["negative", "-21"],
    ["zero", "0"],
  ])("preserves a %s numerator without quotient generation", (_label, numerator) => {
    const { net, basis } = authorities();
    const adjusted = Object.freeze({ ...net, netTotalPnl: decimalString(numerator) });
    const result = projectTradeRMultipleFromAuthorities(adjusted, basis);
    expect(result.status).toBe("TRADE_R_MULTIPLE_PROJECTED");
    if (result.status !== "TRADE_R_MULTIPLE_PROJECTED") return;
    expect(result.snapshot.netRMultipleRatio).toEqual({ numerator, denominator: "10" });
    expect(result.snapshot).not.toHaveProperty("rMultiple");
    expect(result.snapshot).not.toHaveProperty("rMultipleDecimal");
    expect(result.snapshot).not.toHaveProperty("realizedR");
    expect(result.snapshot).not.toHaveProperty("unrealizedR");
    expect(result.snapshot).not.toHaveProperty("roi");
    expect(result.snapshot).not.toHaveProperty("expectancy");
  });

  it.each([
    ["zero denominator", { initialActualRiskAmount: "0" }],
    ["negative denominator", { initialActualRiskAmount: "-1" }],
    ["legacy basis", { schemaVersion: "TRADE_RISK_BASIS_V0" }],
    ["malformed basis currency", { accountCurrency: "$" }],
  ])("fails closed for %s", (_label, updates) => {
    const { net, basis } = authorities();
    expect(projectTradeRMultipleFromAuthorities(net, forgedBasis(basis, updates))).toEqual({
      status: "TRADE_R_MULTIPLE_REJECTED",
      reason: "RISK_BASIS_INVALID",
    });
  });

  it("preserves the exact risk-basis rejection in the convenience result", () => {
    const { attempt, net } = authorities();
    const result = projectTradeRMultipleSnapshot(forgedAttempt(attempt, { actualRiskAmount: "0" }), net);
    expect(result.status).toBe("TRADE_R_MULTIPLE_REJECTED");
    if (result.status !== "TRADE_R_MULTIPLE_REJECTED" || result.reason !== "RISK_BASIS_REJECTED") return;
    expect(result.riskBasisCreation).toEqual({
      status: "TRADE_RISK_BASIS_REJECTED",
      reason: "INVALID_EXECUTION_RISK_BASIS",
    });
    expect(Object.isFrozen(result.riskBasisCreation)).toBe(true);
  });

  it("is immutable, input-preserving, stateless, and deterministic across calls and instances", () => {
    const { attempt, net, basis } = authorities();
    const attemptBefore = JSON.stringify(attempt);
    const netBefore = JSON.stringify(net);
    const basisBefore = JSON.stringify(basis);
    const first = projectTradeRMultipleFromAuthorities(net, basis);
    const second = projectTradeRMultipleFromAuthorities(net, basis);
    const fromFirstEngine = new TradeRMultipleEngine().project(attempt, net);
    const fromSecondEngine = new TradeRMultipleEngine().project(attempt, net);
    expect(second).toEqual(first);
    expect(fromSecondEngine).toEqual(fromFirstEngine);
    expect(JSON.stringify(attempt)).toBe(attemptBefore);
    expect(JSON.stringify(net)).toBe(netBefore);
    expect(JSON.stringify(basis)).toBe(basisBefore);
  });
});
