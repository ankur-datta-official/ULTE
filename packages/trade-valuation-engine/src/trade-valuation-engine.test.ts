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
  createInstrumentId,
  nonNegativeDecimalString,
  positiveDecimalString,
  unixMs,
  type DecimalString,
} from "@ulte/instrument-model";
import { createLinearInstrumentSizingSpec } from "@ulte/position-sizing-engine";
import {
  TradeValuationEngine,
  createValuationMark,
  projectUnrealizedTradeValuation,
  type ValuationMark,
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
    schemaVersion: "EXECUTION_ATTEMPT_V2",
    executionAttemptId: "attempt-1",
    executionPlanId: "plan-1",
    tradeIntentId: "intent-1",
    candidateId: "candidate-1",
    instrumentId: instrument,
    preparedAsOf: unixMs(900),
    entrySide,
    exitSide,
    quantity: positiveDecimalString(fixture.quantity ?? (filled === "0" ? "10" : filled)),
    quantityUnit: "contracts",
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

function valued(source: ExecutionAttempt, price: string, multiplier = "1", at = 2_000) {
  const result = projectUnrealizedTradeValuation(source, spec(multiplier), mark(price, at));
  expect(result.status).toBe("UNREALIZED_VALUATION_PROJECTED");
  if (result.status !== "UNREALIZED_VALUATION_PROJECTED") throw new Error(result.reason);
  return result.valuation;
}

describe("authoritative FIFO open-basis valuation", () => {
  it("projects fresh NO_EXPOSURE as exact zero", () => {
    const output = valued(attempt(), "110");
    expect(output).toMatchObject({ openQuantity: "0", grossUnrealizedPnl: "0", openLotValuations: [] });
    expect(output.realizedAccounting.positionExposure.exposureState).toBe("NO_EXPOSURE");
  });

  it.each([
    ["BUY", "110", "LONG", "20"],
    ["BUY", "90", "LONG", "-20"],
    ["SELL", "90", "SHORT", "20"],
    ["SELL", "110", "SHORT", "-20"],
  ] as const)("values %s entry at mark %s as %s %s", (entrySide, price, direction, expected) => {
    const output = valued(attempt({
      entrySide,
      entries: [{ id: "F1", quantity: "2", price: "100", at: 1_001 }],
    }), price);
    expect(output.direction).toBe(direction);
    expect(output.grossUnrealizedPnl).toBe(expected);
    expect(output.openLotValuations[0]).toMatchObject({
      entryFillId: "F1", remainingQuantity: "2", grossUnrealizedPnl: expected,
    });
  });

  it("values only residual basis after a partial exit", () => {
    const output = valued(attempt({
      entries: [{ id: "F1", quantity: "3", price: "100", at: 1_001 }],
      exits: [{ id: "X1", quantity: "1.25", price: "105", at: 1_003 }],
    }), "110");
    expect(output.openQuantity).toBe("1.75");
    expect(output.grossUnrealizedPnl).toBe("17.5");
    expect(output.openLotValuations).toEqual([expect.objectContaining({ remainingQuantity: "1.75" })]);
    expect(output.realizedAccounting.grossRealizedPnl).toBe("6.25");
  });

  it("values multiple FIFO lots independently without averaging", () => {
    const output = valued(attempt({
      entries: [
        { id: "F1", quantity: "2", price: "100", at: 1_001 },
        { id: "F2", quantity: "1", price: "110", at: 1_002 },
      ],
    }), "120");
    expect(output.openLotValuations).toEqual([
      expect.objectContaining({ entryFillId: "F1", entryPrice: "100", grossUnrealizedPnl: "40" }),
      expect.objectContaining({ entryFillId: "F2", entryPrice: "110", grossUnrealizedPnl: "10" }),
    ]);
    expect(output.grossUnrealizedPnl).toBe("50");
  });

  it("uses exact mixed-scale arithmetic, non-unit multipliers, canonical zero, and never negative zero", () => {
    const profit = valued(attempt({
      entries: [{ id: "F1", quantity: "0.30", price: "1.2500", at: 1_001 }],
    }), "2.5", "2.4");
    expect(profit.grossUnrealizedPnl).toBe("0.9");

    const zero = valued(attempt({
      entries: [{ id: "F1", quantity: "0.30", price: "1.2500", at: 1_001 }],
    }), "1.250", "2.4");
    expect(zero.grossUnrealizedPnl).toBe("0");
    expect(zero.grossUnrealizedPnl).not.toBe("-0");
  });

  it("keeps flat-active and closed exposure at zero and lets only a later entry form fresh basis", () => {
    const flat = attempt({
      quantity: "5",
      entries: [{ id: "F1", quantity: "2.75", price: "100", at: 1_001 }],
      exits: [{ id: "X1", quantity: "2.75", price: "105", at: 1_003 }],
    });
    const flatValue = valued(flat, "120");
    expect(flatValue.realizedAccounting.positionExposure.exposureState).toBe("FLAT_ENTRY_ACTIVE");
    expect(flatValue).toMatchObject({ openQuantity: "0", grossUnrealizedPnl: "0", openLotValuations: [] });

    const later = attempt({
      quantity: "5",
      entries: [
        { id: "F1", quantity: "2.75", price: "100", at: 1_001 },
        { id: "F2", quantity: "2.25", price: "110", at: 1_004 },
      ],
      exits: [{ id: "X1", quantity: "2.75", price: "105", at: 1_003 }],
    });
    const laterValue = valued(later, "120");
    expect(laterValue.grossUnrealizedPnl).toBe("22.5");
    expect(laterValue.openLotValuations).toEqual([expect.objectContaining({ entryFillId: "F2" })]);

    const closed = attempt({
      entryOrderStatus: "FILLED",
      entries: [{ id: "F1", quantity: "2", price: "100", at: 1_001 }],
      exits: [{ id: "X1", quantity: "2", price: "110", at: 1_003 }],
    });
    const closedValue = valued(closed, "120");
    expect(closedValue.realizedAccounting.positionExposure.exposureState).toBe("CLOSED");
    expect(closedValue).toMatchObject({ openQuantity: "0", grossUnrealizedPnl: "0", openLotValuations: [] });
  });
});

describe("mark and accounting trust boundaries", () => {
  it("creates a frozen canonical mark and rejects malformed local mark fields", () => {
    const canonical = mark("100");
    expect(canonical).toEqual({
      schemaVersion: "VALUATION_MARK_V1", instrumentId: instrument, markPrice: "100", markAsOf: 2_000,
    });
    expect(Object.isFrozen(canonical)).toBe(true);
    expect(() => createValuationMark({ instrumentId: instrument, markPrice: "0", markAsOf: 2_000 })).toThrow();

    const source = attempt();
    const badSchema = { ...canonical, schemaVersion: "OTHER" } as unknown as ValuationMark;
    const badPrice = { ...canonical, markPrice: "nope" } as unknown as ValuationMark;
    expect(projectUnrealizedTradeValuation(source, spec(), badSchema)).toMatchObject({ reason: "VALUATION_MARK_INVALID" });
    expect(projectUnrealizedTradeValuation(source, spec(), badPrice)).toMatchObject({ reason: "VALUATION_MARK_INVALID" });
  });

  it("rejects mark instrument mismatch and marks preceding accounting while allowing equality", () => {
    const source = attempt({ entries: [{ id: "F1", quantity: "1", price: "100", at: 1_001 }] });
    const other = createInstrumentId({ venue: "TEST", venueSymbol: "OTHER", instrumentKind: "CFD" });
    expect(projectUnrealizedTradeValuation(source, spec(), mark("110", 2_000, other))).toMatchObject({
      reason: "VALUATION_MARK_INSTRUMENT_MISMATCH",
    });
    expect(projectUnrealizedTradeValuation(source, spec(), mark("110", 1_000))).toMatchObject({
      reason: "VALUATION_MARK_PRECEDES_ACCOUNTING",
    });
    expect(valued(source, "110", "1", 1_001).grossUnrealizedPnl).toBe("10");
  });

  it("preserves the exact Task027A rejection and its nested position rejection", () => {
    const invalid = { ...attempt(), exitedQuantity: nonNegativeDecimalString("1") } as ExecutionAttempt;
    const result = projectUnrealizedTradeValuation(invalid, spec(), mark("100"));
    expect(result).toMatchObject({
      status: "UNREALIZED_VALUATION_REJECTED",
      reason: "REALIZED_ACCOUNTING_REJECTED",
      accountingProjection: {
        status: "REALIZED_ACCOUNTING_REJECTED",
        reason: "POSITION_EXPOSURE_REJECTED",
        positionProjection: { reason: "EXIT_QUANTITY_EXCEEDS_ENTRY" },
      },
    });
    if (result.status === "UNREALIZED_VALUATION_REJECTED") {
      expect(Object.isFrozen(result.accountingProjection)).toBe(true);
      expect(Object.isFrozen(result.accountingProjection?.positionProjection)).toBe(true);
    }
  });
});

describe("purity, immutability, determinism, and narrow output", () => {
  it("does not mutate attempt, accounting input, or mark and deeply freezes new output", () => {
    const source = attempt({ entries: [{ id: "F1", quantity: "2", price: "100", at: 1_001 }] });
    const accountingSpec = spec();
    const valuationMark = mark("110");
    const before = [JSON.stringify(source), JSON.stringify(accountingSpec), JSON.stringify(valuationMark)];
    const result = projectUnrealizedTradeValuation(source, accountingSpec, valuationMark);
    expect([JSON.stringify(source), JSON.stringify(accountingSpec), JSON.stringify(valuationMark)]).toEqual(before);
    expect(result.status).toBe("UNREALIZED_VALUATION_PROJECTED");
    if (result.status !== "UNREALIZED_VALUATION_PROJECTED") return;
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.valuation)).toBe(true);
    expect(Object.isFrozen(result.valuation.openLotValuations)).toBe(true);
    expect(Object.isFrozen(result.valuation.openLotValuations[0])).toBe(true);
    expect(Object.isFrozen(result.valuation.realizedAccounting)).toBe(true);
  });

  it("is deterministic across repeated calls and fresh engines", () => {
    const source = attempt({ entries: [{ id: "F1", quantity: "1", price: "100", at: 1_001 }] });
    const accountingSpec = spec();
    const valuationMark = mark("110");
    expect(projectUnrealizedTradeValuation(source, accountingSpec, valuationMark))
      .toEqual(projectUnrealizedTradeValuation(source, accountingSpec, valuationMark));
    expect(new TradeValuationEngine().project(source, accountingSpec, valuationMark))
      .toEqual(new TradeValuationEngine().project(source, accountingSpec, valuationMark));
  });

  it("exposes no average, combined/net PnL, costs, FX, margin, or portfolio fields", () => {
    const serialized = JSON.stringify(valued(attempt(), "100"));
    for (const prohibited of [
      "averageEntryPrice", "averageOpenPrice", "averageCostBasis", "totalPnl", "netPnl", "fee",
      "commission", "funding", "swap", "tax", "fxConversion", "margin", "leverage", "liquidation", "portfolio",
    ]) expect(serialized).not.toContain(prohibited);
  });
});
