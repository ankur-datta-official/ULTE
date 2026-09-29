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
  createValuationMark,
  projectUnrealizedTradeValuation,
  type ValuationMark,
} from "@ulte/trade-valuation-engine";
import {
  TradePerformanceEngine,
  projectTradePerformanceFromValuation,
  projectTradePerformanceSnapshot,
} from "./index.js";

const instrument = createInstrumentId({ venue: "TEST", venueSymbol: "ABC", instrumentKind: "CFD" });

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
  const entrySide = fixture.entrySide ?? "BUY";
  const exitSide = entrySide === "BUY" ? "SELL" : "BUY";
  const entryOrderStatus = fixture.entryOrderStatus ?? "WORKING";
  const processedFills: readonly FillEvent[] = Object.freeze(entries.map((fill) => createFillEvent({
    executionAttemptId: "attempt-1",
    adapterOrderId: "ORDER-1",
    fillId: fill.id,
    filledQuantity: fill.quantity,
    fillPrice: fill.price,
    filledAt: fill.at,
  })));
  const processedExitFills: readonly ExitFillEvent[] = Object.freeze(exits.map((fill) => createExitFillEvent({
    executionAttemptId: "attempt-1",
    protectionRequestId: "protect-1",
    exitSide,
    exitLeg: "PROFIT_TARGET",
    fillId: fill.id,
    filledQuantity: fill.quantity,
    fillPrice: fill.price,
    filledAt: fill.at,
  })));
  const protectedQuantity = exits.length > 0 ? filled : nonNegativeDecimalString("0");
  const open = subtractNonNegative(filled, exited);
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
  const latestAt = [...entries, ...exits].reduce((latest, fill) => fill.at > latest ? fill.at : latest, 1_000);
  return Object.freeze({
    status: "EXECUTION_ATTEMPT_READY",
    schemaVersion: "EXECUTION_ATTEMPT_V3",
    executionAttemptId: "attempt-1",
    executionPlanId: "plan-1",
    tradeIntentId: "intent-1",
    candidateId: "candidate-1",
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
    adapterOrderId: "ORDER-1",
    filledEntryQuantity: filled,
    protectedQuantity,
    exitedQuantity: exited,
    unprotectedFilledQuantity: subtractNonNegative(filled, protectedQuantity),
    lastFillPrice: entries.at(-1)?.price === undefined
      ? undefined
      : positiveDecimalString(entries.at(-1)?.price),
    processedFills,
    processedExitFills,
    acknowledgedProtections: Object.freeze([]),
    lastExecutionEventAt: unixMs(latestAt),
  });
}

function spec(multiplier = "1", instrumentId = instrument) {
  return createLinearInstrumentSizingSpec({
    valuationModel: "LINEAR_PRICE_PNL",
    instrumentId,
    pnlCurrency: "USD",
    quantityUnit: "contracts",
    quantityStep: "0.01",
    minimumQuantity: "0.01",
    maximumQuantity: "100",
    pnlValuePerPriceUnitPerQuantity: multiplier,
  });
}

function mark(price: string, at = 2_000, instrumentId = instrument) {
  return createValuationMark({ instrumentId, markPrice: price, markAsOf: at });
}

function projected(source: ExecutionAttempt, price: string, multiplier = "1", at = 2_000) {
  const result = projectTradePerformanceSnapshot(source, spec(multiplier), mark(price, at));
  expect(result.status).toBe("TRADE_PERFORMANCE_PROJECTED");
  if (result.status !== "TRADE_PERFORMANCE_PROJECTED") throw new Error(result.reason);
  return result.snapshot;
}

describe("authoritative gross trade performance", () => {
  it("projects NO_EXPOSURE as canonical exact zeros", () => {
    const snapshot = projected(attempt(), "110");
    expect(snapshot).toMatchObject({
      schemaVersion: "TRADE_PERFORMANCE_SNAPSHOT_V1",
      filledEntryQuantity: "0",
      exitedQuantity: "0",
      openQuantity: "0",
      grossRealizedPnl: "0",
      grossUnrealizedPnl: "0",
      grossTotalPnl: "0",
    });
    expect(snapshot.positionExposure.exposureState).toBe("NO_EXPOSURE");
    expect(snapshot.grossTotalPnl).not.toBe("-0");
  });

  it.each([
    ["BUY", "105", "LONG", "13.75"],
    ["BUY", "95", "LONG", "-13.75"],
    ["SELL", "90", "SHORT", "27.5"],
    ["SELL", "110", "SHORT", "-27.5"],
  ] as const)("projects %s open exposure marked at %s", (entrySide, price, direction, expected) => {
    const snapshot = projected(attempt({
      entrySide,
      entries: [{ id: "F1", quantity: "2.75", price: "100", at: 1_001 }],
    }), price);
    expect(snapshot).toMatchObject({
      direction,
      grossRealizedPnl: "0",
      grossUnrealizedPnl: expected,
      grossTotalPnl: expected,
    });
    expect(snapshot.positionExposure.exposureState).toBe("OPEN");
  });

  it("aggregates a profitable partial exit and remaining open basis", () => {
    const snapshot = projected(attempt({
      entries: [{ id: "F1", quantity: "2.75", price: "100", at: 1_001 }],
      exits: [{ id: "X1", quantity: "1.25", price: "105", at: 1_003 }],
    }), "110");
    expect(snapshot).toMatchObject({
      filledEntryQuantity: "2.75",
      exitedQuantity: "1.25",
      openQuantity: "1.5",
      grossRealizedPnl: "6.25",
      grossUnrealizedPnl: "15",
      grossTotalPnl: "21.25",
    });
    expect(snapshot.positionExposure.exposureState).toBe("PARTIALLY_EXITED");
  });

  it("aggregates partial-exit realized profit with negative unrealized PnL", () => {
    const snapshot = projected(attempt({
      entries: [{ id: "F1", quantity: "2.75", price: "100", at: 1_001 }],
      exits: [{ id: "X1", quantity: "1.25", price: "105", at: 1_003 }],
    }), "90");
    expect(snapshot).toMatchObject({
      grossRealizedPnl: "6.25", grossUnrealizedPnl: "-15", grossTotalPnl: "-8.75",
    });
  });

  it("aggregates prior realized loss with later unrealized profit", () => {
    const snapshot = projected(attempt({
      quantity: "5",
      entries: [
        { id: "F1", quantity: "2.75", price: "100", at: 1_001 },
        { id: "F2", quantity: "2.25", price: "110", at: 1_005 },
      ],
      exits: [
        { id: "X1", quantity: "1.25", price: "105", at: 1_003 },
        { id: "X2", quantity: "1.5", price: "90", at: 1_004 },
      ],
    }), "120");
    expect(snapshot).toMatchObject({
      grossRealizedPnl: "-8.75", grossUnrealizedPnl: "22.5", grossTotalPnl: "13.75",
    });
  });

  it("preserves FLAT_ENTRY_ACTIVE instead of reinterpreting it as closed", () => {
    const snapshot = projected(attempt({
      quantity: "5",
      entries: [{ id: "F1", quantity: "2.75", price: "100", at: 1_001 }],
      exits: [
        { id: "X1", quantity: "1.25", price: "105", at: 1_003 },
        { id: "X2", quantity: "1.5", price: "90", at: 1_004 },
      ],
    }), "120");
    expect(snapshot.positionExposure.exposureState).toBe("FLAT_ENTRY_ACTIVE");
    expect(snapshot).toMatchObject({
      openQuantity: "0", grossRealizedPnl: "-8.75", grossUnrealizedPnl: "0", grossTotalPnl: "-8.75",
    });
  });

  it("preserves CLOSED and makes total equal realized PnL", () => {
    const snapshot = projected(attempt({
      entryOrderStatus: "FILLED",
      entries: [{ id: "F1", quantity: "2.25", price: "110", at: 1_001 }],
      exits: [{ id: "X1", quantity: "2.25", price: "120", at: 1_003 }],
    }), "130");
    expect(snapshot.positionExposure.exposureState).toBe("CLOSED");
    expect(snapshot).toMatchObject({
      openQuantity: "0", grossRealizedPnl: "22.5", grossUnrealizedPnl: "0", grossTotalPnl: "22.5",
    });
  });

  it("uses exact mixed-scale addition and canonicalizes zero", () => {
    const nonZero = projected(attempt({
      entries: [{ id: "F1", quantity: "0.30", price: "1.2500", at: 1_001 }],
      exits: [{ id: "X1", quantity: "0.10", price: "2.5", at: 1_003 }],
      quantity: "0.30",
    }), "0.625", "2.4");
    expect(nonZero).toMatchObject({
      grossRealizedPnl: "0.3", grossUnrealizedPnl: "-0.3", grossTotalPnl: "0",
    });
    expect(nonZero.grossTotalPnl).not.toBe("-0");
  });
});

describe("delegation, rejection, provenance, and timestamps", () => {
  it("composes the same values from one canonical valuation while preserving every authoritative reference", () => {
    const source = attempt({
      entries: [{ id: "F1", quantity: "2.75", price: "100", at: 1_001 }],
      exits: [{ id: "X1", quantity: "1.25", price: "105", at: 1_003 }],
    });
    const accountingSpec = spec();
    const valuationMark = mark("110", 1_010);
    const valuation = projectUnrealizedTradeValuation(source, accountingSpec, valuationMark);
    const standalone = projectTradePerformanceSnapshot(source, accountingSpec, valuationMark);
    expect(valuation.status).toBe("UNREALIZED_VALUATION_PROJECTED");
    expect(standalone.status).toBe("TRADE_PERFORMANCE_PROJECTED");
    if (valuation.status !== "UNREALIZED_VALUATION_PROJECTED"
      || standalone.status !== "TRADE_PERFORMANCE_PROJECTED") return;

    const composed = projectTradePerformanceFromValuation(valuation.valuation);
    expect(composed.status).toBe("TRADE_PERFORMANCE_PROJECTED");
    if (composed.status !== "TRADE_PERFORMANCE_PROJECTED") return;
    expect(composed.snapshot).toEqual(standalone.snapshot);
    expect(composed.snapshot.unrealizedValuation).toBe(valuation.valuation);
    expect(composed.snapshot.realizedAccounting).toBe(valuation.valuation.realizedAccounting);
    expect(composed.snapshot.positionExposure).toBe(valuation.valuation.realizedAccounting.positionExposure);
  });

  it("rejects an incoherent forged canonical valuation without aggregation", () => {
    const valuation = projectUnrealizedTradeValuation(attempt({
      entries: [{ id: "F1", quantity: "1", price: "100", at: 1_001 }],
    }), spec(), mark("110"));
    if (valuation.status !== "UNREALIZED_VALUATION_PROJECTED") throw new Error("fixture valuation failed");
    const forged = Object.freeze({
      ...valuation.valuation,
      openQuantity: nonNegativeDecimalString("2"),
    });
    expect(projectTradePerformanceFromValuation(forged)).toEqual({
      status: "TRADE_PERFORMANCE_REJECTED",
      reason: "PERFORMANCE_AGGREGATION_INCOHERENT",
    });
  });

  it("matches Task028A authoritative values and preserves nested object identity", () => {
    const source = attempt({
      entries: [{ id: "F1", quantity: "2.75", price: "100", at: 1_001 }],
      exits: [{ id: "X1", quantity: "1.25", price: "105", at: 1_003 }],
    });
    const accountingSpec = spec();
    const valuationMark = mark("110", 1_010);
    const upstream = projectUnrealizedTradeValuation(source, accountingSpec, valuationMark);
    const performance = projectTradePerformanceSnapshot(source, accountingSpec, valuationMark);
    expect(upstream.status).toBe("UNREALIZED_VALUATION_PROJECTED");
    expect(performance.status).toBe("TRADE_PERFORMANCE_PROJECTED");
    if (upstream.status !== "UNREALIZED_VALUATION_PROJECTED" || performance.status !== "TRADE_PERFORMANCE_PROJECTED") return;
    expect(performance.snapshot.grossRealizedPnl).toBe(upstream.valuation.realizedAccounting.grossRealizedPnl);
    expect(performance.snapshot.grossUnrealizedPnl).toBe(upstream.valuation.grossUnrealizedPnl);
    expect(performance.snapshot.realizedAccounting).toBe(performance.snapshot.unrealizedValuation.realizedAccounting);
    expect(performance.snapshot.positionExposure).toBe(performance.snapshot.realizedAccounting.positionExposure);
    expect(performance.snapshot.accountingAsOf).toBe(performance.snapshot.unrealizedValuation.accountingAsOf);
    expect(performance.snapshot.valuationAsOf).toBe(performance.snapshot.unrealizedValuation.markAsOf);
  });

  it("preserves the exact Task028A instrument rejection", () => {
    const other = createInstrumentId({ venue: "TEST", venueSymbol: "OTHER", instrumentKind: "CFD" });
    const result = projectTradePerformanceSnapshot(attempt(), spec(), mark("100", 2_000, other));
    expect(result).toMatchObject({
      status: "TRADE_PERFORMANCE_REJECTED",
      reason: "UNREALIZED_VALUATION_REJECTED",
      valuationProjection: { reason: "VALUATION_MARK_INSTRUMENT_MISMATCH" },
    });
    if (result.status === "TRADE_PERFORMANCE_REJECTED") expect(Object.isFrozen(result.valuationProjection)).toBe(true);
  });

  it("preserves chronology and malformed-mark rejections", () => {
    const source = attempt({
      entries: [{ id: "F1", quantity: "1", price: "100", at: 1_001 }],
      exits: [{ id: "X1", quantity: "1", price: "105", at: 1_001 }],
    });
    expect(projectTradePerformanceSnapshot(source, spec(), mark("110"))).toMatchObject({
      valuationProjection: {
        reason: "REALIZED_ACCOUNTING_REJECTED",
        accountingProjection: { reason: "AMBIGUOUS_FILL_CHRONOLOGY" },
      },
    });
    const invalidMark = { ...mark("100"), markPrice: "bad" } as unknown as ValuationMark;
    expect(projectTradePerformanceSnapshot(attempt(), spec(), invalidMark)).toMatchObject({
      valuationProjection: { reason: "VALUATION_MARK_INVALID" },
    });
  });

  it("preserves nested Task027A and PositionExposure rejection objects", () => {
    const invalid = { ...attempt(), exitedQuantity: nonNegativeDecimalString("1") } as ExecutionAttempt;
    const result = projectTradePerformanceSnapshot(invalid, spec(), mark("100"));
    expect(result).toMatchObject({
      valuationProjection: {
        reason: "REALIZED_ACCOUNTING_REJECTED",
        accountingProjection: {
          reason: "POSITION_EXPOSURE_REJECTED",
          positionProjection: { reason: "EXIT_QUANTITY_EXCEEDS_ENTRY" },
        },
      },
    });
    if (result.status !== "TRADE_PERFORMANCE_REJECTED") return;
    const accountingProjection = result.valuationProjection?.accountingProjection;
    expect(Object.isFrozen(accountingProjection)).toBe(true);
    expect(Object.isFrozen(accountingProjection?.positionProjection)).toBe(true);
  });

  it("changes only valuation-dependent fields for a later valid mark", () => {
    const source = attempt({ entries: [{ id: "F1", quantity: "2", price: "100", at: 1_001 }] });
    const first = projected(source, "105", "1", 1_010);
    const second = projected(source, "110", "1", 1_020);
    expect(second.grossRealizedPnl).toBe(first.grossRealizedPnl);
    expect(second.realizedAccounting).toEqual(first.realizedAccounting);
    expect(second.grossUnrealizedPnl).toBe("20");
    expect(second.grossTotalPnl).toBe("20");
    expect(second.valuationAsOf).toBe(1_020);
  });
});

describe("immutability, determinism, and narrow public scope", () => {
  it("does not mutate any caller input and freezes all exposed authoritative levels", () => {
    const source = attempt({ entries: [{ id: "F1", quantity: "2", price: "100", at: 1_001 }] });
    const accountingSpec = spec();
    const valuationMark = mark("110");
    const before = [JSON.stringify(source), JSON.stringify(accountingSpec), JSON.stringify(valuationMark)];
    const result = projectTradePerformanceSnapshot(source, accountingSpec, valuationMark);
    expect([JSON.stringify(source), JSON.stringify(accountingSpec), JSON.stringify(valuationMark)]).toEqual(before);
    expect(result.status).toBe("TRADE_PERFORMANCE_PROJECTED");
    if (result.status !== "TRADE_PERFORMANCE_PROJECTED") return;
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.snapshot)).toBe(true);
    expect(Object.isFrozen(result.snapshot.unrealizedValuation)).toBe(true);
    expect(Object.isFrozen(result.snapshot.realizedAccounting)).toBe(true);
    expect(Object.isFrozen(result.snapshot.positionExposure)).toBe(true);
  });

  it("is deterministic across repeated calls and fresh engines", () => {
    const source = attempt({ entries: [{ id: "F1", quantity: "1", price: "100", at: 1_001 }] });
    const accountingSpec = spec();
    const valuationMark = mark("110");
    expect(projectTradePerformanceSnapshot(source, accountingSpec, valuationMark))
      .toEqual(projectTradePerformanceSnapshot(source, accountingSpec, valuationMark));
    expect(new TradePerformanceEngine().project(source, accountingSpec, valuationMark))
      .toEqual(new TradePerformanceEngine().project(source, accountingSpec, valuationMark));
  });

  it("accepts no caller authority fields and exposes no net, cost, analytics, portfolio, or account fields", () => {
    expect(projectTradePerformanceSnapshot.length).toBe(3);
    const serialized = JSON.stringify(projected(attempt(), "100")).toLowerCase();
    for (const prohibited of [
      "commission", "fee", "funding", "swap", "tax", "fx", "netpnl", "roi", "returnpercent",
      "profitfactor", "winrate", "drawdown", "sharpe", "sortino", "mfe", "mae", "portfolio",
      "accountequity", "nav", "snapshotcreatedat", "generatedat", "processedat",
    ]) expect(serialized).not.toContain(prohibited);
  });
});
