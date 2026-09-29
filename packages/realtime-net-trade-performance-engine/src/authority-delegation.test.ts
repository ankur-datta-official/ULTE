import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RealtimeTradeCostAccountingResult } from "@ulte/realtime-trade-cost-accounting-engine";
import type { RealtimeTradePerformanceResult } from "@ulte/realtime-trade-performance-engine";

const mocks = vi.hoisted(() => ({ net: vi.fn() }));

vi.mock("@ulte/net-trade-performance-engine", () => ({
  projectNetTradePerformanceFromAuthorities: mocks.net,
}));

import { projectRealtimeNetTradePerformance } from "./index.js";

const snapshot = Object.freeze({ authority: "gross" });
const accounting = Object.freeze({ authority: "cost" });
const grossProjected = Object.freeze({
  status: "TRADE_PERFORMANCE_PROJECTED", sourceKind: "ENTRY_FILL", upstreamStatus: "FILL_APPLIED",
  markPolicy: "LAST_TRADE_V1", snapshot, realtimeValuation: Object.freeze({}),
}) as unknown as RealtimeTradePerformanceResult;
const costProjected = Object.freeze({
  status: "TRADE_COST_ACCOUNTING_PROJECTED", sourceKind: "ENTRY_FILL", upstreamStatus: "FILL_APPLIED",
  observedDeliveryCount: 1, uniqueCostEventCount: 1, duplicateDeliveryCount: 0, accounting,
}) as unknown as RealtimeTradeCostAccountingResult;

describe("Task031A authority delegation", () => {
  beforeEach(() => vi.clearAllMocks());

  it("does not invoke Task031A for source, state, or upstream-rejection gates", () => {
    const differentSource = Object.freeze({ ...costProjected, sourceKind: "EXIT_FILL", upstreamStatus: "EXIT_FILL_APPLIED" }) as RealtimeTradeCostAccountingResult;
    const noGross = Object.freeze({ status: "NO_PERFORMANCE_PROJECTION", sourceKind: "ENTRY_FILL", upstreamStatus: "FILL_REJECTED" }) as RealtimeTradePerformanceResult;
    const grossRejected = Object.freeze({ ...grossProjected, status: "TRADE_PERFORMANCE_REJECTED" }) as RealtimeTradePerformanceResult;
    projectRealtimeNetTradePerformance(grossProjected, differentSource);
    projectRealtimeNetTradePerformance(noGross, costProjected);
    projectRealtimeNetTradePerformance(grossRejected, costProjected);
    expect(mocks.net).not.toHaveBeenCalled();
  });

  it("invokes Task031A exactly once with the two nested authorities and preserves its result", () => {
    const netSnapshot = Object.freeze({ authority: "net" });
    const netAuthority = Object.freeze({ status: "NET_TRADE_PERFORMANCE_PROJECTED", snapshot: netSnapshot });
    mocks.net.mockReturnValue(netAuthority);
    const result = projectRealtimeNetTradePerformance(grossProjected, costProjected);
    expect(mocks.net).toHaveBeenCalledOnce();
    expect(mocks.net).toHaveBeenCalledWith(snapshot, accounting);
    expect(result).toMatchObject({ status: "NET_TRADE_PERFORMANCE_PROJECTED" });
    if (result.status !== "NET_TRADE_PERFORMANCE_PROJECTED") throw new Error("projection failed");
    expect(result.snapshot).toBe(netSnapshot);
    expect(result.netPerformanceProjection).toBe(netAuthority);
  });

  it("preserves the exact Task031A incoherence rejection", () => {
    const rejection = Object.freeze({
      status: "NET_TRADE_PERFORMANCE_REJECTED", reason: "NET_PERFORMANCE_INCOHERENT",
    });
    mocks.net.mockReturnValue(rejection);
    const result = projectRealtimeNetTradePerformance(grossProjected, costProjected);
    expect(mocks.net).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      status: "NET_TRADE_PERFORMANCE_REJECTED", reason: "AUTHORITATIVE_NET_PERFORMANCE_REJECTED",
    });
    if (result.status !== "NET_TRADE_PERFORMANCE_REJECTED"
      || result.reason !== "AUTHORITATIVE_NET_PERFORMANCE_REJECTED") throw new Error("rejection missing");
    expect(result.netPerformanceProjection).toBe(rejection);
  });
});
