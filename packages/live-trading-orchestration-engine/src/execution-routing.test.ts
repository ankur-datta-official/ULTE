import { describe, expect, it } from "vitest";
import type { ExecutionAttempt } from "@ulte/execution-engine";
import { createInstrumentId } from "@ulte/instrument-model";
import type { FillLifecycleInitializationResult, RealtimeExecutionFillInput, RealtimeExecutionFillResult } from "@ulte/realtime-execution-fill-engine";
import type { RealtimeExecutionProtectionInput, RealtimeExecutionProtectionResult } from "@ulte/realtime-execution-protection-engine";
import type { RealtimeExecutionProtectionLifecycleInput, RealtimeExecutionProtectionLifecycleResult } from "@ulte/realtime-execution-protection-lifecycle-engine";
import type { RealtimeExecutionExitFillInput, RealtimeExecutionExitFillResult } from "@ulte/realtime-execution-exit-fill-engine";
import type { RealtimeExecutionSubmissionResult } from "@ulte/realtime-execution-submission-engine";
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

function session(mode: "DRY_RUN" | "SANDBOX", value?: ExecutionAttempt): LiveTradingOrchestrationSession {
  const base = createLiveTradingOrchestrationSession({ sessionId: "session-1", mode, instrumentId: instrument });
  return value === undefined ? base : Object.freeze({ ...base, latestExecutionAttempt: value });
}

describe("execution lifecycle routing", () => {
  it("rejects a forged legacy attempt without changing the original session", () => {
    const base = session("SANDBOX");
    const legacy = Object.freeze({
      ...attempt(),
      schemaVersion: "EXECUTION_ATTEMPT_V2",
    }) as unknown as ExecutionAttempt;
    const result = Object.freeze({
      status: "SUBMISSION_CONFIRMED",
      executionAttempt: legacy,
    }) as unknown as RealtimeExecutionSubmissionResult;
    const planned = planLiveTradingStep(base, {
      kind: "REALTIME_EXECUTION_SUBMISSION_RESULT",
      result,
    });
    expect(planned).toMatchObject({
      status: "ORCHESTRATION_REJECTED",
      reason: "EXECUTION_ATTEMPT_INCOHERENT",
    });
    expect(planned.session).toBe(base);
    expect(planned.session.latestExecutionAttempt).toBeUndefined();
    expect("command" in planned).toBe(false);
  });

  it("adopts the authoritative submission attempt by reference and initializes fill lifecycle", () => {
    const authority = attempt();
    const result = Object.freeze({ status: "SUBMISSION_CONFIRMED", executionAttempt: authority }) as unknown as RealtimeExecutionSubmissionResult;
    const planned = planLiveTradingStep(session("SANDBOX"), {
      kind: "REALTIME_EXECUTION_SUBMISSION_RESULT",
      result,
    });
    expect(planned.status).toBe("COMMAND_PLANNED");
    expect(planned.session.latestExecutionAttempt).toBe(authority);
    expect(planned.session).not.toBe(session("SANDBOX"));
    if (planned.status === "COMMAND_PLANNED") expect(planned.command.operation).toBe("INITIALIZE_REALTIME_EXECUTION_FILL_LIFECYCLE");
  });

  it("routes initialized lifecycle to the existing pure risk-basis constructor", () => {
    const authority = attempt();
    const result = Object.freeze({
      status: "FILL_LIFECYCLE_INITIALIZED",
      executionAttempt: authority,
    }) as unknown as FillLifecycleInitializationResult;
    const planned = planLiveTradingStep(session("SANDBOX", authority), {
      kind: "FILL_LIFECYCLE_INITIALIZATION_RESULT",
      result,
    });
    expect(planned).toMatchObject({ status: "COMMAND_PLANNED", command: { operation: "CREATE_TRADE_RISK_BASIS" } });
    if (planned.status === "COMMAND_PLANNED" && planned.command.operation === "CREATE_TRADE_RISK_BASIS") {
      expect(planned.command.executionAttempt).toBe(authority);
    }
  });

  it("routes normalized entry evidence only with the exact current attempt", () => {
    const authority = attempt();
    const input = Object.freeze({
      submission: Object.freeze({ status: "SUBMISSION_CONFIRMED", executionAttempt: authority }),
      executionAttempt: authority,
    }) as unknown as RealtimeExecutionFillInput;
    const planned = planLiveTradingStep(session("SANDBOX", authority), { kind: "OBSERVED_ENTRY_FILL", input });
    expect(planned).toMatchObject({ status: "COMMAND_PLANNED", command: { operation: "APPLY_REALTIME_EXECUTION_FILL" } });
    if (planned.status === "COMMAND_PLANNED" && planned.command.operation === "APPLY_REALTIME_EXECUTION_FILL") {
      expect(planned.command.input).toBe(input);
    }
  });

  it("never routes duplicate or rejected entry fills to protection", () => {
    const authority = attempt();
    for (const status of ["DUPLICATE_FILL", "FILL_REJECTED", "NO_FILL_PROCESSING"] as const) {
      const result = Object.freeze({ status, executionAttempt: authority }) as unknown as RealtimeExecutionFillResult;
      const planned = planLiveTradingStep(session("SANDBOX", authority), {
        kind: "REALTIME_ENTRY_FILL_RESULT",
        result,
      });
      expect(planned.status).toBe("NO_ACTION");
      expect("command" in planned).toBe(false);
    }
  });

  it("routes an applied partial fill to existing SANDBOX protection with exact references", () => {
    const prior = attempt();
    const updated = attempt();
    const result = Object.freeze({ status: "FILL_APPLIED", executionAttempt: updated }) as unknown as RealtimeExecutionFillResult;
    const protectionInput = Object.freeze({
      fillLifecycle: result,
      context: Object.freeze({
        executionEnvironment: "SANDBOX",
        adapterId: "adapter-1",
        credentialProfileRef: "profile-1",
        protectionAsOf: 1_200,
      }),
    }) as unknown as RealtimeExecutionProtectionInput;
    const planned = planLiveTradingStep(session("SANDBOX", prior), {
      kind: "REALTIME_ENTRY_FILL_RESULT",
      result,
      protectionInput,
    });
    expect(planned.session.latestExecutionAttempt).toBe(updated);
    expect(planned).toMatchObject({ status: "COMMAND_PLANNED", command: { operation: "SUBMIT_REALTIME_EXECUTION_PROTECTION" } });
    if (planned.status === "COMMAND_PLANNED" && planned.command.operation === "SUBMIT_REALTIME_EXECUTION_PROTECTION") {
      expect(planned.command.input).toBe(protectionInput);
    }
  });

  it("does not emit protection side effects in DRY_RUN", () => {
    const updated = attempt();
    const result = Object.freeze({ status: "FILL_APPLIED", executionAttempt: updated }) as unknown as RealtimeExecutionFillResult;
    expect(planLiveTradingStep(session("DRY_RUN", updated), {
      kind: "REALTIME_ENTRY_FILL_RESULT",
      result,
    }).status).toBe("NO_ACTION");
  });

  it("routes confirmed protection through acknowledgement and adopts its authority", () => {
    const pending = attempt();
    const result = Object.freeze({ status: "PROTECTION_CONFIRMED", executionAttempt: pending }) as unknown as RealtimeExecutionProtectionResult;
    const lifecycleInput = Object.freeze({
      protectionResult: result,
      executionAttempt: pending,
      observationAsOf: 1_300,
    }) as unknown as RealtimeExecutionProtectionLifecycleInput;
    const planned = planLiveTradingStep(session("SANDBOX", pending), {
      kind: "REALTIME_EXECUTION_PROTECTION_RESULT",
      result,
      lifecycleInput,
    });
    expect(planned.session.latestExecutionAttempt).toBe(pending);
    expect(planned).toMatchObject({ status: "COMMAND_PLANNED", command: { operation: "APPLY_REALTIME_EXECUTION_PROTECTION_ACKNOWLEDGEMENT" } });
  });

  it("adopts applied protection acknowledgement and waits for explicit exit evidence", () => {
    const updated = attempt();
    const result = Object.freeze({
      status: "PROTECTION_ACKNOWLEDGEMENT_APPLIED",
      executionAttempt: updated,
    }) as unknown as RealtimeExecutionProtectionLifecycleResult;
    const planned = planLiveTradingStep(session("SANDBOX", updated), {
      kind: "REALTIME_EXECUTION_PROTECTION_LIFECYCLE_RESULT",
      result,
    });
    expect(planned.status).toBe("NO_ACTION");
    expect(planned.session.latestExecutionAttempt).toBe(updated);
  });

  it("routes explicit exit-fill evidence but exposes no exit-submission operation", () => {
    const current = attempt();
    const lifecycle = Object.freeze({
      status: "PROTECTION_ACKNOWLEDGEMENT_APPLIED",
      executionAttempt: current,
    }) as unknown as RealtimeExecutionProtectionLifecycleResult;
    const input = Object.freeze({ protectionLifecycle: lifecycle, executionAttempt: current }) as unknown as RealtimeExecutionExitFillInput;
    const planned = planLiveTradingStep(session("SANDBOX", current), { kind: "OBSERVED_EXIT_FILL", input });
    expect(planned).toMatchObject({ status: "COMMAND_PLANNED", command: { operation: "APPLY_REALTIME_EXECUTION_EXIT_FILL" } });
    expect(JSON.stringify(planned)).not.toMatch(/SUBMIT_EXIT|CANCEL_EXIT|REPLACE_EXIT/);
  });

  it("does not progress duplicate or rejected exit results", () => {
    const current = attempt();
    for (const status of ["DUPLICATE_EXIT_FILL", "EXIT_FILL_REJECTED", "NO_EXIT_FILL_PROCESSING"] as const) {
      const result = Object.freeze({ status, executionAttempt: current }) as unknown as RealtimeExecutionExitFillResult;
      const planned = planLiveTradingStep(session("SANDBOX", current), {
        kind: "REALTIME_EXECUTION_EXIT_FILL_RESULT",
        result,
      });
      expect(planned.status).toBe("NO_ACTION");
    }
  });
});
