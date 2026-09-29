import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RealtimeNetTradePerformanceResult } from "@ulte/realtime-net-trade-performance-engine";
import type { TradeRiskBasis } from "@ulte/trade-r-multiple-engine";

const mocks = vi.hoisted(() => ({ project: vi.fn() }));

vi.mock("@ulte/trade-r-multiple-engine", () => ({
  projectTradeRMultipleFromAuthorities: mocks.project,
}));

import { projectRealtimeTradeRMultiple } from "./index.js";

const riskBasis = Object.freeze({ authority: "risk" }) as unknown as TradeRiskBasis;
const snapshot = Object.freeze({ authority: "net" });
const projected = Object.freeze({
  status: "NET_TRADE_PERFORMANCE_PROJECTED",
  sourceKind: "ENTRY_FILL",
  grossUpstreamStatus: "FILL_APPLIED",
  costUpstreamStatus: "DUPLICATE_FILL",
  markPolicy: "LAST_TRADE_V1",
  snapshot,
  grossPerformanceResult: Object.freeze({}),
  costAccountingResult: Object.freeze({}),
  netPerformanceProjection: Object.freeze({}),
}) as unknown as RealtimeNetTradePerformanceResult;

describe("Task032A authority delegation", () => {
  beforeEach(() => vi.clearAllMocks());

  it("does not invoke Task032A for no-projection or upstream-rejection gates", () => {
    const noProjection = Object.freeze({
      status: "NO_NET_TRADE_PERFORMANCE_PROJECTION",
      sourceKind: "ENTRY_FILL",
      grossUpstreamStatus: "FILL_REJECTED",
      costUpstreamStatus: "FILL_REJECTED",
    }) as RealtimeNetTradePerformanceResult;
    const rejected = Object.freeze({
      status: "NET_TRADE_PERFORMANCE_REJECTED",
      reason: "REALTIME_PROJECTION_STATE_INCOHERENT",
      sourceKind: "ENTRY_FILL",
      grossUpstreamStatus: "FILL_APPLIED",
      costUpstreamStatus: "FILL_REJECTED",
      grossPerformanceResult: Object.freeze({}),
      costAccountingResult: Object.freeze({}),
    }) as RealtimeNetTradePerformanceResult;
    const malformed = new Proxy({} as TradeRiskBasis, {
      get() { throw new Error("risk basis inspected"); },
    });

    expect(() => projectRealtimeTradeRMultiple(noProjection, malformed)).not.toThrow();
    const result = projectRealtimeTradeRMultiple(rejected, malformed);
    expect(result).toMatchObject({ reason: "REALTIME_NET_PERFORMANCE_REJECTED" });
    if (result.status !== "TRADE_R_MULTIPLE_REJECTED"
      || result.reason !== "REALTIME_NET_PERFORMANCE_REJECTED") throw new Error("rejection missing");
    expect(result.realtimeNetPerformance).toBe(rejected);
    expect(mocks.project).not.toHaveBeenCalled();
  });

  it("invokes Task032A exactly once and preserves its successful authorities", () => {
    const rSnapshot = Object.freeze({ authority: "r" });
    const authority = Object.freeze({ status: "TRADE_R_MULTIPLE_PROJECTED", snapshot: rSnapshot });
    mocks.project.mockReturnValue(authority);
    const result = projectRealtimeTradeRMultiple(projected, riskBasis);
    expect(mocks.project).toHaveBeenCalledOnce();
    expect(mocks.project).toHaveBeenCalledWith(snapshot, riskBasis);
    expect(result).toMatchObject({ status: "TRADE_R_MULTIPLE_PROJECTED" });
    if (result.status !== "TRADE_R_MULTIPLE_PROJECTED") throw new Error("projection missing");
    expect(result.snapshot).toBe(rSnapshot);
    expect(result.rMultipleProjection).toBe(authority);
    expect(result.realtimeNetPerformance).toBe(projected);
  });

  it("preserves the exact Task032A rejection", () => {
    const authority = Object.freeze({
      status: "TRADE_R_MULTIPLE_REJECTED",
      reason: "R_MULTIPLE_CURRENCY_MISMATCH",
    });
    mocks.project.mockReturnValue(authority);
    const result = projectRealtimeTradeRMultiple(projected, riskBasis);
    expect(mocks.project).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      status: "TRADE_R_MULTIPLE_REJECTED",
      reason: "AUTHORITATIVE_R_MULTIPLE_REJECTED",
    });
    if (result.status !== "TRADE_R_MULTIPLE_REJECTED"
      || result.reason !== "AUTHORITATIVE_R_MULTIPLE_REJECTED") throw new Error("rejection missing");
    expect(result.rMultipleProjection).toBe(authority);
  });
});
