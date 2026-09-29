import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  gross: vi.fn(),
  cost: vi.fn(),
}));

vi.mock("@ulte/trade-performance-engine", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@ulte/trade-performance-engine")>()),
  projectTradePerformanceSnapshot: mocks.gross,
}));
vi.mock("@ulte/trade-cost-accounting-engine", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@ulte/trade-cost-accounting-engine")>()),
  projectTradeCostAccounting: mocks.cost,
}));

import { projectNetTradePerformanceSnapshot } from "./index.js";

describe("standalone authority delegation order", () => {
  beforeEach(() => vi.clearAllMocks());

  it("calls Task029A once, does not call Task030A after rejection, and preserves the exact rejection", () => {
    const rejection = Object.freeze({
      status: "TRADE_PERFORMANCE_REJECTED" as const,
      reason: "PERFORMANCE_AGGREGATION_INCOHERENT" as const,
    });
    mocks.gross.mockReturnValue(rejection);
    const result = projectNetTradePerformanceSnapshot({} as never, {} as never, {} as never, []);
    expect(mocks.gross).toHaveBeenCalledOnce();
    expect(mocks.cost).not.toHaveBeenCalled();
    expect(result).toEqual({
      status: "NET_TRADE_PERFORMANCE_REJECTED",
      reason: "GROSS_PERFORMANCE_REJECTED",
      grossPerformanceProjection: rejection,
    });
    if (result.status === "NET_TRADE_PERFORMANCE_REJECTED" && result.reason === "GROSS_PERFORMANCE_REJECTED") {
      expect(result.grossPerformanceProjection).toBe(rejection);
    }
  });

  it("calls each upstream authority exactly once after gross success", () => {
    const snapshot = Object.freeze({ marker: "gross" });
    const rejection = Object.freeze({
      status: "TRADE_COST_ACCOUNTING_REJECTED" as const,
      reason: "COST_EVENT_INVALID" as const,
    });
    mocks.gross.mockReturnValue(Object.freeze({ status: "TRADE_PERFORMANCE_PROJECTED", snapshot }));
    mocks.cost.mockReturnValue(rejection);
    const result = projectNetTradePerformanceSnapshot({} as never, {} as never, {} as never, []);
    expect(mocks.gross).toHaveBeenCalledOnce();
    expect(mocks.cost).toHaveBeenCalledOnce();
    expect(result).toEqual({
      status: "NET_TRADE_PERFORMANCE_REJECTED",
      reason: "COST_ACCOUNTING_REJECTED",
      costAccountingProjection: rejection,
    });
    if (result.status === "NET_TRADE_PERFORMANCE_REJECTED" && result.reason === "COST_ACCOUNTING_REJECTED") {
      expect(result.costAccountingProjection).toBe(rejection);
    }
  });
});
