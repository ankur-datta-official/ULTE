import { describe, expect, it } from "vitest";
import type {
  NetTradePerformanceProjectedRealtimeResult,
  RealtimeNetTradePerformanceResult,
} from "@ulte/realtime-net-trade-performance-engine";
import type {
  TradeRiskBasis,
} from "@ulte/trade-r-multiple-engine";
import {
  projectRealtimeTradeRMultiple,
  RealtimeTradeRMultipleEngine,
} from "./index.js";

const instrumentId = "ulte:v1:TEST:CFD:R-UNIT" as TradeRiskBasis["instrumentId"];

function basis(updates: Record<string, unknown> = {}): TradeRiskBasis {
  return Object.freeze({
    schemaVersion: "TRADE_RISK_BASIS_V1",
    executionAttemptId: "attempt-r",
    executionPlanId: "plan-r",
    tradeIntentId: "intent-r",
    candidateId: "candidate-r",
    instrumentId,
    riskBasisMethod: "EXECUTION_ACTUAL_RISK_V1",
    initialActualRiskAmount: "10",
    accountCurrency: "USD",
    riskBasisAsOf: 900,
    ...updates,
  }) as TradeRiskBasis;
}

function projected(
  netTotalPnl = "12.5",
  updates: Record<string, unknown> = {},
): NetTradePerformanceProjectedRealtimeResult {
  const positionExposure = Object.freeze({ exposureState: "OPEN", direction: "LONG" });
  const snapshot = Object.freeze({
    schemaVersion: "NET_TRADE_PERFORMANCE_SNAPSHOT_V1",
    executionAttemptId: "attempt-r",
    executionPlanId: "plan-r",
    tradeIntentId: "intent-r",
    candidateId: "candidate-r",
    instrumentId,
    direction: "LONG",
    pnlCurrency: "USD",
    netTotalPnl,
    executionAccountingAsOf: 1_001,
    valuationAsOf: 1_002,
    costAccountingAsOf: 1_003,
    positionExposure,
    ...updates,
  });
  return Object.freeze({
    status: "NET_TRADE_PERFORMANCE_PROJECTED",
    sourceKind: "ENTRY_FILL",
    grossUpstreamStatus: "FILL_APPLIED",
    costUpstreamStatus: "DUPLICATE_FILL",
    markPolicy: "LAST_TRADE_V1",
    snapshot,
    grossPerformanceResult: Object.freeze({}),
    costAccountingResult: Object.freeze({}),
    netPerformanceProjection: Object.freeze({}),
  }) as unknown as NetTradePerformanceProjectedRealtimeResult;
}

describe("realtime R-multiple gating and composition", () => {
  it("returns no projection with provenance and never manufactures zero R", () => {
    const input = Object.freeze({
      status: "NO_NET_TRADE_PERFORMANCE_PROJECTION",
      sourceKind: "ENTRY_FILL",
      grossUpstreamStatus: "NO_FILL_PROCESSING",
      costUpstreamStatus: "NO_FILL_PROCESSING",
    }) as RealtimeNetTradePerformanceResult;
    const result = projectRealtimeTradeRMultiple(input, basis({ initialActualRiskAmount: "0" }));
    expect(result).toEqual({
      status: "NO_TRADE_R_MULTIPLE_PROJECTION",
      sourceKind: "ENTRY_FILL",
      grossUpstreamStatus: "NO_FILL_PROCESSING",
      costUpstreamStatus: "NO_FILL_PROCESSING",
    });
    expect(result).not.toHaveProperty("snapshot");
    expect(Object.isFrozen(result)).toBe(true);
  });

  it("preserves projected provenance and every successful authority reference", () => {
    const net = projected();
    const risk = basis();
    const result = projectRealtimeTradeRMultiple(net, risk);
    expect(result).toMatchObject({
      status: "TRADE_R_MULTIPLE_PROJECTED",
      sourceKind: "ENTRY_FILL",
      grossUpstreamStatus: "FILL_APPLIED",
      costUpstreamStatus: "DUPLICATE_FILL",
      markPolicy: "LAST_TRADE_V1",
      snapshot: { netRMultipleRatio: { numerator: "12.5", denominator: "10" } },
    });
    if (result.status !== "TRADE_R_MULTIPLE_PROJECTED") throw new Error("projection failed");
    expect(result.snapshot).toBe(result.rMultipleProjection.snapshot);
    expect(result.snapshot.netPerformance).toBe(net.snapshot);
    expect(result.snapshot.riskBasis).toBe(risk);
    expect(result.snapshot.positionExposure).toBe(net.snapshot.positionExposure);
    expect(result.realtimeNetPerformance).toBe(net);
  });

  it.each([
    ["executionAttemptId", "other-attempt"],
    ["executionPlanId", "other-plan"],
    ["tradeIntentId", "other-intent"],
    ["candidateId", "other-candidate"],
    ["instrumentId", "ulte:v1:TEST:CFD:OTHER"],
  ])("preserves authoritative incoherence for %s", (field, value) => {
    const result = projectRealtimeTradeRMultiple(projected(), basis({ [field]: value }));
    expect(result).toMatchObject({
      status: "TRADE_R_MULTIPLE_REJECTED",
      reason: "AUTHORITATIVE_R_MULTIPLE_REJECTED",
      rMultipleProjection: { reason: "R_MULTIPLE_AUTHORITY_INCOHERENT" },
    });
  });

  it.each([
    ["cross currency", { accountCurrency: "BDT" }, "R_MULTIPLE_CURRENCY_MISMATCH"],
    ["invalid risk", { initialActualRiskAmount: "0" }, "RISK_BASIS_INVALID"],
    ["wrong schema", { schemaVersion: "TRADE_RISK_BASIS_V0" }, "RISK_BASIS_INVALID"],
  ])("preserves %s rejection", (_label, updates, reason) => {
    const result = projectRealtimeTradeRMultiple(projected(), basis(updates));
    expect(result).toMatchObject({
      status: "TRADE_R_MULTIPLE_REJECTED",
      reason: "AUTHORITATIVE_R_MULTIPLE_REJECTED",
      rMultipleProjection: { status: "TRADE_R_MULTIPLE_REJECTED", reason },
    });
  });

  it("is immutable, input-preserving, deterministic, and stateless", () => {
    const net = projected("0");
    const risk = basis();
    const before = [JSON.stringify(net), JSON.stringify(risk)];
    const first = projectRealtimeTradeRMultiple(net, risk);
    const repeated = projectRealtimeTradeRMultiple(net, risk);
    const fresh = new RealtimeTradeRMultipleEngine().project(net, risk);
    expect(repeated).toEqual(first);
    expect(fresh).toEqual(first);
    expect([JSON.stringify(net), JSON.stringify(risk)]).toEqual(before);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.keys(new RealtimeTradeRMultipleEngine())).toEqual([]);
    if (first.status !== "TRADE_R_MULTIPLE_PROJECTED") throw new Error("projection failed");
    expect(first.snapshot.netRMultipleRatio).toEqual({ numerator: "0", denominator: "10" });
  });
});
