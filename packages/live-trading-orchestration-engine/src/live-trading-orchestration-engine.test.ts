import { describe, expect, it } from "vitest";
import type { ExecutionAttempt } from "@ulte/execution-engine";
import { createInstrumentId } from "@ulte/instrument-model";
import type { LiveIngestionResult, LiveTradeEvent } from "@ulte/live-market-data-engine";
import type { RealtimeAnalysisProcessResult } from "@ulte/realtime-analysis-engine";
import type { RealtimeDecisionInput, RealtimeDecisionResult } from "@ulte/realtime-decision-engine";
import type { RealtimeExecutionPreparationResult } from "@ulte/realtime-execution-preparation-engine";
import type { RealtimeExecutionSubmissionInput } from "@ulte/realtime-execution-submission-engine";
import {
  createLiveTradingOrchestrationSession,
  LiveTradingOrchestrationEngine,
  LIVE_TRADING_ORCHESTRATION_CAPABILITIES_V1,
  planLiveTradingStep,
  type LiveTradingOrchestrationSession,
} from "./index.js";

const instrument = createInstrumentId({ venue: "test", venueSymbol: "BTC-USD", instrumentKind: "SPOT" });
const otherInstrument = createInstrumentId({ venue: "test", venueSymbol: "ETH-USD", instrumentKind: "SPOT" });

function session(mode: "DRY_RUN" | "SANDBOX" = "DRY_RUN") {
  return createLiveTradingOrchestrationSession({ sessionId: "session-1", mode, instrumentId: instrument });
}

function attempt(id = "attempt-1", selectedInstrument = instrument): ExecutionAttempt {
  return Object.freeze({
    status: "EXECUTION_ATTEMPT_READY",
    schemaVersion: "EXECUTION_ATTEMPT_V3",
    executionAttemptId: id,
    executionPlanId: "plan-1",
    tradeIntentId: "intent-1",
    candidateId: "candidate-1",
    instrumentId: selectedInstrument,
  }) as ExecutionAttempt;
}

function withAttempt(base: LiveTradingOrchestrationSession, value: ExecutionAttempt): LiveTradingOrchestrationSession {
  return Object.freeze({ ...base, latestExecutionAttempt: value });
}

describe("live trading orchestration session", () => {
  it.each(["DRY_RUN", "SANDBOX"] as const)("creates a frozen %s session", (mode) => {
    const created = session(mode);
    expect(created).toEqual({
      schemaVersion: "LIVE_TRADING_ORCHESTRATION_SESSION_V1",
      sessionId: "session-1",
      mode,
      instrumentId: instrument,
    });
    expect(Object.isFrozen(created)).toBe(true);
  });

  it("makes LIVE impossible at runtime and rejects invalid identity input", () => {
    expect(() => createLiveTradingOrchestrationSession({
      sessionId: "session-1",
      mode: "LIVE" as "SANDBOX",
      instrumentId: instrument,
    })).toThrow("DRY_RUN or SANDBOX");
    expect(() => createLiveTradingOrchestrationSession({
      sessionId: "",
      mode: "DRY_RUN",
      instrumentId: instrument,
    })).toThrow("sessionId");
    expect(() => createLiveTradingOrchestrationSession({
      sessionId: "session-1",
      mode: "DRY_RUN",
      instrumentId: "BTC-USD",
    })).toThrow("InstrumentId");
  });

  it("publishes explicit V1 safety capabilities", () => {
    expect(LIVE_TRADING_ORCHESTRATION_CAPABILITIES_V1).toEqual({
      restartRecoverySupported: false,
      callerMustSerializePerSession: true,
      maximumCommandsPerStep: 1,
      liveModeSupported: false,
      exitSubmissionSupported: false,
    });
    expect(Object.isFrozen(LIVE_TRADING_ORCHESTRATION_CAPABILITIES_V1)).toBe(true);
  });
});

describe("market and decision routing", () => {
  it("is deterministic, synchronous, immutable, and fresh-engine equivalent", () => {
    const base = session();
    const event = Object.freeze({ event: Object.freeze({ instrumentId: instrument }) }) as unknown as LiveTradeEvent;
    const input = Object.freeze({ kind: "OBSERVED_LIVE_TRADE", event, observationTime: 1_000 } as const);
    const first = planLiveTradingStep(base, input);
    const second = planLiveTradingStep(base, input);
    const wrapped = new LiveTradingOrchestrationEngine().plan(base, input);
    expect(first).toEqual(second);
    expect(wrapped).toEqual(first);
    expect(first).not.toBeInstanceOf(Promise);
    expect(first.session).toBe(base);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(input)).toBe(true);
    expect(Object.isFrozen(event)).toBe(true);
    if (first.status === "COMMAND_PLANNED") {
      expect(Object.isFrozen(first.command)).toBe(true);
      expect(first.command.operation).toBe("PROCESS_LIVE_INGESTION");
    }
  });

  it("fails closed on an observed instrument mismatch", () => {
    const event = Object.freeze({ event: Object.freeze({ instrumentId: otherInstrument }) }) as unknown as LiveTradeEvent;
    expect(planLiveTradingStep(session(), {
      kind: "OBSERVED_LIVE_TRADE",
      event,
      observationTime: 1_000,
    })).toMatchObject({ status: "ORCHESTRATION_REJECTED", reason: "INSTRUMENT_INCOHERENT" });
  });

  it.each(["DUPLICATE", "CONFLICTING_DUPLICATE", "REJECTED_OUT_OF_ORDER", "REJECTED_FUTURE"] as const)(
    "does not progress a %s ingestion result",
    (status) => {
      const result = Object.freeze({ status }) as unknown as LiveIngestionResult;
      const planned = planLiveTradingStep(session(), { kind: "LIVE_INGESTION_RESULT", result });
      expect(planned.status).toBe("NO_ACTION");
      expect(planned.reference).toBe(result);
      expect("command" in planned).toBe(false);
    },
  );

  it("routes only accepted ingestion to the existing analysis boundary", () => {
    const result = Object.freeze({ status: "ACCEPTED" }) as unknown as LiveIngestionResult;
    const planned = planLiveTradingStep(session(), { kind: "LIVE_INGESTION_RESULT", result });
    expect(planned).toMatchObject({ status: "COMMAND_PLANNED", command: { operation: "PROCESS_REALTIME_ANALYSIS" } });
    if (planned.status === "COMMAND_PLANNED" && planned.command.operation === "PROCESS_REALTIME_ANALYSIS") {
      expect(planned.command.input).toBe(result);
      expect(planned.reference).toBe(result);
    }
  });

  it.each(["INSUFFICIENT_HISTORY", "NO_SETUP"] as const)("does not progress %s analysis", (status) => {
    const input = Object.freeze({
      analysis: Object.freeze({ status, instrumentId: instrument }),
    }) as unknown as RealtimeDecisionInput;
    const result = Object.freeze({
      status: "ANALYSIS_CYCLES",
      cycles: Object.freeze([input.analysis]),
    }) as RealtimeAnalysisProcessResult;
    const planned = planLiveTradingStep(session(), { kind: "REALTIME_ANALYSIS_RESULT", result, decisionInput: input });
    expect(planned.status).toBe("NO_ACTION");
    expect(planned.reference).toBe(result);
  });

  it("requires fresh decision context for one actionable analysis", () => {
    const input = Object.freeze({
      analysis: Object.freeze({
        status: "ANALYZED",
        instrumentId: instrument,
        setup: Object.freeze({ status: "READY", candidates: Object.freeze([{ stage: "CONFIRMED" }]) }),
      }),
    }) as unknown as RealtimeDecisionInput;
    const result = Object.freeze({
      status: "ANALYSIS_CYCLES",
      cycles: Object.freeze([input.analysis]),
    }) as RealtimeAnalysisProcessResult;
    expect(planLiveTradingStep(session(), { kind: "REALTIME_ANALYSIS_RESULT", result, decisionInput: input }))
      .toMatchObject({ status: "NEEDS_CONTEXT", reason: "MISSING_REQUIRED_CONTEXT" });
  });

  it("selects one exact cycle from a multi-cycle analysis result for serialized decision routing", () => {
    const first = Object.freeze({
      status: "ANALYZED",
      instrumentId: instrument,
      setup: Object.freeze({ status: "READY", candidates: Object.freeze([]) }),
    });
    const selected = Object.freeze({
      status: "ANALYZED",
      instrumentId: instrument,
      setup: Object.freeze({ status: "READY", candidates: Object.freeze([]) }),
    });
    const result = Object.freeze({
      status: "ANALYSIS_CYCLES",
      cycles: Object.freeze([first, selected]),
    }) as unknown as RealtimeAnalysisProcessResult;
    const decisionInput = Object.freeze({ analysis: selected }) as unknown as RealtimeDecisionInput;
    const planned = planLiveTradingStep(session(), {
      kind: "REALTIME_ANALYSIS_RESULT",
      result,
      decisionInput,
    });
    expect(planned).toMatchObject({ status: "COMMAND_PLANNED", command: { operation: "PROCESS_REALTIME_DECISION" } });
    if (planned.status === "COMMAND_PLANNED" && planned.command.operation === "PROCESS_REALTIME_DECISION") {
      expect(planned.command.input).toBe(decisionInput);
    }
  });

  it.each(["NO_DECISION", "DECISION_REJECTED", "DUPLICATE_DECISION"] as const)(
    "does not turn %s into execution progression",
    (status) => {
      const result = Object.freeze({ status }) as unknown as RealtimeDecisionResult;
      const planned = planLiveTradingStep(session(), { kind: "REALTIME_DECISION_RESULT", result });
      expect(planned.status).toBe("NO_ACTION");
      expect(planned.reference).toBe(result);
    },
  );
});

describe("execution preparation safety", () => {
  function prepared(): RealtimeExecutionPreparationResult {
    return Object.freeze({
      status: "EXECUTION_PREPARED",
      executionPreparationResult: Object.freeze({ instrumentId: instrument }),
    }) as unknown as RealtimeExecutionPreparationResult;
  }

  it("preserves preparation rejection and emits no command", () => {
    const result = Object.freeze({ status: "PREPARATION_REJECTED" }) as unknown as RealtimeExecutionPreparationResult;
    const planned = planLiveTradingStep(session(), { kind: "REALTIME_EXECUTION_PREPARATION_RESULT", result });
    expect(planned.status).toBe("NO_ACTION");
    expect(planned.reference).toBe(result);
  });

  it("emits no broker-side-effect command in DRY_RUN", () => {
    expect(planLiveTradingStep(session("DRY_RUN"), {
      kind: "REALTIME_EXECUTION_PREPARATION_RESULT",
      result: prepared(),
    }).status).toBe("NO_ACTION");
  });

  it("emits exactly the existing submission coordinator descriptor in SANDBOX", () => {
    const result = prepared();
    const submissionInput = Object.freeze({
      preparation: result,
      context: Object.freeze({
        executionEnvironment: "SANDBOX",
        adapterId: "adapter-1",
        credentialProfileRef: "profile-1",
        submissionAsOf: 1_100,
      }),
    }) as unknown as RealtimeExecutionSubmissionInput;
    const planned = planLiveTradingStep(session("SANDBOX"), {
      kind: "REALTIME_EXECUTION_PREPARATION_RESULT",
      result,
      submissionInput,
    });
    expect(planned).toMatchObject({ status: "COMMAND_PLANNED", command: { operation: "SUBMIT_REALTIME_EXECUTION" } });
    if (planned.status === "COMMAND_PLANNED" && planned.command.operation === "SUBMIT_REALTIME_EXECUTION") {
      expect(planned.command.input).toBe(submissionInput);
      expect(Object.isFrozen(planned.command)).toBe(true);
    }
  });

  it("rejects LIVE context and cross-mode context", () => {
    const result = prepared();
    const input = (executionEnvironment: "LIVE" | "DRY_RUN") => ({
      preparation: result,
      context: { executionEnvironment, adapterId: "adapter-1", credentialProfileRef: "profile-1", submissionAsOf: 1_100 },
    }) as unknown as RealtimeExecutionSubmissionInput;
    expect(planLiveTradingStep(session("SANDBOX"), {
      kind: "REALTIME_EXECUTION_PREPARATION_RESULT", result, submissionInput: input("LIVE"),
    })).toMatchObject({ status: "ORCHESTRATION_REJECTED", reason: "UNSUPPORTED_LIVE_OPERATION" });
    expect(planLiveTradingStep(session("SANDBOX"), {
      kind: "REALTIME_EXECUTION_PREPARATION_RESULT", result, submissionInput: input("DRY_RUN"),
    })).toMatchObject({ status: "ORCHESTRATION_REJECTED", reason: "INPUT_INCOHERENT" });
  });

  it("rejects a second execution attempt even when the stored one is terminal-looking", () => {
    const current = attempt("attempt-1");
    const next = attempt("attempt-2");
    const base = withAttempt(session("SANDBOX"), current);
    const result = Object.freeze({ status: "SUBMISSION_CONFIRMED", executionAttempt: next }) as never;
    expect(planLiveTradingStep(base, { kind: "REALTIME_EXECUTION_SUBMISSION_RESULT", result }))
      .toMatchObject({ status: "ORCHESTRATION_REJECTED", reason: "EXECUTION_ATTEMPT_INCOHERENT" });
  });
});
