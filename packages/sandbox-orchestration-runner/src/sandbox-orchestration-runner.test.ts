import { describe, expect, it, vi } from "vitest";
import type {
  LiveTradingOrchestrationCommand,
  LiveTradingOrchestrationInput,
  LiveTradingOrchestrationSession,
  LiveTradingOrchestrationStepResult,
} from "@ulte/live-trading-orchestration-engine";
import { SandboxOrchestrationRunner } from "./runner.js";
import { planned, runtimeReturning, testSession } from "./test-support.js";
import { SANDBOX_ORCHESTRATION_RUNNER_CAPABILITIES_V1 } from "./types.js";

const input = Object.freeze({ kind: "LIVE_INGESTION_RESULT", result: Object.freeze({ status: "DUPLICATE" }) }) as unknown as LiveTradingOrchestrationInput;
const command = Object.freeze({
  operation: "PROCESS_REALTIME_ANALYSIS",
  input: Object.freeze({ status: "ACCEPTED" }),
}) as unknown as LiveTradingOrchestrationCommand;

function result(
  status: "NO_ACTION" | "NEEDS_CONTEXT" | "ORCHESTRATION_REJECTED",
  session: LiveTradingOrchestrationSession,
): LiveTradingOrchestrationStepResult {
  if (status === "NEEDS_CONTEXT") {
    return Object.freeze({ status, reason: "MISSING_REQUIRED_CONTEXT", session });
  }
  if (status === "ORCHESTRATION_REJECTED") {
    return Object.freeze({ status, reason: "INPUT_INCOHERENT", session });
  }
  return Object.freeze({ status, session });
}

describe("SandboxOrchestrationRunner", () => {
  it("preserves the exact initial session and publishes frozen non-LIVE capabilities", () => {
    const initial = testSession();
    const runner = new SandboxOrchestrationRunner({ session: initial, runtime: runtimeReturning({}) });
    expect(runner.session).toBe(initial);
    expect(SANDBOX_ORCHESTRATION_RUNNER_CAPABILITIES_V1).toEqual({
      liveModeSupported: false,
      restartRecoverySupported: false,
      exitSubmissionSupported: false,
      durableSessionSupported: false,
      multiInstrumentSupported: false,
      concurrentDispatchSupported: false,
      maximumCommandsPerDispatch: 1,
      hiddenRetries: false,
    });
    expect(Object.isFrozen(SANDBOX_ORCHESTRATION_RUNNER_CAPABILITIES_V1)).toBe(true);
  });

  it.each([
    ["NO_ACTION", "RUNNER_NO_ACTION"],
    ["NEEDS_CONTEXT", "RUNNER_NEEDS_CONTEXT"],
    ["ORCHESTRATION_REJECTED", "RUNNER_REJECTED"],
  ] as const)("preserves an exact %s planner result and invokes no operation", async (plannerStatus, runnerStatus) => {
    const initial = testSession();
    const plannerResult = result(plannerStatus, initial);
    const runtime = runtimeReturning({});
    runtime.planLiveTradingStep.mockReturnValue(plannerResult);
    const runner = new SandboxOrchestrationRunner({ session: initial, runtime });

    const pending = runner.dispatch(input);
    expect(pending).toBeInstanceOf(Promise);
    const dispatch = await pending;

    expect(dispatch.status).toBe(runnerStatus);
    expect("plannerResult" in dispatch && dispatch.plannerResult).toBe(plannerResult);
    expect(runtime.planLiveTradingStep).toHaveBeenCalledTimes(1);
    expect(runtime.processRealtimeAnalysis).not.toHaveBeenCalled();
    expect(Object.isFrozen(dispatch)).toBe(true);
  });

  it("executes one command once and preserves planner, command, session, and domain-result references", async () => {
    const initial = testSession();
    const next = Object.freeze({ ...initial }) as LiveTradingOrchestrationSession;
    const plannerResult = planned(next, command);
    const authorityResult = Object.freeze({ status: "DOMAIN_REJECTED" });
    const runtime = runtimeReturning(authorityResult);
    runtime.planLiveTradingStep.mockReturnValue(plannerResult);
    const runner = new SandboxOrchestrationRunner({ session: initial, runtime });

    const dispatch = await runner.dispatch(input);

    expect(dispatch.status).toBe("COMMAND_EXECUTED");
    if (dispatch.status === "COMMAND_EXECUTED") {
      expect(dispatch.plannerResult).toBe(plannerResult);
      expect(dispatch.command).toBe(command);
      expect(dispatch.execution.command).toBe(command);
      expect(dispatch.execution.result).toBe(authorityResult);
    }
    expect(runner.session).toBe(next);
    expect(runtime.planLiveTradingStep).toHaveBeenCalledTimes(1);
    expect(runtime.processRealtimeAnalysis).toHaveBeenCalledTimes(1);
  });

  it("returns a runner failure for a synchronous throw, does not retry, and retains the planner session", async () => {
    const initial = testSession();
    const next = Object.freeze({ ...initial }) as LiveTradingOrchestrationSession;
    const failure = new Error("injected sync failure");
    const runtime = runtimeReturning({});
    runtime.planLiveTradingStep.mockReturnValue(planned(next, command));
    runtime.processRealtimeAnalysis.mockImplementationOnce(() => { throw failure; });
    runtime.processRealtimeAnalysis.mockReturnValueOnce(Object.freeze({ status: "SECOND_WORKED" }));
    const runner = new SandboxOrchestrationRunner({ session: initial, runtime });

    const first = await runner.dispatch(input);
    const second = await runner.dispatch(input);

    expect(first).toMatchObject({ status: "COMMAND_EXECUTION_FAILED", cause: failure });
    expect(runner.session).toBe(next);
    expect(runtime.processRealtimeAnalysis).toHaveBeenCalledTimes(2);
    expect(second.status).toBe("COMMAND_EXECUTED");
  });

  it("returns a runner failure for an async rejection and clears busy state", async () => {
    const runtime = runtimeReturning({});
    runtime.planLiveTradingStep.mockReturnValue(planned(testSession(), command));
    const failure = new Error("injected async failure");
    runtime.processRealtimeAnalysis.mockRejectedValueOnce(failure);
    runtime.processRealtimeAnalysis.mockResolvedValueOnce(Object.freeze({ status: "RECOVERED" }));
    const runner = new SandboxOrchestrationRunner({ session: testSession(), runtime });

    await expect(runner.dispatch(input)).resolves.toMatchObject({
      status: "COMMAND_EXECUTION_FAILED",
      cause: failure,
    });
    await expect(runner.dispatch(input)).resolves.toMatchObject({ status: "COMMAND_EXECUTED" });
  });

  it("does not reinterpret normal rejected or duplicate domain results", async () => {
    const domainResults = [
      Object.freeze({ status: "SUBMISSION_REJECTED" }),
      Object.freeze({ status: "DUPLICATE_SUBMISSION" }),
    ];
    for (const authorityResult of domainResults) {
      const runtime = runtimeReturning(authorityResult);
      runtime.planLiveTradingStep.mockReturnValue(planned(testSession(), command));
      const dispatch = await new SandboxOrchestrationRunner({ session: testSession(), runtime }).dispatch(input);
      expect(dispatch.status).toBe("COMMAND_EXECUTED");
      if (dispatch.status === "COMMAND_EXECUTED") expect(dispatch.execution.result).toBe(authorityResult);
    }
  });
});
