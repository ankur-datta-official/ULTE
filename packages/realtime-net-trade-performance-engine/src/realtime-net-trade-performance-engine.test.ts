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
import type {
  RealtimeTradeCostAccountingProjectedResult,
  RealtimeTradeCostAccountingResult,
} from "@ulte/realtime-trade-cost-accounting-engine";
import type {
  RealtimeTradePerformanceResult,
  TradePerformanceProjectedRealtimeResult,
} from "@ulte/realtime-trade-performance-engine";
import {
  createTradeCostEvent,
  projectTradeCostAccounting,
  type TradeCostEventInput,
} from "@ulte/trade-cost-accounting-engine";
import { projectTradePerformanceSnapshot } from "@ulte/trade-performance-engine";
import { createValuationMark } from "@ulte/trade-valuation-engine";
import {
  projectRealtimeNetTradePerformance,
  RealtimeNetTradePerformanceEngine,
} from "./index.js";

const instrument = createInstrumentId({ venue: "TEST", venueSymbol: "NET-RT", instrumentKind: "CFD" });
const otherInstrument = createInstrumentId({ venue: "TEST", venueSymbol: "OTHER", instrumentKind: "CFD" });

interface FillFixture { readonly id: string; readonly quantity: string; readonly price: string; readonly at: number }
interface AttemptFixture {
  readonly entries: readonly FillFixture[];
  readonly exits?: readonly FillFixture[];
  readonly entrySide?: "BUY" | "SELL";
  readonly entryOrderStatus?: ExecutionAttempt["entryOrderStatus"];
  readonly requestedQuantity?: string;
}

function total(fills: readonly FillFixture[]): DecimalString {
  return fills.reduce<DecimalString>(
    (sum, fill) => addDecimal(sum, positiveDecimalString(fill.quantity)),
    nonNegativeDecimalString("0"),
  );
}

function attempt(fixture: AttemptFixture): ExecutionAttempt {
  const exits = fixture.exits ?? [];
  const filled = nonNegativeDecimalString(total(fixture.entries));
  const exited = nonNegativeDecimalString(total(exits));
  const open = subtractNonNegative(filled, exited);
  const entrySide = fixture.entrySide ?? "BUY";
  const exitSide = entrySide === "BUY" ? "SELL" : "BUY";
  const entryOrderStatus = fixture.entryOrderStatus ?? "FILLED";
  const processedFills: readonly FillEvent[] = Object.freeze(fixture.entries.map((fill) => createFillEvent({
    executionAttemptId: "attempt-rt-net", adapterOrderId: "ORDER-1", fillId: fill.id,
    filledQuantity: fill.quantity, fillPrice: fill.price, filledAt: fill.at,
  })));
  const processedExitFills: readonly ExitFillEvent[] = Object.freeze(exits.map((fill) => createExitFillEvent({
    executionAttemptId: "attempt-rt-net", protectionRequestId: "PROTECT-1", exitSide,
    exitLeg: "PROFIT_TARGET", fillId: fill.id, filledQuantity: fill.quantity,
    fillPrice: fill.price, filledAt: fill.at,
  })));
  const hasExit = exited !== "0";
  const closed = hasExit && open === "0" && entryOrderStatus !== "WORKING";
  const state: ExecutionAttempt["state"] = closed ? "EXIT_FILLED" : hasExit
    ? "EXIT_PARTIALLY_FILLED" : entryOrderStatus === "FILLED" ? "ENTRY_FILLED" : "ENTRY_PARTIALLY_FILLED";
  const protectedQuantity = hasExit ? filled : nonNegativeDecimalString("0");
  const latestAt = [...fixture.entries, ...exits].reduce((latest, fill) => Math.max(latest, fill.at), 900);
  return Object.freeze({
    status: "EXECUTION_ATTEMPT_READY", schemaVersion: "EXECUTION_ATTEMPT_V3",
    executionAttemptId: "attempt-rt-net", executionPlanId: "plan-rt-net",
    tradeIntentId: "intent-rt-net", candidateId: "candidate-rt-net", instrumentId: instrument,
    preparedAsOf: unixMs(900), entrySide, exitSide,
    quantity: positiveDecimalString(fixture.requestedQuantity ?? filled), quantityUnit: "contracts", accountCurrency: currencyCode("USD"),
    entryPrice: positiveDecimalString("100"),
    stopTriggerPrice: positiveDecimalString(entrySide === "BUY" ? "90" : "110"),
    targetPrice: positiveDecimalString(entrySide === "BUY" ? "130" : "70"),
    approvedRiskAmount: positiveDecimalString("100"), actualRiskAmount: positiveDecimalString("100"),
    netRewardRiskBps: "30000", state, entryOrderStatus,
    submissionIdempotencyKey: "entry-key", protectionMode: "MANAGED_PROTECTION",
    adapterOrderId: "ORDER-1", filledEntryQuantity: filled, protectedQuantity,
    exitedQuantity: exited, unprotectedFilledQuantity: subtractNonNegative(filled, protectedQuantity),
    lastFillPrice: positiveDecimalString(fixture.entries.at(-1)?.price ?? "100"),
    processedFills, processedExitFills, acknowledgedProtections: Object.freeze([]),
    lastExecutionEventAt: unixMs(latestAt),
  });
}

const spec = createLinearInstrumentSizingSpec({
  valuationModel: "LINEAR_PRICE_PNL", instrumentId: instrument, pnlCurrency: "USD",
  quantityUnit: "contracts", quantityStep: "0.01", minimumQuantity: "0.01",
  maximumQuantity: "100", pnlValuePerPriceUnitPerQuantity: "1",
});

function gross(
  source: ExecutionAttempt,
  price: string,
  markAsOf: number,
  upstreamStatus: TradePerformanceProjectedRealtimeResult["upstreamStatus"] = "FILL_APPLIED",
  sourceKind: TradePerformanceProjectedRealtimeResult["sourceKind"] = "ENTRY_FILL",
): TradePerformanceProjectedRealtimeResult {
  const projected = projectTradePerformanceSnapshot(
    source, spec, createValuationMark({ instrumentId: instrument, markPrice: price, markAsOf }),
  );
  if (projected.status !== "TRADE_PERFORMANCE_PROJECTED") throw new Error(projected.reason);
  return Object.freeze({
    status: "TRADE_PERFORMANCE_PROJECTED", sourceKind, upstreamStatus, markPolicy: "LAST_TRADE_V1",
    snapshot: projected.snapshot, realtimeValuation: Object.freeze({}) as never,
  });
}

function costs(
  source: ExecutionAttempt,
  amounts: readonly Partial<TradeCostEventInput>[] = [{ amount: "1.25" }],
  upstreamStatus: RealtimeTradeCostAccountingProjectedResult["upstreamStatus"] = "FILL_APPLIED",
  sourceKind: RealtimeTradeCostAccountingProjectedResult["sourceKind"] = "ENTRY_FILL",
): RealtimeTradeCostAccountingProjectedResult {
  const events = amounts.map((item, index) => createTradeCostEvent({
    costEventId: `C${index + 1}`, executionAttemptId: source.executionAttemptId,
    instrumentId: instrument, costType: "COMMISSION", effect: "DEBIT", amount: "1.25",
    currency: "USD", effectiveAt: 1_001 + index, source: "TEST", ...item,
  }));
  const projected = projectTradeCostAccounting(source, spec, events);
  if (projected.status !== "TRADE_COST_ACCOUNTING_PROJECTED") throw new Error(projected.reason);
  return Object.freeze({
    status: "TRADE_COST_ACCOUNTING_PROJECTED", sourceKind, upstreamStatus,
    observedDeliveryCount: events.length, uniqueCostEventCount: events.length,
    duplicateDeliveryCount: 0, accounting: projected.accounting,
  });
}

const openAttempt = () => attempt({ entries: [{ id: "E1", quantity: "2.75", price: "100", at: 1_001 }] });

function noGross(status: "FILL_REJECTED" | "NO_FILL_PROCESSING" = "FILL_REJECTED"): RealtimeTradePerformanceResult {
  return Object.freeze({ status: "NO_PERFORMANCE_PROJECTION", sourceKind: "ENTRY_FILL", upstreamStatus: status });
}

function noCost(status: "FILL_REJECTED" | "NO_FILL_PROCESSING" = "FILL_REJECTED"): RealtimeTradeCostAccountingResult {
  return Object.freeze({ status: "NO_COST_ACCOUNTING_PROJECTION", sourceKind: "ENTRY_FILL", upstreamStatus: status });
}

describe("realtime authority gating", () => {
  it("returns no projection only for matching no-authority provenance", () => {
    expect(projectRealtimeNetTradePerformance(noGross(), noCost())).toEqual({
      status: "NO_NET_TRADE_PERFORMANCE_PROJECTION", sourceKind: "ENTRY_FILL",
      grossUpstreamStatus: "FILL_REJECTED", costUpstreamStatus: "FILL_REJECTED",
    });
    expect(projectRealtimeNetTradePerformance(noGross(), noCost("NO_FILL_PROCESSING"))).toMatchObject({
      status: "NET_TRADE_PERFORMANCE_REJECTED", reason: "REALTIME_PROJECTION_STATE_INCOHERENT",
    });
  });

  it("fails closed on source-kind and mixed projection-state mismatches", () => {
    const source = openAttempt();
    expect(projectRealtimeNetTradePerformance(gross(source, "105", 2_000), costs(source, [], "EXIT_FILL_APPLIED", "EXIT_FILL"))).toMatchObject({
      status: "NET_TRADE_PERFORMANCE_REJECTED", reason: "REALTIME_SOURCE_KIND_INCOHERENT",
    });
    expect(projectRealtimeNetTradePerformance(noGross(), costs(source))).toMatchObject({
      reason: "REALTIME_PROJECTION_STATE_INCOHERENT",
    });
    expect(projectRealtimeNetTradePerformance(gross(source, "105", 2_000), noCost())).toMatchObject({
      reason: "REALTIME_PROJECTION_STATE_INCOHERENT",
    });
  });

  it("preserves gross and cost rejections with deterministic gross-first precedence", () => {
    const source = openAttempt();
    const grossRejected = Object.freeze({
      ...gross(source, "105", 2_000), status: "TRADE_PERFORMANCE_REJECTED" as const,
      reason: "TRADE_PERFORMANCE_AGGREGATION_REJECTED" as const,
      performanceProjection: Object.freeze({ status: "TRADE_PERFORMANCE_REJECTED", reason: "VALUATION_REJECTED" }),
    }) as RealtimeTradePerformanceResult;
    const costRejected = Object.freeze({
      ...costs(source), status: "TRADE_COST_ACCOUNTING_REJECTED" as const,
      reason: "CONFLICTING_DUPLICATE_COST_EVENT_ID" as const,
    }) as RealtimeTradeCostAccountingResult;
    const grossOnly = projectRealtimeNetTradePerformance(grossRejected, costs(source));
    expect(grossOnly).toMatchObject({ reason: "REALTIME_GROSS_PERFORMANCE_REJECTED" });
    expect(grossOnly).toHaveProperty("grossPerformanceResult", grossRejected);
    const costOnly = projectRealtimeNetTradePerformance(gross(source, "105", 2_000), costRejected);
    expect(costOnly).toMatchObject({ reason: "REALTIME_COST_ACCOUNTING_REJECTED" });
    expect(costOnly).toHaveProperty("costAccountingResult", costRejected);
    expect(projectRealtimeNetTradePerformance(grossRejected, costRejected)).toMatchObject({
      reason: "REALTIME_GROSS_PERFORMANCE_REJECTED", grossPerformanceResult: grossRejected,
    });
  });
});

describe("authoritative net composition", () => {
  it("delegates open and independently updated gross/cost authorities", () => {
    const source = openAttempt();
    const gross105 = gross(source, "105", 2_000);
    const gross110 = gross(source, "110", 2_010);
    const cost125 = costs(source);
    const cost075 = costs(source, [
      { costEventId: "D1", amount: "1.25" },
      { costEventId: "CREDIT", costType: "FUNDING", effect: "CREDIT", amount: "0.50", effectiveAt: 1_002 },
    ]);
    expect(projectRealtimeNetTradePerformance(gross105, cost125)).toMatchObject({ snapshot: { netTotalPnl: "12.5" } });
    expect(projectRealtimeNetTradePerformance(gross105, cost075)).toMatchObject({ snapshot: { netTotalPnl: "13" } });
    expect(projectRealtimeNetTradePerformance(gross110, cost125)).toMatchObject({ snapshot: { netTotalPnl: "26.25" } });
    expect(projectRealtimeNetTradePerformance(gross110, cost075)).toMatchObject({ snapshot: { netTotalPnl: "26.75" } });
  });

  it("covers partial, flat-entry-active, closed, late cost, and separate clocks", () => {
    const partial = attempt({
      entries: [{ id: "E1", quantity: "2.75", price: "100", at: 1_001 }],
      exits: [{ id: "X1", quantity: "1.25", price: "105", at: 1_003 }],
    });
    const partialResult = projectRealtimeNetTradePerformance(
      gross(partial, "110", 1_004, "EXIT_FILL_APPLIED", "EXIT_FILL"),
      costs(partial, [
        { costEventId: "D1", amount: "1.25" },
        { costEventId: "C1", effect: "CREDIT", amount: "0.50" },
        { costEventId: "D2", amount: "0.40" },
      ], "EXIT_FILL_APPLIED", "EXIT_FILL"),
    );
    expect(partialResult).toMatchObject({ snapshot: { netTotalPnl: "20.1", positionExposure: { exposureState: "PARTIALLY_EXITED" } } });

    const flat = attempt({
      entries: [{ id: "E1", quantity: "1", price: "100", at: 1_001 }],
      exits: [{ id: "X1", quantity: "1", price: "91.25", at: 1_003 }],
      entryOrderStatus: "WORKING", requestedQuantity: "2",
    });
    expect(projectRealtimeNetTradePerformance(
      gross(flat, "105", 1_003, "EXIT_FILL_APPLIED", "EXIT_FILL"),
      costs(flat, undefined, "EXIT_FILL_APPLIED", "EXIT_FILL"),
    )).toMatchObject({ snapshot: { netTotalPnl: "-10", positionExposure: { exposureState: "FLAT_ENTRY_ACTIVE" } } });

    const closed = attempt({
      entries: [{ id: "E1", quantity: "2.75", price: "100", at: 1_001 }],
      exits: [
        { id: "X1", quantity: "1.25", price: "105", at: 1_003 },
        { id: "X2", quantity: "1.5", price: "105", at: 1_007 },
      ],
    });
    const closedGross = gross(closed, "130", 1_007, "EXIT_FILL_APPLIED", "EXIT_FILL");
    const beforeLate = costs(closed, [
      { costEventId: "D1", amount: "1.75", effectiveAt: 1_007 },
      { costEventId: "C1", effect: "CREDIT", amount: "0.50", effectiveAt: 1_002 },
    ], "EXIT_FILL_APPLIED", "EXIT_FILL");
    const afterLate = costs(closed, [
      { costEventId: "D1", amount: "1.75", effectiveAt: 1_007 },
      { costEventId: "C1", effect: "CREDIT", amount: "0.50", effectiveAt: 1_002 },
      { costEventId: "D2", amount: "0.25", effectiveAt: 1_010 },
    ], "EXIT_FILL_APPLIED", "EXIT_FILL");
    expect(projectRealtimeNetTradePerformance(closedGross, beforeLate)).toMatchObject({ snapshot: { netTotalPnl: "12.5" } });
    expect(projectRealtimeNetTradePerformance(closedGross, afterLate)).toMatchObject({
      snapshot: { netTotalPnl: "12.25", valuationAsOf: 1_007, costAccountingAsOf: 1_010,
        positionExposure: { exposureState: "CLOSED" } },
    });
  });

  it("covers profitable and losing short performance without local direction logic", () => {
    const short = attempt({ entries: [{ id: "E1", quantity: "2", price: "100", at: 1_001 }], entrySide: "SELL" });
    expect(projectRealtimeNetTradePerformance(gross(short, "90", 2_000), costs(short, [{ amount: "1" }]))).toMatchObject({
      snapshot: { netTotalPnl: "19", positionExposure: { direction: "SHORT" } },
    });
    expect(projectRealtimeNetTradePerformance(gross(short, "110", 2_000), costs(short, [{ amount: "1" }]))).toMatchObject({
      snapshot: { netTotalPnl: "-21", positionExposure: { direction: "SHORT" } },
    });
  });

  it("accepts all applied/duplicate entry and exit provenance combinations independently", () => {
    const source = openAttempt();
    for (const sourceKind of ["ENTRY_FILL", "EXIT_FILL"] as const) {
      const grossStatuses = sourceKind === "ENTRY_FILL"
        ? ["FILL_APPLIED", "DUPLICATE_FILL"] as const
        : ["EXIT_FILL_APPLIED", "DUPLICATE_EXIT_FILL"] as const;
      const costStatuses = grossStatuses;
      for (const grossStatus of grossStatuses) for (const costStatus of costStatuses) {
        const result = projectRealtimeNetTradePerformance(
          gross(source, "105", 2_000, grossStatus, sourceKind),
          costs(source, undefined, costStatus, sourceKind),
        );
        expect(result).toMatchObject({
          status: "NET_TRADE_PERFORMANCE_PROJECTED", grossUpstreamStatus: grossStatus,
          costUpstreamStatus: costStatus, snapshot: { netTotalPnl: "12.5" },
        });
      }
    }
  });

  it("preserves Task031A incoherence and all authoritative reference identities", () => {
    const source = openAttempt();
    const grossResult = gross(source, "105", 2_000);
    const costResult = costs(source);
    const result = projectRealtimeNetTradePerformance(grossResult, costResult);
    expect(result.status).toBe("NET_TRADE_PERFORMANCE_PROJECTED");
    if (result.status !== "NET_TRADE_PERFORMANCE_PROJECTED") throw new Error(result.reason);
    expect(result.snapshot).toBe(result.netPerformanceProjection.snapshot);
    expect(result.snapshot.grossPerformance).toBe(grossResult.snapshot);
    expect(result.snapshot.costAccounting).toBe(costResult.accounting);
    expect(result.snapshot.positionExposure).toBe(grossResult.snapshot.positionExposure);
    expect(result.markPolicy).toBe(grossResult.markPolicy);

    const forgedCost = Object.freeze({
      ...costResult,
      accounting: Object.freeze({ ...costResult.accounting, instrumentId: otherInstrument }),
    }) as RealtimeTradeCostAccountingProjectedResult;
    const rejected = projectRealtimeNetTradePerformance(grossResult, forgedCost);
    expect(rejected).toMatchObject({
      status: "NET_TRADE_PERFORMANCE_REJECTED", reason: "AUTHORITATIVE_NET_PERFORMANCE_REJECTED",
      netPerformanceProjection: { status: "NET_TRADE_PERFORMANCE_REJECTED", reason: "NET_PERFORMANCE_INCOHERENT" },
    });
  });

  it("is immutable, input-preserving, stateless, and deterministic", () => {
    const source = openAttempt();
    const grossResult = gross(source, "105", 2_000);
    const costResult = costs(source);
    const before = [grossResult, grossResult.snapshot, costResult, costResult.accounting].map(JSON.stringify);
    const first = projectRealtimeNetTradePerformance(grossResult, costResult);
    expect([grossResult, grossResult.snapshot, costResult, costResult.accounting].map(JSON.stringify)).toEqual(before);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(grossResult.snapshot)).toBe(true);
    expect(Object.isFrozen(costResult.accounting)).toBe(true);
    expect(projectRealtimeNetTradePerformance(grossResult, costResult)).toEqual(first);
    expect(new RealtimeNetTradePerformanceEngine().project(grossResult, costResult)).toEqual(first);
    expect(Object.keys(new RealtimeNetTradePerformanceEngine())).toEqual([]);
  });
});
