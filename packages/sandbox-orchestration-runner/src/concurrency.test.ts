import { describe, expect, it } from "vitest";
import type { RealtimeAnalysisProcessResult } from "@ulte/realtime-analysis-engine";
import { SandboxOrchestrationRunner } from "./runner.js";
import { planned, runtimeReturning, testSession } from "./test-support.js";
import type { LiveTradingOrchestrationCommand, LiveTradingOrchestrationInput } from "@ulte/live-trading-orchestration-engine";

const input = Object.freeze({ kind: "LIVE_INGESTION_RESULT", result: Object.freeze({ status: "ACCEPTED" }) }) as unknown as LiveTradingOrchestrationInput;
const command = Object.freeze({ operation: "PROCESS_REALTIME_ANALYSIS", input: input.result }) as LiveTradingOrchestrationCommand;

describe("single-flight dispatch", () => {
  it("rejects a concurrent dispatch without planning or queueing and accepts a later dispatch", async () => {
    let resolveFirst!: (value: RealtimeAnalysisProcessResult) => void;
    const pendingAuthority = new Promise<RealtimeAnalysisProcessResult>((resolve) => { resolveFirst = resolve; });
    const runtime = runtimeReturning({});
    runtime.planLiveTradingStep.mockReturnValue(planned(testSession(), command));
    runtime.processRealtimeAnalysis.mockReturnValueOnce(pendingAuthority);
    runtime.processRealtimeAnalysis.mockReturnValueOnce(Object.freeze({ status: "NO_ANALYSIS", reason: "NO_FINALIZED_CANDLE" }));
    const runner = new SandboxOrchestrationRunner({ session: testSession(), runtime });

    const first = runner.dispatch(input);
    const concurrent = await runner.dispatch(input);

    expect(concurrent.status).toBe("RUNNER_BUSY");
    expect(Object.isFrozen(concurrent)).toBe(true);
    expect(runtime.planLiveTradingStep).toHaveBeenCalledTimes(1);
    expect(runtime.processRealtimeAnalysis).toHaveBeenCalledTimes(1);

    resolveFirst(Object.freeze({ status: "NO_ANALYSIS", reason: "NO_FINALIZED_CANDLE" }));
    await expect(first).resolves.toMatchObject({ status: "COMMAND_EXECUTED" });
    await expect(runner.dispatch(input)).resolves.toMatchObject({ status: "COMMAND_EXECUTED" });
    expect(runtime.planLiveTradingStep).toHaveBeenCalledTimes(2);
    expect(runtime.processRealtimeAnalysis).toHaveBeenCalledTimes(2);
  });
});
