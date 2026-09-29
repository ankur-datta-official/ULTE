import { describe, expect, it } from "vitest";
import { createInstrumentId } from "@ulte/instrument-model";
import {
  createLiveTradingOrchestrationSession,
  planLiveTradingStep,
  type LiveTradingOrchestrationInput,
} from "@ulte/live-trading-orchestration-engine";
import { suggestNextOrchestrationInput } from "./result-mapping.js";
import { SandboxOrchestrationRunner } from "./runner.js";
import { runtimeReturning } from "./test-support.js";

describe("explicit caller-driven multi-dispatch progression", () => {
  it("uses the real planner once per dispatch and never auto-feeds an operation result", async () => {
    const instrumentId = createInstrumentId({ venue: "test", venueSymbol: "BTC-USD", instrumentKind: "SPOT" });
    const session = createLiveTradingOrchestrationSession({
      sessionId: "integration-session",
      mode: "SANDBOX",
      instrumentId,
    });
    const ingestionResult = Object.freeze({ status: "ACCEPTED" });
    const analysisResult = Object.freeze({ status: "NO_ANALYSIS", reason: "NO_FINALIZED_CANDLE" });
    const runtime = runtimeReturning(ingestionResult);
    runtime.planLiveTradingStep.mockImplementation(planLiveTradingStep);
    runtime.processLiveIngestion.mockReturnValue(ingestionResult);
    runtime.processRealtimeAnalysis.mockReturnValue(analysisResult);
    const runner = new SandboxOrchestrationRunner({ session, runtime });
    const observed = Object.freeze({
      kind: "OBSERVED_LIVE_TRADE",
      event: Object.freeze({ event: Object.freeze({ instrumentId }) }),
      observationTime: 1_000,
    }) as unknown as LiveTradingOrchestrationInput;

    const first = await runner.dispatch(observed);

    expect(first.status).toBe("COMMAND_EXECUTED");
    expect(runtime.planLiveTradingStep).toHaveBeenCalledTimes(1);
    expect(runtime.processLiveIngestion).toHaveBeenCalledTimes(1);
    expect(runtime.processRealtimeAnalysis).not.toHaveBeenCalled();
    if (first.status !== "COMMAND_EXECUTED") throw new Error("ingestion was not executed");
    const nextInput = suggestNextOrchestrationInput(first.execution);
    expect(nextInput).toEqual({ kind: "LIVE_INGESTION_RESULT", result: ingestionResult });

    const second = await runner.dispatch(nextInput!);

    expect(second.status).toBe("COMMAND_EXECUTED");
    expect(runtime.planLiveTradingStep).toHaveBeenCalledTimes(2);
    expect(runtime.processRealtimeAnalysis).toHaveBeenCalledTimes(1);
    expect(runtime.processRealtimeDecision).not.toHaveBeenCalled();
  });

  it("adopts an execution attempt only when its domain result is explicitly dispatched", async () => {
    const instrumentId = createInstrumentId({ venue: "test", venueSymbol: "BTC-USD", instrumentKind: "SPOT" });
    const initial = createLiveTradingOrchestrationSession({ sessionId: "adoption", mode: "SANDBOX", instrumentId });
    const executionAttempt = Object.freeze({
      schemaVersion: "EXECUTION_ATTEMPT_V3",
      status: "EXECUTION_ATTEMPT_READY",
      executionAttemptId: "attempt-1",
      executionPlanId: "plan-1",
      tradeIntentId: "intent-1",
      candidateId: "candidate-1",
      instrumentId,
    });
    const submission = Object.freeze({ status: "SUBMISSION_CONFIRMED", executionAttempt });
    const initialized = Object.freeze({ status: "FILL_LIFECYCLE_INITIALIZED", executionAttempt });
    const runtime = runtimeReturning(initialized);
    runtime.planLiveTradingStep.mockImplementation(planLiveTradingStep);
    runtime.initializeRealtimeExecutionFillLifecycle.mockReturnValue(initialized);
    const runner = new SandboxOrchestrationRunner({ session: initial, runtime });

    expect(runner.session.latestExecutionAttempt).toBeUndefined();
    const dispatch = await runner.dispatch({
      kind: "REALTIME_EXECUTION_SUBMISSION_RESULT",
      result: submission,
    } as unknown as LiveTradingOrchestrationInput);

    expect(dispatch.status).toBe("COMMAND_EXECUTED");
    expect(runner.session.latestExecutionAttempt).toBe(executionAttempt);
    expect(runtime.initializeRealtimeExecutionFillLifecycle).toHaveBeenCalledTimes(1);
    expect(runtime.createTradeRiskBasis).not.toHaveBeenCalled();
  });
});
