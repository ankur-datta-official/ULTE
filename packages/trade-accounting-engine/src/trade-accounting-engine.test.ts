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
import { TradeAccountingEngine, projectRealizedTradeAccounting } from "./index.js";

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

function accounting(source: ExecutionAttempt, multiplier = "1") {
  const result = projectRealizedTradeAccounting(source, spec(multiplier));
  expect(result.status).toBe("REALIZED_ACCOUNTING_PROJECTED");
  if (result.status !== "REALIZED_ACCOUNTING_PROJECTED") throw new Error(result.reason);
  return result.accounting;
}

describe("realized FIFO accounting", () => {
  it("projects fresh zero-fill and entry-only snapshots", () => {
    const zero = accounting(attempt());
    expect(zero).toMatchObject({ grossRealizedPnl: "0", openQuantity: "0", realizedMatches: [], openBasisLots: [] });
    expect(zero.positionExposure.exposureState).toBe("NO_EXPOSURE");

    const open = accounting(attempt({ entries: [{ id: "F1", quantity: "2", price: "100", at: 1_001 }] }));
    expect(open.grossRealizedPnl).toBe("0");
    expect(open.realizedMatches).toEqual([]);
    expect(open.openBasisLots).toEqual([expect.objectContaining({ entryFillId: "F1", remainingQuantity: "2" })]);
  });

  it.each([
    ["BUY", "120", "40"],
    ["BUY", "90", "-20"],
    ["SELL", "90", "20"],
    ["SELL", "110", "-20"],
  ] as const)("calculates %s entry at exit %s as %s", (entrySide, exitPrice, expected) => {
    const result = accounting(attempt({
      entrySide,
      entryOrderStatus: "FILLED",
      entries: [{ id: "F1", quantity: "2", price: "100", at: 1_001 }],
      exits: [{ id: "X1", quantity: "2", price: exitPrice, at: 1_003 }],
    }));
    expect(result.grossRealizedPnl).toBe(expected);
    expect(result.openBasisLots).toEqual([]);
    expect(result.positionExposure.exposureState).toBe("CLOSED");
  });

  it("partially and exactly consumes a single entry lot", () => {
    const partial = accounting(attempt({
      entries: [{ id: "F1", quantity: "3", price: "100", at: 1_001 }],
      exits: [{ id: "X1", quantity: "1.25", price: "120", at: 1_003 }],
    }));
    expect(partial.realizedMatches[0]).toMatchObject({ matchedQuantity: "1.25", grossRealizedPnl: "25" });
    expect(partial.openBasisLots[0]).toMatchObject({ originalQuantity: "3", remainingQuantity: "1.75" });
    expect(partial.openQuantity).toBe(partial.positionExposure.openQuantity);

    const exact = accounting(attempt({
      entries: [
        { id: "F1", quantity: "1", price: "100", at: 1_001 },
        { id: "F2", quantity: "2", price: "110", at: 1_002 },
      ],
      exits: [{ id: "X1", quantity: "1", price: "120", at: 1_003 }],
    }));
    expect(exact.realizedMatches).toHaveLength(1);
    expect(exact.openBasisLots).toEqual([expect.objectContaining({ entryFillId: "F2", remainingQuantity: "2" })]);
  });

  it("spans multiple FIFO lots without weighted-average costing", () => {
    const result = accounting(attempt({
      entries: [
        { id: "F1", quantity: "2", price: "100", at: 1_001 },
        { id: "F2", quantity: "3", price: "110", at: 1_002 },
      ],
      exits: [{ id: "X1", quantity: "4", price: "120", at: 1_003 }],
    }));
    expect(result.grossRealizedPnl).toBe("60");
    expect(result.realizedMatches).toEqual([
      expect.objectContaining({ entryFillId: "F1", matchedQuantity: "2", grossRealizedPnl: "40" }),
      expect.objectContaining({ entryFillId: "F2", matchedQuantity: "2", grossRealizedPnl: "20" }),
    ]);
    expect(result.openBasisLots).toEqual([expect.objectContaining({ entryFillId: "F2", remainingQuantity: "1", entryPrice: "110" })]);
  });

  it("applies a non-unit multiplier with exact mixed-scale decimal arithmetic", () => {
    const result = accounting(attempt({
      entries: [{ id: "F1", quantity: "0.3", price: "1.2500", at: 1_001 }],
      exits: [{ id: "X1", quantity: "0.2", price: "2.5", at: 1_003 }],
      quantity: "0.3",
    }), "2.4");
    expect(result.grossRealizedPnl).toBe("0.6");
    expect(result.openBasisLots[0]?.remainingQuantity).toBe("0.1");
  });

  it("resets FIFO basis after an early full-current exit and retains realized PnL", () => {
    const result = accounting(attempt({
      quantity: "10",
      entries: [
        { id: "F1", quantity: "2.75", price: "100", at: 1_001 },
        { id: "F2", quantity: "1.25", price: "110", at: 1_004 },
      ],
      exits: [{ id: "X1", quantity: "2.75", price: "90", at: 1_003 }],
    }));
    expect(result.grossRealizedPnl).toBe("-27.5");
    expect(result.openBasisLots).toEqual([expect.objectContaining({
      entryFillId: "F2", entryPrice: "110", originalQuantity: "1.25", remainingQuantity: "1.25",
    })]);
  });

  it("accumulates multiple exits and canonicalizes a zero PnL", () => {
    const result = accounting(attempt({
      entryOrderStatus: "FILLED",
      entries: [{ id: "F1", quantity: "2", price: "100", at: 1_001 }],
      exits: [
        { id: "X1", quantity: "1", price: "90", at: 1_003 },
        { id: "X2", quantity: "1", price: "110", at: 1_004 },
      ],
    }));
    expect(result.realizedMatches).toHaveLength(2);
    expect(result.grossRealizedPnl).toBe("0");
    expect(result.grossRealizedPnl).not.toBe("-0");
    expect(result.openBasisLots).toEqual([]);
  });
});

describe("fail-closed provenance and coherence", () => {
  it("rejects forged entry and exit history totals", () => {
    const source = attempt({
      entries: [{ id: "F1", quantity: "2", price: "100", at: 1_001 }],
      exits: [{ id: "X1", quantity: "1", price: "110", at: 1_003 }],
    });
    const forgedEntry = { ...source, processedFills: [] } as unknown as ExecutionAttempt;
    const forgedExit = { ...source, processedExitFills: [] } as unknown as ExecutionAttempt;
    expect(projectRealizedTradeAccounting(forgedEntry, spec())).toMatchObject({ reason: "ENTRY_FILL_HISTORY_INCOHERENT" });
    expect(projectRealizedTradeAccounting(forgedExit, spec())).toMatchObject({ reason: "EXIT_FILL_HISTORY_INCOHERENT" });
  });

  it("rejects an exit before sufficient basis and equal-time cross-kind ambiguity", () => {
    const earlyExit = attempt({
      entries: [{ id: "F1", quantity: "1", price: "100", at: 1_002 }],
      exits: [{ id: "X1", quantity: "1", price: "110", at: 1_001 }],
    });
    expect(projectRealizedTradeAccounting(earlyExit, spec())).toMatchObject({ reason: "EXIT_WITHOUT_AVAILABLE_BASIS" });

    const ambiguous = attempt({
      entries: [{ id: "F1", quantity: "1", price: "100", at: 1_001 }],
      exits: [{ id: "X1", quantity: "1", price: "110", at: 1_001 }],
    });
    expect(projectRealizedTradeAccounting(ambiguous, spec())).toMatchObject({ reason: "AMBIGUOUS_FILL_CHRONOLOGY" });
  });

  it("rejects duplicate fill identity and valuation instrument mismatch", () => {
    const duplicate = attempt({
      entries: [{ id: "SAME", quantity: "1", price: "100", at: 1_001 }],
      exits: [{ id: "SAME", quantity: "1", price: "110", at: 1_003 }],
    });
    expect(projectRealizedTradeAccounting(duplicate, spec())).toMatchObject({ reason: "DUPLICATE_FILL_ID" });
    const other = createInstrumentId({ venue: "TEST", venueSymbol: "OTHER", instrumentKind: "CFD" });
    expect(projectRealizedTradeAccounting(attempt(), spec("1", other))).toMatchObject({
      reason: "VALUATION_SPEC_INSTRUMENT_MISMATCH",
    });
  });

  it("preserves authoritative position rejection, including unsupported schema", () => {
    const invalid = { ...attempt(), exitedQuantity: nonNegativeDecimalString("1") } as ExecutionAttempt;
    const result = projectRealizedTradeAccounting(invalid, spec());
    expect(result).toMatchObject({
      reason: "POSITION_EXPOSURE_REJECTED",
      positionProjection: { status: "POSITION_EXPOSURE_REJECTED", reason: "EXIT_QUANTITY_EXCEEDS_ENTRY" },
    });
    const old = { ...attempt(), schemaVersion: "EXECUTION_ATTEMPT_V1" } as unknown as ExecutionAttempt;
    expect(projectRealizedTradeAccounting(old, spec())).toMatchObject({
      reason: "POSITION_EXPOSURE_REJECTED",
      positionProjection: { reason: "EXECUTION_SCHEMA_UNSUPPORTED" },
    });
  });
});

describe("purity, immutability, and narrow output", () => {
  it("does not mutate the attempt, nested histories, or valuation spec", () => {
    const source = attempt({
      entries: [{ id: "F1", quantity: "2", price: "100", at: 1_001 }],
      exits: [{ id: "X1", quantity: "1", price: "110", at: 1_003 }],
    });
    const valuation = spec();
    const beforeAttempt = JSON.stringify(source);
    const beforeEntries = JSON.stringify(source.processedFills);
    const beforeExits = JSON.stringify(source.processedExitFills);
    const beforeSpec = JSON.stringify(valuation);
    projectRealizedTradeAccounting(source, valuation);
    expect(JSON.stringify(source)).toBe(beforeAttempt);
    expect(JSON.stringify(source.processedFills)).toBe(beforeEntries);
    expect(JSON.stringify(source.processedExitFills)).toBe(beforeExits);
    expect(JSON.stringify(valuation)).toBe(beforeSpec);
  });

  it("deep-freezes output records and arrays", () => {
    const result = projectRealizedTradeAccounting(attempt({
      entries: [{ id: "F1", quantity: "2", price: "100", at: 1_001 }],
      exits: [{ id: "X1", quantity: "1", price: "110", at: 1_003 }],
    }), spec());
    expect(result.status).toBe("REALIZED_ACCOUNTING_PROJECTED");
    if (result.status !== "REALIZED_ACCOUNTING_PROJECTED") return;
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.accounting)).toBe(true);
    expect(Object.isFrozen(result.accounting.realizedMatches)).toBe(true);
    expect(Object.isFrozen(result.accounting.realizedMatches[0])).toBe(true);
    expect(Object.isFrozen(result.accounting.openBasisLots)).toBe(true);
    expect(Object.isFrozen(result.accounting.openBasisLots[0])).toBe(true);
  });

  it("is deterministic across calls and fresh engine instances", () => {
    const source = attempt({ entries: [{ id: "F1", quantity: "1", price: "100", at: 1_001 }] });
    expect(projectRealizedTradeAccounting(source, spec())).toEqual(projectRealizedTradeAccounting(source, spec()));
    expect(new TradeAccountingEngine().project(source, spec())).toEqual(new TradeAccountingEngine().project(source, spec()));
  });

  it("exposes gross realized accounting only", () => {
    const output = accounting(attempt());
    const serialized = JSON.stringify(output);
    for (const prohibited of [
      "averageEntryPrice", "averageExitPrice", "unrealized", "netPnl", "fee", "commission",
      "funding", "swap", "tax", "fxConversion", "margin", "leverage", "portfolio",
    ]) expect(serialized).not.toContain(prohibited);
  });
});
