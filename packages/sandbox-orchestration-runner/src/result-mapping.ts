import type { LiveTradingOrchestrationInput } from "@ulte/live-trading-orchestration-engine";
import type { CommandExecution } from "./types.js";

/** Suggests only exact Task033A result inputs; caller-owned context is never invented. */
export function suggestNextOrchestrationInput(
  execution: CommandExecution,
): LiveTradingOrchestrationInput | undefined {
  switch (execution.operation) {
    case "PROCESS_LIVE_INGESTION":
      return Object.freeze({ kind: "LIVE_INGESTION_RESULT", result: execution.result });
    case "PROCESS_REALTIME_ANALYSIS":
      return Object.freeze({ kind: "REALTIME_ANALYSIS_RESULT", result: execution.result });
    case "PROCESS_REALTIME_DECISION":
      return Object.freeze({ kind: "REALTIME_DECISION_RESULT", result: execution.result });
    case "PROCESS_REALTIME_EXECUTION_PREPARATION":
      return Object.freeze({ kind: "REALTIME_EXECUTION_PREPARATION_RESULT", result: execution.result });
    case "SUBMIT_REALTIME_EXECUTION":
      return Object.freeze({ kind: "REALTIME_EXECUTION_SUBMISSION_RESULT", result: execution.result });
    case "INITIALIZE_REALTIME_EXECUTION_FILL_LIFECYCLE":
      return Object.freeze({ kind: "FILL_LIFECYCLE_INITIALIZATION_RESULT", result: execution.result });
    case "APPLY_REALTIME_EXECUTION_FILL":
      return Object.freeze({ kind: "REALTIME_ENTRY_FILL_RESULT", result: execution.result });
    case "SUBMIT_REALTIME_EXECUTION_PROTECTION":
      return Object.freeze({ kind: "REALTIME_EXECUTION_PROTECTION_RESULT", result: execution.result });
    case "APPLY_REALTIME_EXECUTION_PROTECTION_ACKNOWLEDGEMENT":
      return Object.freeze({
        kind: "REALTIME_EXECUTION_PROTECTION_LIFECYCLE_RESULT",
        result: execution.result,
      });
    case "APPLY_REALTIME_EXECUTION_EXIT_FILL":
      return Object.freeze({ kind: "REALTIME_EXECUTION_EXIT_FILL_RESULT", result: execution.result });
    case "CREATE_TRADE_RISK_BASIS":
      return Object.freeze({ kind: "TRADE_RISK_BASIS_CREATION_RESULT", result: execution.result });
    case "PROJECT_REALTIME_POSITION_EXPOSURE":
      return Object.freeze({ kind: "POSITION_EXPOSURE_RESULT", result: execution.result });
    case "PROJECT_REALTIME_REALIZED_ACCOUNTING":
      return Object.freeze({ kind: "REALIZED_ACCOUNTING_RESULT", result: execution.result });
    case "PROJECT_REALTIME_VALUATION":
      return Object.freeze({ kind: "VALUATION_RESULT", result: execution.result });
    case "PROJECT_REALTIME_COST_ACCOUNTING":
      return Object.freeze({ kind: "COST_ACCOUNTING_RESULT", result: execution.result });
    case "PROJECT_REALTIME_NET_PERFORMANCE":
      return Object.freeze({ kind: "NET_PERFORMANCE_RESULT", result: execution.result });
    case "PROJECT_REALTIME_R_MULTIPLE":
      return Object.freeze({ kind: "R_MULTIPLE_RESULT", result: execution.result });
    case "PROJECT_REALTIME_GROSS_PERFORMANCE":
      return undefined;
  }
}
