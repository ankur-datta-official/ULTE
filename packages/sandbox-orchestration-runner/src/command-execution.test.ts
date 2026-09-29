import { describe, expect, it } from "vitest";
import type {
  LiveTradingOrchestrationCommand,
  LiveTradingOrchestrationSession,
} from "@ulte/live-trading-orchestration-engine";
import { executeOrchestrationCommand } from "./runtime.js";
import { runtimeReturning, testSession } from "./test-support.js";
import type { SandboxOrchestrationRuntime } from "./types.js";

const opaque = Object.freeze({ authority: true });
const sandboxContext = Object.freeze({ executionEnvironment: "SANDBOX" });

function forgedSessionMode(mode: string): LiveTradingOrchestrationSession {
  return Object.freeze({ ...testSession(), mode }) as unknown as LiveTradingOrchestrationSession;
}

const cases: readonly Readonly<{
  operation: LiveTradingOrchestrationCommand["operation"];
  runtimeKey: Exclude<keyof SandboxOrchestrationRuntime, "planLiveTradingStep">;
  command: LiveTradingOrchestrationCommand;
  expectedArguments: readonly unknown[];
}>[] = [
  {
    operation: "PROCESS_LIVE_INGESTION",
    runtimeKey: "processLiveIngestion",
    command: { operation: "PROCESS_LIVE_INGESTION", event: opaque, observationTime: 10 } as unknown as LiveTradingOrchestrationCommand,
    expectedArguments: [opaque, 10],
  },
  {
    operation: "PROCESS_REALTIME_ANALYSIS",
    runtimeKey: "processRealtimeAnalysis",
    command: { operation: "PROCESS_REALTIME_ANALYSIS", input: opaque } as unknown as LiveTradingOrchestrationCommand,
    expectedArguments: [opaque],
  },
  {
    operation: "PROCESS_REALTIME_DECISION",
    runtimeKey: "processRealtimeDecision",
    command: { operation: "PROCESS_REALTIME_DECISION", input: opaque } as unknown as LiveTradingOrchestrationCommand,
    expectedArguments: [opaque],
  },
  {
    operation: "PROCESS_REALTIME_EXECUTION_PREPARATION",
    runtimeKey: "processRealtimeExecutionPreparation",
    command: { operation: "PROCESS_REALTIME_EXECUTION_PREPARATION", input: opaque } as unknown as LiveTradingOrchestrationCommand,
    expectedArguments: [opaque],
  },
  {
    operation: "SUBMIT_REALTIME_EXECUTION",
    runtimeKey: "submitRealtimeExecution",
    command: { operation: "SUBMIT_REALTIME_EXECUTION", input: { context: sandboxContext } } as unknown as LiveTradingOrchestrationCommand,
    expectedArguments: [{ context: sandboxContext }],
  },
  {
    operation: "INITIALIZE_REALTIME_EXECUTION_FILL_LIFECYCLE",
    runtimeKey: "initializeRealtimeExecutionFillLifecycle",
    command: { operation: "INITIALIZE_REALTIME_EXECUTION_FILL_LIFECYCLE", input: opaque } as unknown as LiveTradingOrchestrationCommand,
    expectedArguments: [opaque],
  },
  {
    operation: "APPLY_REALTIME_EXECUTION_FILL",
    runtimeKey: "applyRealtimeExecutionFill",
    command: { operation: "APPLY_REALTIME_EXECUTION_FILL", input: opaque } as unknown as LiveTradingOrchestrationCommand,
    expectedArguments: [opaque],
  },
  {
    operation: "SUBMIT_REALTIME_EXECUTION_PROTECTION",
    runtimeKey: "submitRealtimeExecutionProtection",
    command: { operation: "SUBMIT_REALTIME_EXECUTION_PROTECTION", input: { context: sandboxContext } } as unknown as LiveTradingOrchestrationCommand,
    expectedArguments: [{ context: sandboxContext }],
  },
  {
    operation: "APPLY_REALTIME_EXECUTION_PROTECTION_ACKNOWLEDGEMENT",
    runtimeKey: "applyRealtimeExecutionProtectionAcknowledgement",
    command: { operation: "APPLY_REALTIME_EXECUTION_PROTECTION_ACKNOWLEDGEMENT", input: opaque } as unknown as LiveTradingOrchestrationCommand,
    expectedArguments: [opaque],
  },
  {
    operation: "APPLY_REALTIME_EXECUTION_EXIT_FILL",
    runtimeKey: "applyRealtimeExecutionExitFill",
    command: { operation: "APPLY_REALTIME_EXECUTION_EXIT_FILL", input: opaque } as unknown as LiveTradingOrchestrationCommand,
    expectedArguments: [opaque],
  },
  {
    operation: "CREATE_TRADE_RISK_BASIS",
    runtimeKey: "createTradeRiskBasis",
    command: { operation: "CREATE_TRADE_RISK_BASIS", executionAttempt: opaque } as unknown as LiveTradingOrchestrationCommand,
    expectedArguments: [opaque],
  },
  {
    operation: "PROJECT_REALTIME_POSITION_EXPOSURE",
    runtimeKey: "projectRealtimePositionExposure",
    command: { operation: "PROJECT_REALTIME_POSITION_EXPOSURE", input: opaque } as unknown as LiveTradingOrchestrationCommand,
    expectedArguments: [opaque],
  },
  {
    operation: "PROJECT_REALTIME_REALIZED_ACCOUNTING",
    runtimeKey: "projectRealtimeRealizedAccounting",
    command: { operation: "PROJECT_REALTIME_REALIZED_ACCOUNTING", input: opaque } as unknown as LiveTradingOrchestrationCommand,
    expectedArguments: [opaque],
  },
  {
    operation: "PROJECT_REALTIME_VALUATION",
    runtimeKey: "projectRealtimeValuation",
    command: { operation: "PROJECT_REALTIME_VALUATION", input: opaque } as unknown as LiveTradingOrchestrationCommand,
    expectedArguments: [opaque],
  },
  {
    operation: "PROJECT_REALTIME_GROSS_PERFORMANCE",
    runtimeKey: "projectRealtimeGrossPerformance",
    command: { operation: "PROJECT_REALTIME_GROSS_PERFORMANCE", input: opaque } as unknown as LiveTradingOrchestrationCommand,
    expectedArguments: [opaque],
  },
  {
    operation: "PROJECT_REALTIME_COST_ACCOUNTING",
    runtimeKey: "projectRealtimeCostAccounting",
    command: { operation: "PROJECT_REALTIME_COST_ACCOUNTING", input: opaque } as unknown as LiveTradingOrchestrationCommand,
    expectedArguments: [opaque],
  },
  {
    operation: "PROJECT_REALTIME_NET_PERFORMANCE",
    runtimeKey: "projectRealtimeNetPerformance",
    command: { operation: "PROJECT_REALTIME_NET_PERFORMANCE", grossPerformance: opaque, costAccounting: opaque } as unknown as LiveTradingOrchestrationCommand,
    expectedArguments: [opaque, opaque],
  },
  {
    operation: "PROJECT_REALTIME_R_MULTIPLE",
    runtimeKey: "projectRealtimeRMultiple",
    command: { operation: "PROJECT_REALTIME_R_MULTIPLE", netPerformance: opaque, riskBasis: opaque } as unknown as LiveTradingOrchestrationCommand,
    expectedArguments: [opaque, opaque],
  },
];

describe("exhaustive command execution", () => {
  it.each(cases)("maps $operation once to $runtimeKey", async ({ command, runtimeKey, expectedArguments }) => {
    const authorityResult = Object.freeze({ status: "DOMAIN_REJECTION_OR_DUPLICATE" });
    const runtime = runtimeReturning(authorityResult);

    const execution = await executeOrchestrationCommand(testSession(), command, runtime);

    expect(runtime[runtimeKey]).toHaveBeenCalledTimes(1);
    expect(runtime[runtimeKey]).toHaveBeenCalledWith(...expectedArguments);
    expect("status" in execution).toBe(false);
    if (!("status" in execution)) {
      expect(execution.command).toBe(command);
      expect(execution.result).toBe(authorityResult);
      expect(Object.isFrozen(execution)).toBe(true);
    }
    const totalCalls = cases.reduce((count, item) => count + runtime[item.runtimeKey].mock.calls.length, 0);
    expect(totalCalls).toBe(1);
  });

  it.each([
    "SUBMIT_REALTIME_EXECUTION",
    "SUBMIT_REALTIME_EXECUTION_PROTECTION",
  ] as const)("rejects %s in DRY_RUN without invoking a coordinator", async (operation) => {
    const runtime = runtimeReturning(opaque);
    const runtimeKey = operation === "SUBMIT_REALTIME_EXECUTION"
      ? "submitRealtimeExecution"
      : "submitRealtimeExecutionProtection";
    const command = {
      operation,
      input: { context: sandboxContext },
    } as unknown as LiveTradingOrchestrationCommand;

    const outcome = await executeOrchestrationCommand(testSession("DRY_RUN"), command, runtime);

    expect(outcome).toMatchObject({
      status: "COMMAND_EXECUTION_SAFETY_REJECTED",
      reason: "SIDE_EFFECT_COMMAND_NOT_ALLOWED_IN_DRY_RUN",
    });
    expect(runtime[runtimeKey]).not.toHaveBeenCalled();
  });

  it.each([
    ["SUBMIT_REALTIME_EXECUTION", "submitRealtimeExecution"],
    ["SUBMIT_REALTIME_EXECUTION_PROTECTION", "submitRealtimeExecutionProtection"],
  ] as const)("rejects %s for a forged LIVE session even with SANDBOX command context", async (operation, runtimeKey) => {
    const runtime = runtimeReturning(opaque);
    const command = {
      operation,
      input: { context: sandboxContext },
    } as unknown as LiveTradingOrchestrationCommand;

    const outcome = await executeOrchestrationCommand(forgedSessionMode("LIVE"), command, runtime);

    expect(outcome).toMatchObject({
      status: "COMMAND_EXECUTION_SAFETY_REJECTED",
      reason: "SIDE_EFFECT_SESSION_NOT_SANDBOX",
    });
    expect(runtime[runtimeKey]).not.toHaveBeenCalled();
  });

  it("rejects an unknown malformed session mode even with SANDBOX command context", async () => {
    const runtime = runtimeReturning(opaque);
    const command = {
      operation: "SUBMIT_REALTIME_EXECUTION",
      input: { context: sandboxContext },
    } as unknown as LiveTradingOrchestrationCommand;

    const outcome = await executeOrchestrationCommand(forgedSessionMode("UNKNOWN_MODE"), command, runtime);

    expect(outcome).toMatchObject({
      status: "COMMAND_EXECUTION_SAFETY_REJECTED",
      reason: "SIDE_EFFECT_SESSION_NOT_SANDBOX",
    });
    expect(runtime.submitRealtimeExecution).not.toHaveBeenCalled();
  });

  it.each([
    ["SUBMIT_REALTIME_EXECUTION", "submitRealtimeExecution"],
    ["SUBMIT_REALTIME_EXECUTION_PROTECTION", "submitRealtimeExecutionProtection"],
  ] as const)("executes %s exactly once for matching SANDBOX session and context", async (operation, runtimeKey) => {
    const authorityResult = Object.freeze({ status: "AUTHORITATIVE_RESULT" });
    const runtime = runtimeReturning(authorityResult);
    const command = {
      operation,
      input: { context: sandboxContext },
    } as unknown as LiveTradingOrchestrationCommand;

    const outcome = await executeOrchestrationCommand(testSession("SANDBOX"), command, runtime);

    expect("status" in outcome).toBe(false);
    expect(runtime[runtimeKey]).toHaveBeenCalledTimes(1);
  });

  it.each(["DRY_RUN", "LIVE", undefined] as const)(
    "rejects a %s command context against a SANDBOX session",
    async (executionEnvironment) => {
      const runtime = runtimeReturning(opaque);
      const command = {
        operation: "SUBMIT_REALTIME_EXECUTION",
        input: { context: executionEnvironment === undefined ? undefined : { executionEnvironment } },
      } as unknown as LiveTradingOrchestrationCommand;
      const outcome = await executeOrchestrationCommand(testSession(), command, runtime);
      expect(outcome).toMatchObject({
        status: "COMMAND_EXECUTION_SAFETY_REJECTED",
        reason: "SIDE_EFFECT_ENVIRONMENT_NOT_SANDBOX",
      });
      expect(runtime.submitRealtimeExecution).not.toHaveBeenCalled();
    },
  );
});
