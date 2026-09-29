import { describe, expect, it } from "vitest";
import { addDecimal, subtractNonNegative } from "@ulte/exact-decimal";
import {
  createExitFillEvent,
  createFillEvent,
  type ExecutionAttempt,
  type ExitFillEvent,
  type FillEvent,
} from "@ulte/execution-engine";
import {
  currencyCode,
  createInstrumentId,
  nonNegativeDecimalString,
  positiveDecimalString,
  unixMs,
  type DecimalString,
} from "@ulte/instrument-model";
import { createLinearInstrumentSizingSpec } from "@ulte/position-sizing-engine";
import {
  createTradeCostEvent,
  projectTradeCostAccounting,
  type TradeCostAccounting,
  type TradeCostEvent,
  type TradeCostEventInput,
} from "@ulte/trade-cost-accounting-engine";
import {
  projectTradePerformanceSnapshot,
  type TradePerformanceSnapshot,
} from "@ulte/trade-performance-engine";
import { createValuationMark } from "@ulte/trade-valuation-engine";
import {
  NetTradePerformanceEngine,
  projectNetTradePerformanceFromAuthorities,
  projectNetTradePerformanceSnapshot,
} from "./index.js";

const instrument = createInstrumentId({ venue: "TEST", venueSymbol: "ABC", instrumentKind: "CFD" });
const otherInstrument = createInstrumentId({ venue: "TEST", venueSymbol: "XYZ", instrumentKind: "CFD" });

interface FillFixture {
  readonly id: string;
  readonly quantity: string;
  readonly price: string;
  readonly at: number;
}

interface AttemptFixture {
  readonly entries?: readonly FillFixture[];
  readonly exits?: readonly FillFixture[];
  readonly entrySide?: "BUY" | "SELL";
  readonly entryOrderStatus?: ExecutionAttempt["entryOrderStatus"];
  readonly quantity?: string;
}

function total(fills: readonly FillFixture[]): string {
  return fills.reduce<DecimalString>(
    (sum, fill) => addDecimal(sum, positiveDecimalString(fill.quantity)),
    nonNegativeDecimalString("0"),
  );
}

function attempt(fixture: AttemptFixture = {}): ExecutionAttempt {
  const entries = fixture.entries ?? [];
  const exits = fixture.exits ?? [];
  const filled = nonNegativeDecimalString(total(entries));
  const exited = nonNegativeDecimalString(total(exits));
  const open = subtractNonNegative(filled, exited);
  const entrySide = fixture.entrySide ?? "BUY";
  const exitSide = entrySide === "BUY" ? "SELL" : "BUY";
  const entryOrderStatus = fixture.entryOrderStatus ?? "WORKING";
  const processedFills: readonly FillEvent[] = Object.freeze(entries.map((fill) => createFillEvent({
    executionAttemptId: "attempt-net-1",
    adapterOrderId: "ORDER-NET-1",
    fillId: fill.id,
    filledQuantity: fill.quantity,
    fillPrice: fill.price,
    filledAt: fill.at,
  })));
  const processedExitFills: readonly ExitFillEvent[] = Object.freeze(exits.map((fill) => createExitFillEvent({
    executionAttemptId: "attempt-net-1",
    protectionRequestId: "PROTECT-NET-1",
    exitSide,
    exitLeg: "PROFIT_TARGET",
    fillId: fill.id,
    filledQuantity: fill.quantity,
    fillPrice: fill.price,
    filledAt: fill.at,
  })));
  const hasExit = exited !== "0";
  const terminal = hasExit && open === "0" && entryOrderStatus !== "WORKING";
  const state: ExecutionAttempt["state"] = terminal
    ? "EXIT_FILLED"
    : hasExit
      ? "EXIT_PARTIALLY_FILLED"
      : filled === "0"
        ? "ENTRY_WORKING"
        : entryOrderStatus === "FILLED"
          ? "ENTRY_FILLED"
          : "ENTRY_PARTIALLY_FILLED";
  const protectedQuantity = hasExit ? filled : nonNegativeDecimalString("0");
  const latestAt = [...entries, ...exits].reduce((latest, fill) => fill.at > latest ? fill.at : latest, 900);
  return Object.freeze({
    status: "EXECUTION_ATTEMPT_READY",
    schemaVersion: "EXECUTION_ATTEMPT_V3",
    executionAttemptId: "attempt-net-1",
    executionPlanId: "plan-net-1",
    tradeIntentId: "intent-net-1",
    candidateId: "candidate-net-1",
    instrumentId: instrument,
    preparedAsOf: unixMs(900),
    entrySide,
    exitSide,
    quantity: positiveDecimalString(fixture.quantity ?? (filled === "0" ? "10" : filled)),
    quantityUnit: "contracts", accountCurrency: currencyCode("USD"),
    entryPrice: positiveDecimalString("100"),
    stopTriggerPrice: positiveDecimalString(entrySide === "BUY" ? "90" : "110"),
    targetPrice: positiveDecimalString(entrySide === "BUY" ? "130" : "70"),
    approvedRiskAmount: positiveDecimalString("100"),
    actualRiskAmount: positiveDecimalString("100"),
    netRewardRiskBps: "30000",
    state,
    entryOrderStatus,
    submissionIdempotencyKey: "entry-key",
    protectionMode: "MANAGED_PROTECTION",
    adapterOrderId: "ORDER-NET-1",
    filledEntryQuantity: filled,
    protectedQuantity,
    exitedQuantity: exited,
    unprotectedFilledQuantity: subtractNonNegative(filled, protectedQuantity),
    ...(entries.length === 0 ? {} : { lastFillPrice: positiveDecimalString(entries.at(-1)?.price ?? "100") }),
    processedFills,
    processedExitFills,
    acknowledgedProtections: Object.freeze([]),
    lastExecutionEventAt: unixMs(latestAt),
  });
}

function spec(currency = "USD") {
  return createLinearInstrumentSizingSpec({
    valuationModel: "LINEAR_PRICE_PNL",
    instrumentId: instrument,
    pnlCurrency: currency,
    quantityUnit: "contracts",
    quantityStep: "0.01",
    minimumQuantity: "0.01",
    maximumQuantity: "100",
    pnlValuePerPriceUnitPerQuantity: "1",
  });
}

function cost(overrides: Partial<TradeCostEventInput> = {}): TradeCostEvent {
  return createTradeCostEvent({
    costEventId: "cost-1",
    executionAttemptId: "attempt-net-1",
    instrumentId: instrument,
    costType: "COMMISSION",
    effect: "DEBIT",
    amount: "1.25",
    currency: "USD",
    effectiveAt: 1_001,
    source: "NET_TEST_LEDGER",
    ...overrides,
  });
}

function netSnapshot(
  source: ExecutionAttempt,
  price: string,
  costs: readonly TradeCostEvent[] = [],
  markAsOf = 2_000,
) {
  const result = projectNetTradePerformanceSnapshot(
    source,
    spec(),
    createValuationMark({ instrumentId: instrument, markPrice: price, markAsOf }),
    costs,
  );
  expect(result.status).toBe("NET_TRADE_PERFORMANCE_PROJECTED");
  if (result.status !== "NET_TRADE_PERFORMANCE_PROJECTED") throw new Error(result.reason);
  return result.snapshot;
}

function authorities(
  source = attempt({ entries: [{ id: "F1", quantity: "2.75", price: "100", at: 1_001 }] }),
  price = "105",
  costs: readonly TradeCostEvent[] = [cost()],
  markAsOf = 2_000,
): readonly [TradePerformanceSnapshot, TradeCostAccounting] {
  const accountingSpec = spec();
  const grossResult = projectTradePerformanceSnapshot(
    source,
    accountingSpec,
    createValuationMark({ instrumentId: instrument, markPrice: price, markAsOf }),
  );
  const costResult = projectTradeCostAccounting(source, accountingSpec, costs);
  if (grossResult.status !== "TRADE_PERFORMANCE_PROJECTED") throw new Error(grossResult.reason);
  if (costResult.status !== "TRADE_COST_ACCOUNTING_PROJECTED") throw new Error(costResult.reason);
  return [grossResult.snapshot, costResult.accounting];
}

describe("authoritative net total aggregation", () => {
  const open = () => attempt({ entries: [{ id: "F1", quantity: "2.75", price: "100", at: 1_001 }] });

  it("covers no cost, positive cost, net credit, exact zero, and mixed decimal scales", () => {
    expect(netSnapshot(open(), "105")).toMatchObject({ grossTotalPnl: "13.75", netCostAmount: "0", netTotalPnl: "13.75" });
    expect(netSnapshot(open(), "105", [cost()])).toMatchObject({ grossTotalPnl: "13.75", netCostAmount: "1.25", netTotalPnl: "12.5" });
    expect(netSnapshot(open(), "105", [cost({ effect: "CREDIT", amount: "0.7500" })])).toMatchObject({ netCostAmount: "-0.75", netTotalPnl: "14.5" });
    const zero = netSnapshot(
      attempt({ entries: [{ id: "F1", quantity: "1", price: "100", at: 1_001 }] }),
      "101.000",
      [cost({ amount: "1.0000" })],
    );
    expect(zero.netTotalPnl).toBe("0");
    expect(zero.netTotalPnl).not.toBe("-0");
  });

  it("preserves OPEN, PARTIALLY_EXITED, FLAT_ENTRY_ACTIVE, and CLOSED checkpoints", () => {
    const opened = netSnapshot(open(), "105", [cost()]);
    expect(opened.positionExposure.exposureState).toBe("OPEN");
    expect(opened.netTotalPnl).toBe("12.5");

    const partial = netSnapshot(attempt({
      entries: [{ id: "F1", quantity: "2.75", price: "100", at: 1_001 }],
      exits: [{ id: "X1", quantity: "1.25", price: "105", at: 1_003 }],
    }), "110", [
      cost({ costEventId: "commission", amount: "1.25" }),
      cost({ costEventId: "exchange", costType: "EXCHANGE_FEE", amount: "0.40" }),
      cost({ costEventId: "funding", costType: "FUNDING", effect: "CREDIT", amount: "0.50" }),
    ]);
    expect(partial.positionExposure.exposureState).toBe("PARTIALLY_EXITED");
    expect(partial).toMatchObject({ grossTotalPnl: "21.25", netCostAmount: "1.15", netTotalPnl: "20.1" });

    const flat = netSnapshot(attempt({
      quantity: "5",
      entries: [{ id: "F1", quantity: "2.75", price: "100", at: 1_001 }],
      exits: [
        { id: "X1", quantity: "1.25", price: "105", at: 1_003 },
        { id: "X2", quantity: "1.5", price: "90", at: 1_004 },
      ],
    }), "120", [cost()]);
    expect(flat.positionExposure.exposureState).toBe("FLAT_ENTRY_ACTIVE");
    expect(flat).toMatchObject({ grossTotalPnl: "-8.75", netTotalPnl: "-10" });

    const closed = netSnapshot(attempt({
      entryOrderStatus: "FILLED",
      entries: [{ id: "F1", quantity: "2.75", price: "100", at: 1_001 }],
      exits: [{ id: "X1", quantity: "2.75", price: "105", at: 1_007 }],
    }), "110", [cost({ amount: "1.5", effectiveAt: 1_010 })], 1_007);
    expect(closed.positionExposure.exposureState).toBe("CLOSED");
    expect(closed).toMatchObject({ grossTotalPnl: "13.75", netCostAmount: "1.5", netTotalPnl: "12.25" });
    expect(closed.costAccountingAsOf).toBeGreaterThan(closed.valuationAsOf);
  });

  it("supports profitable and losing SHORT without direction-specific net arithmetic", () => {
    const short = attempt({
      entrySide: "SELL",
      entries: [{ id: "F1", quantity: "2", price: "100", at: 1_001 }],
    });
    expect(netSnapshot(short, "90", [cost({ amount: "1" })])).toMatchObject({
      direction: "SHORT", grossTotalPnl: "20", netTotalPnl: "19",
    });
    expect(netSnapshot(short, "110", [cost({ amount: "1" })])).toMatchObject({
      direction: "SHORT", grossTotalPnl: "-20", netTotalPnl: "-21",
    });
  });

  it("allows later open and post-close cost evidence to change only the net side", () => {
    const source = open();
    const [gross, firstCost] = authorities(source, "105", [cost({ amount: "1.25" })], 1_005);
    const [, laterCost] = authorities(source, "105", [cost({ amount: "0.75", effectiveAt: 1_010 })], 1_005);
    const first = projectNetTradePerformanceFromAuthorities(gross, firstCost);
    const later = projectNetTradePerformanceFromAuthorities(gross, laterCost);
    expect(first).toMatchObject({ snapshot: { grossTotalPnl: "13.75", netTotalPnl: "12.5" } });
    expect(later).toMatchObject({ snapshot: { grossTotalPnl: "13.75", netTotalPnl: "13", costAccountingAsOf: 1_010 } });
    if (first.status !== "NET_TRADE_PERFORMANCE_PROJECTED" || later.status !== "NET_TRADE_PERFORMANCE_PROJECTED") return;
    expect(later.snapshot.grossPerformance).toBe(first.snapshot.grossPerformance);

    const closedSource = attempt({
      entryOrderStatus: "FILLED",
      entries: [{ id: "F1", quantity: "2.75", price: "100", at: 1_001 }],
      exits: [{ id: "X1", quantity: "2.75", price: "105", at: 1_007 }],
    });
    const [closedGross, closedCost] = authorities(
      closedSource,
      "110",
      [cost({ amount: "1.5", effectiveAt: 1_010 })],
      1_007,
    );
    const closedNet = projectNetTradePerformanceFromAuthorities(closedGross, closedCost);
    expect(closedNet).toMatchObject({ snapshot: { netTotalPnl: "12.25", valuationAsOf: 1_007, costAccountingAsOf: 1_010 } });
  });
});

describe("rejections and authority coherence", () => {
  it("preserves exact Task029A and nested Task028A/Task027A/position rejections", () => {
    const wrongMark = createValuationMark({ instrumentId: otherInstrument, markPrice: "100", markAsOf: 2_000 });
    const invalidCost = Object.freeze({ ...cost(), amount: "bad" }) as unknown as TradeCostEvent;
    const grossRejected = projectNetTradePerformanceSnapshot(attempt(), spec(), wrongMark, [invalidCost]);
    expect(grossRejected).toMatchObject({
      status: "NET_TRADE_PERFORMANCE_REJECTED",
      reason: "GROSS_PERFORMANCE_REJECTED",
      grossPerformanceProjection: {
        reason: "UNREALIZED_VALUATION_REJECTED",
        valuationProjection: { reason: "VALUATION_MARK_INSTRUMENT_MISMATCH" },
      },
    });

    const malformed = Object.freeze({ ...attempt(), exitedQuantity: nonNegativeDecimalString("1") });
    const nested = projectNetTradePerformanceSnapshot(
      malformed,
      spec(),
      createValuationMark({ instrumentId: instrument, markPrice: "100", markAsOf: 2_000 }),
      [],
    );
    expect(nested).toMatchObject({
      grossPerformanceProjection: {
        valuationProjection: {
          reason: "REALIZED_ACCOUNTING_REJECTED",
          accountingProjection: {
            reason: "POSITION_EXPOSURE_REJECTED",
            positionProjection: { reason: "EXIT_QUANTITY_EXCEEDS_ENTRY" },
          },
        },
      },
    });
  });

  it.each([
    ["COST_EVENT_EXECUTION_ATTEMPT_MISMATCH", { executionAttemptId: "other" }],
    ["COST_EVENT_INSTRUMENT_MISMATCH", { instrumentId: otherInstrument }],
    ["COST_EVENT_CURRENCY_MISMATCH", { currency: "EUR" }],
    ["COST_EVENT_PRECEDES_ATTEMPT", { effectiveAt: 899 }],
  ] as const)("preserves exact Task030A rejection %s", (reason, override) => {
    const result = projectNetTradePerformanceSnapshot(
      attempt(),
      spec(),
      createValuationMark({ instrumentId: instrument, markPrice: "100", markAsOf: 2_000 }),
      [cost(override)],
    );
    expect(result).toEqual({
      status: "NET_TRADE_PERFORMANCE_REJECTED",
      reason: "COST_ACCOUNTING_REJECTED",
      costAccountingProjection: { status: "TRADE_COST_ACCOUNTING_REJECTED", reason },
    });
  });

  it("rejects mismatched identity, currency, accounting, PnL, and quantity authorities", () => {
    const [gross, accounting] = authorities();
    const incoherent = (forged: TradeCostAccounting) => {
      expect(projectNetTradePerformanceFromAuthorities(gross, forged)).toEqual({
        status: "NET_TRADE_PERFORMANCE_REJECTED",
        reason: "NET_PERFORMANCE_INCOHERENT",
      });
    };
    incoherent(Object.freeze({ ...accounting, executionAttemptId: "other" }));
    incoherent(Object.freeze({ ...accounting, instrumentId: otherInstrument }));
    incoherent(Object.freeze({ ...accounting, pnlCurrency: "EUR" as typeof accounting.pnlCurrency }));
    incoherent(Object.freeze({ ...accounting, executionAccountingAsOf: unixMs(999) }));
    incoherent(Object.freeze({
      ...accounting,
      realizedAccounting: Object.freeze({ ...accounting.realizedAccounting, grossRealizedPnl: "1" as typeof accounting.realizedAccounting.grossRealizedPnl }),
    }));
    for (const field of ["filledEntryQuantity", "exitedQuantity", "openQuantity"] as const) {
      incoherent(Object.freeze({
        ...accounting,
        realizedAccounting: Object.freeze({
          ...accounting.realizedAccounting,
          [field]: nonNegativeDecimalString("999"),
        }),
      }));
    }
  });

  it("rejects position-state and direction incoherence while allowing distinct equivalent authorities", () => {
    const [gross, accounting] = authorities();
    expect(gross.realizedAccounting).not.toBe(accounting.realizedAccounting);
    expect(gross.positionExposure).not.toBe(accounting.positionExposure);
    expect(projectNetTradePerformanceFromAuthorities(gross, accounting).status).toBe("NET_TRADE_PERFORMANCE_PROJECTED");

    const forgedPosition = Object.freeze({
      ...accounting.positionExposure,
      direction: "SHORT" as const,
      exposureState: "CLOSED" as const,
    });
    const forged = Object.freeze({
      ...accounting,
      positionExposure: forgedPosition,
      realizedAccounting: Object.freeze({ ...accounting.realizedAccounting, positionExposure: forgedPosition }),
    });
    expect(projectNetTradePerformanceFromAuthorities(gross, forged)).toEqual({
      status: "NET_TRADE_PERFORMANCE_REJECTED",
      reason: "NET_PERFORMANCE_INCOHERENT",
    });
  });
});

describe("provenance, immutability, determinism, and narrow scope", () => {
  it("preserves all required reference identities and frozen boundaries", () => {
    const [gross, accounting] = authorities();
    const result = projectNetTradePerformanceFromAuthorities(gross, accounting);
    expect(result.status).toBe("NET_TRADE_PERFORMANCE_PROJECTED");
    if (result.status !== "NET_TRADE_PERFORMANCE_PROJECTED") return;
    expect(result.snapshot.grossPerformance).toBe(gross);
    expect(result.snapshot.costAccounting).toBe(accounting);
    expect(result.snapshot.positionExposure).toBe(gross.positionExposure);
    for (const value of [result, result.snapshot, gross, accounting, result.snapshot.positionExposure]) {
      expect(Object.isFrozen(value)).toBe(true);
    }
  });

  it("does not mutate inputs and is deterministic across repeats and fresh engines", () => {
    const source = attempt({ entries: [{ id: "F1", quantity: "2.75", price: "100", at: 1_001 }] });
    const accountingSpec = spec();
    const valuationMark = createValuationMark({ instrumentId: instrument, markPrice: "105", markAsOf: 2_000 });
    const events = Object.freeze([cost()]);
    const before = [source, accountingSpec, valuationMark, events].map((value) => JSON.stringify(value));
    const first = projectNetTradePerformanceSnapshot(source, accountingSpec, valuationMark, events);
    expect(projectNetTradePerformanceSnapshot(source, accountingSpec, valuationMark, events)).toEqual(first);
    expect(new NetTradePerformanceEngine().project(source, accountingSpec, valuationMark, events)).toEqual(first);
    expect([source, accountingSpec, valuationMark, events].map((value) => JSON.stringify(value))).toEqual(before);
  });

  it("accepts only the four standalone inputs or two complete authorities and exposes no deferred fields", () => {
    expect(projectNetTradePerformanceSnapshot.length).toBe(4);
    expect(projectNetTradePerformanceFromAuthorities.length).toBe(2);
    const snapshot = netSnapshot(attempt(), "100");
    for (const field of [
      "netRealizedPnl", "netUnrealizedPnl", "realizedCostAllocation", "unrealizedCostAllocation",
      "tax", "fxRate", "slippage", "commissionRate", "feeRate", "notional", "portfolio",
      "accountEquity", "nav", "netPerformanceAsOf",
    ]) expect(snapshot).not.toHaveProperty(field);
  });
});
