import { describe, expect, it } from "vitest";
import type { ExecutionAttempt } from "@ulte/execution-engine";
import { createInstrumentId } from "@ulte/instrument-model";
import type { RealtimeExecutionFillResult } from "@ulte/realtime-execution-fill-engine";
import type { RealtimeNetTradePerformanceResult } from "@ulte/realtime-net-trade-performance-engine";
import type { RealtimePositionExposureInput } from "@ulte/realtime-position-exposure-engine";
import type { RealtimeTradeCostAccountingResult } from "@ulte/realtime-trade-cost-accounting-engine";
import type { RealtimeTradePerformanceResult } from "@ulte/realtime-trade-performance-engine";
import type { RealtimeTradeRMultipleResult } from "@ulte/realtime-trade-r-multiple-engine";
import type { RealtimeTradeValuationResult } from "@ulte/realtime-trade-valuation-engine";
import type { TradeRiskBasis, TradeRiskBasisCreationResult } from "@ulte/trade-r-multiple-engine";
import {
  createLiveTradingOrchestrationSession,
  planLiveTradingStep,
  type LiveTradingOrchestrationSession,
} from "./index.js";

const instrument = createInstrumentId({ venue: "test", venueSymbol: "BTC-USD", instrumentKind: "SPOT" });

function attempt(id = "attempt-1"): ExecutionAttempt {
  return Object.freeze({
    status: "EXECUTION_ATTEMPT_READY",
    schemaVersion: "EXECUTION_ATTEMPT_V3",
    executionAttemptId: id,
    executionPlanId: "plan-1",
    tradeIntentId: "intent-1",
    candidateId: "candidate-1",
    instrumentId: instrument,
  }) as ExecutionAttempt;
}

function session(authority: ExecutionAttempt, basis?: TradeRiskBasis): LiveTradingOrchestrationSession {
  const base = createLiveTradingOrchestrationSession({
    sessionId: "session-1",
    mode: "SANDBOX",
    instrumentId: instrument,
  });
  return Object.freeze({
    ...base,
    latestExecutionAttempt: authority,
    ...(basis === undefined ? {} : { riskBasis: basis }),
  });
}

function riskBasis(authority: ExecutionAttempt): TradeRiskBasis {
  return Object.freeze({
    schemaVersion: "TRADE_RISK_BASIS_V1",
    executionAttemptId: authority.executionAttemptId,
    executionPlanId: authority.executionPlanId,
    tradeIntentId: authority.tradeIntentId,
    candidateId: authority.candidateId,
    instrumentId: instrument,
  }) as TradeRiskBasis;
}

describe("projection routing", () => {
  it("rejects a session whose risk basis disagrees with authoritative trade identity", () => {
    const authority = attempt();
    const incoherentBasis = Object.freeze({
      ...riskBasis(authority),
      executionPlanId: "plan-2",
    }) as TradeRiskBasis;
    const invalid = session(authority, incoherentBasis);
    const result = Object.freeze({ status: "UNREALIZED_VALUATION_REJECTED" }) as unknown as RealtimeTradeValuationResult;
    expect(planLiveTradingStep(invalid, { kind: "VALUATION_RESULT", result }))
      .toMatchObject({ status: "ORCHESTRATION_REJECTED", reason: "INVALID_SESSION" });
  });

  it("rejects a session whose retained R projection disagrees with its attempt", () => {
    const authority = attempt();
    const basis = riskBasis(authority);
    const invalid = Object.freeze({
      ...session(authority, basis),
      latestRealtimeRMultiple: Object.freeze({
        status: "TRADE_R_MULTIPLE_PROJECTED",
        snapshot: Object.freeze({
          executionAttemptId: "attempt-2",
          executionPlanId: authority.executionPlanId,
          tradeIntentId: authority.tradeIntentId,
          candidateId: authority.candidateId,
          instrumentId: instrument,
          riskBasis: basis,
        }),
      }),
    }) as unknown as LiveTradingOrchestrationSession;
    const result = Object.freeze({ status: "UNREALIZED_VALUATION_REJECTED" }) as unknown as RealtimeTradeValuationResult;
    expect(planLiveTradingStep(invalid, { kind: "VALUATION_RESULT", result }))
      .toMatchObject({ status: "ORCHESTRATION_REJECTED", reason: "INVALID_SESSION" });
  });

  it("stores an authoritative risk basis by exact reference and keeps it stable", () => {
    const authority = attempt();
    const basis = riskBasis(authority);
    const result = Object.freeze({ status: "TRADE_RISK_BASIS_CREATED", riskBasis: basis }) as TradeRiskBasisCreationResult;
    const established = planLiveTradingStep(session(authority), {
      kind: "TRADE_RISK_BASIS_CREATION_RESULT",
      result,
    });
    expect(established.status).toBe("NO_ACTION");
    expect(established.session.riskBasis).toBe(basis);
    expect(established.reference).toBe(result);

    const replacement = riskBasis(authority);
    const replacementResult = Object.freeze({
      status: "TRADE_RISK_BASIS_CREATED",
      riskBasis: replacement,
    }) as TradeRiskBasisCreationResult;
    expect(planLiveTradingStep(established.session, {
      kind: "TRADE_RISK_BASIS_CREATION_RESULT",
      result: replacementResult,
    })).toMatchObject({ status: "ORCHESTRATION_REJECTED", reason: "RISK_BASIS_INCOHERENT" });
    expect(established.session.riskBasis).toBe(basis);
  });

  it("emits an exact position projection descriptor for actionable lifecycle authority", () => {
    const authority = attempt();
    const lifecycle = Object.freeze({ status: "FILL_APPLIED", executionAttempt: authority }) as unknown as RealtimeExecutionFillResult;
    const input = Object.freeze({ sourceKind: "ENTRY_FILL", fillLifecycle: lifecycle }) as RealtimePositionExposureInput;
    const planned = planLiveTradingStep(session(authority), { kind: "POSITION_EXPOSURE_REQUEST", input });
    expect(planned).toMatchObject({ status: "COMMAND_PLANNED", command: { operation: "PROJECT_REALTIME_POSITION_EXPOSURE" } });
    if (planned.status === "COMMAND_PLANNED" && planned.command.operation === "PROJECT_REALTIME_POSITION_EXPOSURE") {
      expect(planned.command.input).toBe(input);
    }
  });

  it("permits duplicate lifecycle projection only through downstream APIs that explicitly support it", () => {
    const authority = attempt();
    const lifecycle = Object.freeze({ status: "DUPLICATE_FILL", executionAttempt: authority }) as unknown as RealtimeExecutionFillResult;
    const input = Object.freeze({ sourceKind: "ENTRY_FILL", fillLifecycle: lifecycle }) as RealtimePositionExposureInput;
    expect(planLiveTradingStep(session(authority), { kind: "POSITION_EXPOSURE_REQUEST", input }))
      .toMatchObject({ status: "COMMAND_PLANNED", command: { operation: "PROJECT_REALTIME_POSITION_EXPOSURE" } });
  });

  it("serializes valuation into gross performance without recomputing it", () => {
    const authority = attempt();
    const result = Object.freeze({
      status: "UNREALIZED_VALUATION_PROJECTED",
      valuation: Object.freeze({ instrumentId: instrument, executionAttemptId: authority.executionAttemptId }),
    }) as unknown as RealtimeTradeValuationResult;
    const planned = planLiveTradingStep(session(authority), { kind: "VALUATION_RESULT", result });
    expect(planned).toMatchObject({ status: "COMMAND_PLANNED", command: { operation: "PROJECT_REALTIME_GROSS_PERFORMANCE" } });
    if (planned.status === "COMMAND_PLANNED" && planned.command.operation === "PROJECT_REALTIME_GROSS_PERFORMANCE") {
      expect(planned.command.input).toBe(result);
      expect(planned.reference).toBe(result);
    }
  });

  it("preserves rejected valuation by reference and emits no command", () => {
    const result = Object.freeze({ status: "UNREALIZED_VALUATION_REJECTED" }) as unknown as RealtimeTradeValuationResult;
    const planned = planLiveTradingStep(session(attempt()), { kind: "VALUATION_RESULT", result });
    expect(planned.status).toBe("NO_ACTION");
    expect(planned.reference).toBe(result);
  });

  it("combines only complete gross and cost authorities in one descriptor", () => {
    const authority = attempt();
    const grossPerformance = Object.freeze({
      status: "TRADE_PERFORMANCE_PROJECTED",
      snapshot: Object.freeze({ instrumentId: instrument, executionAttemptId: authority.executionAttemptId }),
    }) as unknown as RealtimeTradePerformanceResult;
    const costAccounting = Object.freeze({
      status: "TRADE_COST_ACCOUNTING_PROJECTED",
      accounting: Object.freeze({ instrumentId: instrument, executionAttemptId: authority.executionAttemptId }),
    }) as unknown as RealtimeTradeCostAccountingResult;
    const planned = planLiveTradingStep(session(authority), {
      kind: "NET_PERFORMANCE_AUTHORITIES",
      grossPerformance,
      costAccounting,
    });
    expect(planned).toMatchObject({ status: "COMMAND_PLANNED", command: { operation: "PROJECT_REALTIME_NET_PERFORMANCE" } });
    if (planned.status === "COMMAND_PLANNED" && planned.command.operation === "PROJECT_REALTIME_NET_PERFORMANCE") {
      expect(planned.command.grossPerformance).toBe(grossPerformance);
      expect(planned.command.costAccounting).toBe(costAccounting);
    }
  });

  it("requires established risk basis before net authority can route to R", () => {
    const authority = attempt();
    const net = Object.freeze({
      status: "NET_TRADE_PERFORMANCE_PROJECTED",
      snapshot: Object.freeze({ instrumentId: instrument, executionAttemptId: authority.executionAttemptId }),
    }) as unknown as RealtimeNetTradePerformanceResult;
    expect(planLiveTradingStep(session(authority), { kind: "NET_PERFORMANCE_RESULT", result: net }))
      .toMatchObject({ status: "NEEDS_CONTEXT", reason: "MISSING_REQUIRED_CONTEXT" });

    const basis = riskBasis(authority);
    const planned = planLiveTradingStep(session(authority, basis), {
      kind: "NET_PERFORMANCE_RESULT",
      result: net,
    });
    expect(planned).toMatchObject({ status: "COMMAND_PLANNED", command: { operation: "PROJECT_REALTIME_R_MULTIPLE" } });
    if (planned.status === "COMMAND_PLANNED" && planned.command.operation === "PROJECT_REALTIME_R_MULTIPLE") {
      expect(planned.command.netPerformance).toBe(net);
      expect(planned.command.riskBasis).toBe(basis);
    }
  });

  it("retains only the latest successful R projection by reference", () => {
    const authority = attempt();
    const basis = riskBasis(authority);
    const result = Object.freeze({
      status: "TRADE_R_MULTIPLE_PROJECTED",
      snapshot: Object.freeze({
        executionAttemptId: authority.executionAttemptId,
        executionPlanId: authority.executionPlanId,
        tradeIntentId: authority.tradeIntentId,
        candidateId: authority.candidateId,
        instrumentId: instrument,
        riskBasis: basis,
      }),
    }) as unknown as RealtimeTradeRMultipleResult;
    const planned = planLiveTradingStep(session(authority, basis), { kind: "R_MULTIPLE_RESULT", result });
    expect(planned.status).toBe("NO_ACTION");
    expect(planned.session.latestRealtimeRMultiple).toBe(result);
    expect(planned.reference).toBe(result);
  });

  it("emits at most one frozen command for every routing category", () => {
    const authority = attempt();
    const lifecycle = Object.freeze({ status: "FILL_APPLIED", executionAttempt: authority }) as unknown as RealtimeExecutionFillResult;
    const inputs = [
      { kind: "POSITION_EXPOSURE_REQUEST", input: { sourceKind: "ENTRY_FILL", fillLifecycle: lifecycle } },
      { kind: "REALIZED_ACCOUNTING_REQUEST", input: { sourceKind: "ENTRY_FILL", fillLifecycle: lifecycle, accountingSpec: { instrumentId: instrument } } },
      { kind: "VALUATION_REQUEST", input: { sourceKind: "ENTRY_FILL", fillLifecycle: lifecycle, accountingSpec: { instrumentId: instrument }, markSource: { instrumentId: instrument } } },
      { kind: "COST_ACCOUNTING_REQUEST", input: { sourceKind: "ENTRY_FILL", fillLifecycle: lifecycle, accountingSpec: { instrumentId: instrument }, observedCostEvents: [] } },
    ] as const;
    for (const input of inputs) {
      const planned = planLiveTradingStep(session(authority), input as never);
      expect(planned.status).toBe("COMMAND_PLANNED");
      expect("commands" in planned).toBe(false);
      if (planned.status === "COMMAND_PLANNED") expect(Object.isFrozen(planned.command)).toBe(true);
    }
  });

  it("rejects same-instrument valuation from another attempt before gross performance", () => {
    const authority = attempt();
    const result = Object.freeze({
      status: "UNREALIZED_VALUATION_PROJECTED",
      valuation: Object.freeze({ instrumentId: instrument, executionAttemptId: "attempt-2" }),
    }) as unknown as RealtimeTradeValuationResult;
    const planned = planLiveTradingStep(session(authority), { kind: "VALUATION_RESULT", result });
    expect(planned).toMatchObject({
      status: "ORCHESTRATION_REJECTED",
      reason: "EXECUTION_ATTEMPT_INCOHERENT",
    });
    expect("command" in planned).toBe(false);
  });

  it("rejects gross performance from another attempt", () => {
    const authority = attempt();
    const grossPerformance = Object.freeze({
      status: "TRADE_PERFORMANCE_PROJECTED",
      snapshot: Object.freeze({ instrumentId: instrument, executionAttemptId: "attempt-2" }),
    }) as unknown as RealtimeTradePerformanceResult;
    const costAccounting = Object.freeze({
      status: "TRADE_COST_ACCOUNTING_PROJECTED",
      accounting: Object.freeze({ instrumentId: instrument, executionAttemptId: "attempt-2" }),
    }) as unknown as RealtimeTradeCostAccountingResult;
    expect(planLiveTradingStep(session(authority), {
      kind: "NET_PERFORMANCE_AUTHORITIES",
      grossPerformance,
      costAccounting,
    })).toMatchObject({ status: "ORCHESTRATION_REJECTED", reason: "EXECUTION_ATTEMPT_INCOHERENT" });
  });

  it("rejects cost accounting from another attempt", () => {
    const authority = attempt();
    const grossPerformance = Object.freeze({
      status: "TRADE_PERFORMANCE_PROJECTED",
      snapshot: Object.freeze({ instrumentId: instrument, executionAttemptId: authority.executionAttemptId }),
    }) as unknown as RealtimeTradePerformanceResult;
    const costAccounting = Object.freeze({
      status: "TRADE_COST_ACCOUNTING_PROJECTED",
      accounting: Object.freeze({ instrumentId: instrument, executionAttemptId: "attempt-2" }),
    }) as unknown as RealtimeTradeCostAccountingResult;
    expect(planLiveTradingStep(session(authority), {
      kind: "NET_PERFORMANCE_AUTHORITIES",
      grossPerformance,
      costAccounting,
    })).toMatchObject({ status: "ORCHESTRATION_REJECTED", reason: "EXECUTION_ATTEMPT_INCOHERENT" });
  });

  it("rejects gross and cost authorities that disagree with each other", () => {
    const base = createLiveTradingOrchestrationSession({
      sessionId: "session-without-attempt",
      mode: "SANDBOX",
      instrumentId: instrument,
    });
    const grossPerformance = Object.freeze({
      status: "TRADE_PERFORMANCE_PROJECTED",
      snapshot: Object.freeze({ instrumentId: instrument, executionAttemptId: "attempt-1" }),
    }) as unknown as RealtimeTradePerformanceResult;
    const costAccounting = Object.freeze({
      status: "TRADE_COST_ACCOUNTING_PROJECTED",
      accounting: Object.freeze({ instrumentId: instrument, executionAttemptId: "attempt-2" }),
    }) as unknown as RealtimeTradeCostAccountingResult;
    expect(planLiveTradingStep(base, {
      kind: "NET_PERFORMANCE_AUTHORITIES",
      grossPerformance,
      costAccounting,
    })).toMatchObject({ status: "ORCHESTRATION_REJECTED", reason: "EXECUTION_ATTEMPT_INCOHERENT" });
  });

  it("rejects net performance from another attempt before R projection", () => {
    const authority = attempt();
    const basis = riskBasis(authority);
    const result = Object.freeze({
      status: "NET_TRADE_PERFORMANCE_PROJECTED",
      snapshot: Object.freeze({ instrumentId: instrument, executionAttemptId: "attempt-2" }),
    }) as unknown as RealtimeNetTradePerformanceResult;
    const planned = planLiveTradingStep(session(authority, basis), {
      kind: "NET_PERFORMANCE_RESULT",
      result,
    });
    expect(planned).toMatchObject({ status: "ORCHESTRATION_REJECTED", reason: "EXECUTION_ATTEMPT_INCOHERENT" });
    expect("command" in planned).toBe(false);
  });

  it("does not retain an R projection from another attempt", () => {
    const authority = attempt();
    const basis = riskBasis(authority);
    const base = session(authority, basis);
    const result = Object.freeze({
      status: "TRADE_R_MULTIPLE_PROJECTED",
      snapshot: Object.freeze({
        executionAttemptId: "attempt-2",
        executionPlanId: authority.executionPlanId,
        tradeIntentId: authority.tradeIntentId,
        candidateId: authority.candidateId,
        instrumentId: instrument,
        riskBasis: basis,
      }),
    }) as unknown as RealtimeTradeRMultipleResult;
    const planned = planLiveTradingStep(base, { kind: "R_MULTIPLE_RESULT", result });
    expect(planned).toMatchObject({ status: "ORCHESTRATION_REJECTED", reason: "EXECUTION_ATTEMPT_INCOHERENT" });
    expect(planned.session).toBe(base);
    expect(planned.session.latestRealtimeRMultiple).toBeUndefined();
  });

  it.each([
    ["POSITION_EXPOSURE_RESULT", "POSITION_EXPOSURE_PROJECTED", "positionExposure"],
    ["REALIZED_ACCOUNTING_RESULT", "REALIZED_ACCOUNTING_PROJECTED", "accounting"],
    ["COST_ACCOUNTING_RESULT", "TRADE_COST_ACCOUNTING_PROJECTED", "accounting"],
  ] as const)("rejects %s authority from another attempt", (kind, status, field) => {
    const authority = attempt();
    const result = Object.freeze({
      status,
      [field]: Object.freeze({ instrumentId: instrument, executionAttemptId: "attempt-2" }),
    });
    expect(planLiveTradingStep(session(authority), { kind, result } as never))
      .toMatchObject({ status: "ORCHESTRATION_REJECTED", reason: "EXECUTION_ATTEMPT_INCOHERENT" });
  });
});
