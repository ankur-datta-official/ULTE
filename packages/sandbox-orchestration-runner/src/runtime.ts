import type {
  LiveTradingOrchestrationCommand,
  LiveTradingOrchestrationSession,
} from "@ulte/live-trading-orchestration-engine";
import type {
  CommandExecution,
  SandboxOrchestrationRuntime,
  SideEffectExecutionRejectionReason,
} from "./types.js";

export interface CommandExecutionSafetyRejection {
  readonly status: "COMMAND_EXECUTION_SAFETY_REJECTED";
  readonly operation: LiveTradingOrchestrationCommand["operation"];
  readonly command: LiveTradingOrchestrationCommand;
  readonly reason: SideEffectExecutionRejectionReason;
}

export type CommandExecutionOutcome = CommandExecution | CommandExecutionSafetyRejection;

function safetyRejection(
  command: LiveTradingOrchestrationCommand,
  reason: SideEffectExecutionRejectionReason,
): CommandExecutionSafetyRejection {
  return Object.freeze({
    status: "COMMAND_EXECUTION_SAFETY_REJECTED",
    operation: command.operation,
    command,
    reason,
  });
}

function sideEffectSafety(
  session: LiveTradingOrchestrationSession,
  command: Extract<LiveTradingOrchestrationCommand, {
    readonly operation: "SUBMIT_REALTIME_EXECUTION" | "SUBMIT_REALTIME_EXECUTION_PROTECTION";
  }>,
): CommandExecutionSafetyRejection | undefined {
  if (session.mode === "DRY_RUN") {
    return safetyRejection(command, "SIDE_EFFECT_COMMAND_NOT_ALLOWED_IN_DRY_RUN");
  }
  if (session.mode !== "SANDBOX") {
    return safetyRejection(command, "SIDE_EFFECT_SESSION_NOT_SANDBOX");
  }
  if (command.input.context?.executionEnvironment !== "SANDBOX") {
    return safetyRejection(command, "SIDE_EFFECT_ENVIRONMENT_NOT_SANDBOX");
  }
  return undefined;
}

function assertNever(value: never): never {
  throw new TypeError(`Unsupported orchestration command: ${String(value)}`);
}

/** Executes no more than the one descriptor supplied by Task033A. */
export async function executeOrchestrationCommand(
  session: LiveTradingOrchestrationSession,
  command: LiveTradingOrchestrationCommand,
  runtime: SandboxOrchestrationRuntime,
): Promise<CommandExecutionOutcome> {
  switch (command.operation) {
    case "PROCESS_LIVE_INGESTION": {
      const result = await runtime.processLiveIngestion(
        command.event,
        command.observationTime as Parameters<SandboxOrchestrationRuntime["processLiveIngestion"]>[1],
      );
      return Object.freeze({ operation: command.operation, command, result });
    }
    case "PROCESS_REALTIME_ANALYSIS": {
      const result = await runtime.processRealtimeAnalysis(command.input);
      return Object.freeze({ operation: command.operation, command, result });
    }
    case "PROCESS_REALTIME_DECISION": {
      const result = await runtime.processRealtimeDecision(command.input);
      return Object.freeze({ operation: command.operation, command, result });
    }
    case "PROCESS_REALTIME_EXECUTION_PREPARATION": {
      const result = await runtime.processRealtimeExecutionPreparation(command.input);
      return Object.freeze({ operation: command.operation, command, result });
    }
    case "SUBMIT_REALTIME_EXECUTION": {
      const rejection = sideEffectSafety(session, command);
      if (rejection !== undefined) return rejection;
      const result = await runtime.submitRealtimeExecution(command.input);
      return Object.freeze({ operation: command.operation, command, result });
    }
    case "INITIALIZE_REALTIME_EXECUTION_FILL_LIFECYCLE": {
      const result = await runtime.initializeRealtimeExecutionFillLifecycle(command.input);
      return Object.freeze({ operation: command.operation, command, result });
    }
    case "APPLY_REALTIME_EXECUTION_FILL": {
      const result = await runtime.applyRealtimeExecutionFill(command.input);
      return Object.freeze({ operation: command.operation, command, result });
    }
    case "SUBMIT_REALTIME_EXECUTION_PROTECTION": {
      const rejection = sideEffectSafety(session, command);
      if (rejection !== undefined) return rejection;
      const result = await runtime.submitRealtimeExecutionProtection(command.input);
      return Object.freeze({ operation: command.operation, command, result });
    }
    case "APPLY_REALTIME_EXECUTION_PROTECTION_ACKNOWLEDGEMENT": {
      const result = await runtime.applyRealtimeExecutionProtectionAcknowledgement(command.input);
      return Object.freeze({ operation: command.operation, command, result });
    }
    case "APPLY_REALTIME_EXECUTION_EXIT_FILL": {
      const result = await runtime.applyRealtimeExecutionExitFill(command.input);
      return Object.freeze({ operation: command.operation, command, result });
    }
    case "CREATE_TRADE_RISK_BASIS": {
      const result = await runtime.createTradeRiskBasis(command.executionAttempt);
      return Object.freeze({ operation: command.operation, command, result });
    }
    case "PROJECT_REALTIME_POSITION_EXPOSURE": {
      const result = await runtime.projectRealtimePositionExposure(command.input);
      return Object.freeze({ operation: command.operation, command, result });
    }
    case "PROJECT_REALTIME_REALIZED_ACCOUNTING": {
      const result = await runtime.projectRealtimeRealizedAccounting(command.input);
      return Object.freeze({ operation: command.operation, command, result });
    }
    case "PROJECT_REALTIME_VALUATION": {
      const result = await runtime.projectRealtimeValuation(command.input);
      return Object.freeze({ operation: command.operation, command, result });
    }
    case "PROJECT_REALTIME_GROSS_PERFORMANCE": {
      const result = await runtime.projectRealtimeGrossPerformance(command.input);
      return Object.freeze({ operation: command.operation, command, result });
    }
    case "PROJECT_REALTIME_COST_ACCOUNTING": {
      const result = await runtime.projectRealtimeCostAccounting(command.input);
      return Object.freeze({ operation: command.operation, command, result });
    }
    case "PROJECT_REALTIME_NET_PERFORMANCE": {
      const result = await runtime.projectRealtimeNetPerformance(
        command.grossPerformance,
        command.costAccounting,
      );
      return Object.freeze({ operation: command.operation, command, result });
    }
    case "PROJECT_REALTIME_R_MULTIPLE": {
      const result = await runtime.projectRealtimeRMultiple(command.netPerformance, command.riskBasis);
      return Object.freeze({ operation: command.operation, command, result });
    }
  }
  return assertNever(command);
}
