import { describe, expect, it } from "vitest";
import type { ExecutionAttempt } from "@ulte/execution-engine";
import type { TradeCostAccounting } from "@ulte/trade-cost-accounting-engine";
import type { TradePerformanceSnapshot } from "@ulte/trade-performance-engine";
import type { RealtimeTradeCostAccountingProjectedResult } from "@ulte/realtime-trade-cost-accounting-engine";
import type { TradePerformanceProjectedRealtimeResult } from "@ulte/realtime-trade-performance-engine";
import {
  projectRealtimeNetTradePerformance,
  type NetTradePerformanceProjectedRealtimeResult,
} from "@ulte/realtime-net-trade-performance-engine";
import {
  createTradeRiskBasisFromExecutionAttempt,
  type TradeRiskBasis,
} from "@ulte/trade-r-multiple-engine";
import { projectRealtimeTradeRMultiple } from "./index.js";

const instrumentId = "ulte:v1:TEST:CFD:R-INTEGRATION";

function originalRiskBasis(): TradeRiskBasis {
  const attempt = Object.freeze({
    status: "EXECUTION_ATTEMPT_READY",
    schemaVersion: "EXECUTION_ATTEMPT_V3",
    executionAttemptId: "attempt-integration",
    executionPlanId: "plan-integration",
    tradeIntentId: "intent-integration",
    candidateId: "candidate-integration",
    instrumentId,
    actualRiskAmount: "10",
    approvedRiskAmount: "12",
    accountCurrency: "USD",
    preparedAsOf: 900,
  }) as unknown as ExecutionAttempt;
  const created = createTradeRiskBasisFromExecutionAttempt(attempt);
  if (created.status !== "TRADE_RISK_BASIS_CREATED") throw new Error(created.reason);
  return created.riskBasis;
}

interface Checkpoint {
  readonly grossTotalPnl: string;
  readonly netCostAmount: string;
  readonly exposureState?: "OPEN" | "PARTIALLY_EXITED" | "FLAT_ENTRY_ACTIVE" | "CLOSED";
  readonly direction?: "LONG" | "SHORT";
  readonly valuationAsOf?: number;
  readonly costAccountingAsOf?: number;
}

function realtimeNet(checkpoint: Checkpoint): NetTradePerformanceProjectedRealtimeResult {
  const exposureState = checkpoint.exposureState ?? "OPEN";
  const direction = checkpoint.direction ?? "LONG";
  const closedLike = exposureState === "FLAT_ENTRY_ACTIVE" || exposureState === "CLOSED";
  const positionExposure = Object.freeze({
    executionAttemptId: "attempt-integration",
    executionPlanId: "plan-integration",
    tradeIntentId: "intent-integration",
    candidateId: "candidate-integration",
    instrumentId,
    direction,
    entrySide: direction === "LONG" ? "BUY" : "SELL",
    exitSide: direction === "LONG" ? "SELL" : "BUY",
    requestedQuantity: "2.75",
    filledEntryQuantity: "2.75",
    exitedQuantity: closedLike ? "2.75" : exposureState === "PARTIALLY_EXITED" ? "1.25" : "0",
    openQuantity: closedLike ? "0" : exposureState === "PARTIALLY_EXITED" ? "1.5" : "2.75",
    entryOrderStatus: exposureState === "FLAT_ENTRY_ACTIVE" ? "WORKING" : "FILLED",
    executionState: exposureState === "CLOSED" ? "EXIT_FILLED" : "ENTRY_FILLED",
    entryCanIncreaseExposure: exposureState === "FLAT_ENTRY_ACTIVE",
    exposureState,
    executionAsOf: 1_007,
  });
  const realizedAccounting = Object.freeze({
    executionAttemptId: "attempt-integration",
    instrumentId,
    grossRealizedPnl: "0",
    filledEntryQuantity: positionExposure.filledEntryQuantity,
    exitedQuantity: positionExposure.exitedQuantity,
    openQuantity: positionExposure.openQuantity,
    positionExposure,
  });
  const executionAccountingAsOf = 1_007;
  const grossPerformance = Object.freeze({
    executionAttemptId: "attempt-integration",
    executionPlanId: "plan-integration",
    tradeIntentId: "intent-integration",
    candidateId: "candidate-integration",
    instrumentId,
    direction,
    valuationModel: "LINEAR_PRICE_PNL",
    pnlCurrency: "USD",
    pnlValuePerPriceUnitPerQuantity: "1",
    filledEntryQuantity: positionExposure.filledEntryQuantity,
    exitedQuantity: positionExposure.exitedQuantity,
    openQuantity: positionExposure.openQuantity,
    grossRealizedPnl: "0",
    grossUnrealizedPnl: checkpoint.grossTotalPnl,
    grossTotalPnl: checkpoint.grossTotalPnl,
    accountingAsOf: executionAccountingAsOf,
    valuationAsOf: checkpoint.valuationAsOf ?? 1_008,
    positionExposure,
    realizedAccounting,
  }) as unknown as TradePerformanceSnapshot;
  const costAccounting = Object.freeze({
    executionAttemptId: "attempt-integration",
    executionPlanId: "plan-integration",
    tradeIntentId: "intent-integration",
    candidateId: "candidate-integration",
    instrumentId,
    pnlCurrency: "USD",
    grossDebitCostAmount: checkpoint.netCostAmount,
    grossCreditCostAmount: "0",
    netCostAmount: checkpoint.netCostAmount,
    executionAccountingAsOf,
    costAccountingAsOf: checkpoint.costAccountingAsOf ?? 1_008,
    positionExposure,
    realizedAccounting,
  }) as unknown as TradeCostAccounting;
  const exitSource = exposureState !== "OPEN";
  const grossResult = Object.freeze({
    status: "TRADE_PERFORMANCE_PROJECTED",
    sourceKind: exitSource ? "EXIT_FILL" : "ENTRY_FILL",
    upstreamStatus: exitSource ? "EXIT_FILL_APPLIED" : "FILL_APPLIED",
    markPolicy: "LAST_TRADE_V1",
    snapshot: grossPerformance,
    realtimeValuation: Object.freeze({}),
  }) as unknown as TradePerformanceProjectedRealtimeResult;
  const costResult = Object.freeze({
    status: "TRADE_COST_ACCOUNTING_PROJECTED",
    sourceKind: grossResult.sourceKind,
    upstreamStatus: grossResult.upstreamStatus,
    observedDeliveryCount: 1,
    uniqueCostEventCount: 1,
    duplicateDeliveryCount: 0,
    accounting: costAccounting,
  }) as unknown as RealtimeTradeCostAccountingProjectedResult;
  const net = projectRealtimeNetTradePerformance(grossResult, costResult);
  if (net.status !== "NET_TRADE_PERFORMANCE_PROJECTED") throw new Error(net.reason);
  return net;
}

describe("Task031B to Task032B integration", () => {
  it("reuses one original risk basis across every realtime checkpoint", () => {
    const riskBasis = originalRiskBasis();
    const checkpoints = [
      ["open", { grossTotalPnl: "13.75", netCostAmount: "1.25" }, "12.5", "OPEN"],
      ["market-only", { grossTotalPnl: "27.5", netCostAmount: "1.25" }, "26.25", "OPEN"],
      ["cost-only", { grossTotalPnl: "13.75", netCostAmount: "0.75" }, "13", "OPEN"],
      ["both", { grossTotalPnl: "27.5", netCostAmount: "0.75" }, "26.75", "OPEN"],
      ["partial", { grossTotalPnl: "21.25", netCostAmount: "1.15", exposureState: "PARTIALLY_EXITED" }, "20.1", "PARTIALLY_EXITED"],
      ["flat", { grossTotalPnl: "-8.75", netCostAmount: "1.25", exposureState: "FLAT_ENTRY_ACTIVE" }, "-10", "FLAT_ENTRY_ACTIVE"],
      ["closed", { grossTotalPnl: "13.75", netCostAmount: "1.25", exposureState: "CLOSED", valuationAsOf: 1_007 }, "12.5", "CLOSED"],
      ["late cost", { grossTotalPnl: "13.75", netCostAmount: "1.5", exposureState: "CLOSED", valuationAsOf: 1_007, costAccountingAsOf: 1_010 }, "12.25", "CLOSED"],
      ["short profit", { grossTotalPnl: "20", netCostAmount: "1", direction: "SHORT" }, "19", "OPEN"],
      ["short loss", { grossTotalPnl: "-20", netCostAmount: "1", direction: "SHORT" }, "-21", "OPEN"],
      ["zero", { grossTotalPnl: "1", netCostAmount: "1" }, "0", "OPEN"],
    ] as const;

    for (const [label, checkpoint, numerator, exposureState] of checkpoints) {
      const realtimeNetPerformance = realtimeNet(checkpoint);
      const result = projectRealtimeTradeRMultiple(realtimeNetPerformance, riskBasis);
      expect(result.status, label).toBe("TRADE_R_MULTIPLE_PROJECTED");
      if (result.status !== "TRADE_R_MULTIPLE_PROJECTED") throw new Error(label);
      expect(result.snapshot.netRMultipleRatio, label).toEqual({ numerator, denominator: "10" });
      expect(result.snapshot.riskBasis, label).toBe(riskBasis);
      expect(result.snapshot.riskBasisAsOf, label).toBe(900);
      expect(result.snapshot.positionExposure.exposureState, label).toBe(exposureState);
      expect(result.snapshot.netPerformance, label).toBe(realtimeNetPerformance.snapshot);
      expect(result.realtimeNetPerformance, label).toBe(realtimeNetPerformance);
      if (label === "late cost") {
        expect(result.snapshot.valuationAsOf).toBe(1_007);
        expect(result.snapshot.costAccountingAsOf).toBe(1_010);
      }
    }
  });

  it("is equivalent for historical and live contexts with the same authorities", () => {
    const riskBasis = originalRiskBasis();
    const historicalAuthority = realtimeNet({ grossTotalPnl: "13.75", netCostAmount: "1.25" });
    const liveAuthority = realtimeNet({ grossTotalPnl: "13.75", netCostAmount: "1.25" });
    const historicalReplay = projectRealtimeTradeRMultiple(historicalAuthority, riskBasis);
    const liveProjection = projectRealtimeTradeRMultiple(liveAuthority, riskBasis);
    expect(liveProjection).toEqual(historicalReplay);
  });
});
