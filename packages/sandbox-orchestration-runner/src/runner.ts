import type {
  LiveTradingOrchestrationInput,
  LiveTradingOrchestrationSession,
} from "@ulte/live-trading-orchestration-engine";
import { executeOrchestrationCommand } from "./runtime.js";
import type {
  SandboxOrchestrationDispatchResult,
  SandboxOrchestrationRuntime,
} from "./types.js";

export interface SandboxOrchestrationRunnerOptions {
  readonly session: LiveTradingOrchestrationSession;
  readonly runtime: SandboxOrchestrationRuntime;
}

/** One in-memory Task033A session with fail-closed single-flight dispatch. */
export class SandboxOrchestrationRunner {
  readonly #runtime: SandboxOrchestrationRuntime;
  #currentSession: LiveTradingOrchestrationSession;
  #busy = false;

  constructor(options: SandboxOrchestrationRunnerOptions) {
    this.#currentSession = options.session;
    this.#runtime = Object.freeze({ ...options.runtime });
  }

  get session(): LiveTradingOrchestrationSession {
    return this.#currentSession;
  }

  async dispatch(input: LiveTradingOrchestrationInput): Promise<SandboxOrchestrationDispatchResult> {
    if (this.#busy) {
      return Object.freeze({ status: "RUNNER_BUSY", session: this.#currentSession });
    }

    this.#busy = true;
    try {
      const plannerResult = this.#runtime.planLiveTradingStep(this.#currentSession, input);
      this.#currentSession = plannerResult.session;

      switch (plannerResult.status) {
        case "NO_ACTION":
          return Object.freeze({
            status: "RUNNER_NO_ACTION",
            session: plannerResult.session,
            plannerResult,
          });
        case "NEEDS_CONTEXT":
          return Object.freeze({
            status: "RUNNER_NEEDS_CONTEXT",
            session: plannerResult.session,
            plannerResult,
          });
        case "ORCHESTRATION_REJECTED":
          return Object.freeze({
            status: "RUNNER_REJECTED",
            session: plannerResult.session,
            plannerResult,
          });
        case "COMMAND_PLANNED": {
          const command = plannerResult.command;
          try {
            const outcome = await executeOrchestrationCommand(
              plannerResult.session,
              command,
              this.#runtime,
            );
            if ("status" in outcome) {
              return Object.freeze({
                status: "COMMAND_EXECUTION_REJECTED",
                reason: outcome.reason,
                session: plannerResult.session,
                plannerResult,
                command,
              });
            }
            return Object.freeze({
              status: "COMMAND_EXECUTED",
              session: plannerResult.session,
              plannerResult,
              command,
              execution: outcome,
            });
          } catch (cause) {
            return Object.freeze({
              status: "COMMAND_EXECUTION_FAILED",
              operation: command.operation,
              session: plannerResult.session,
              plannerResult,
              command,
              cause,
            });
          }
        }
      }
    } finally {
      this.#busy = false;
    }
  }
}
