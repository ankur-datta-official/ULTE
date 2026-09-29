import type {
  CommandPlannedResult,
  LiveTradingOrchestrationCommand,
  LiveTradingOrchestrationSession,
} from "@ulte/live-trading-orchestration-engine";
import { vi, type Mock } from "vitest";
import type { SandboxOrchestrationRuntime } from "./types.js";

export function testSession(
  mode: "DRY_RUN" | "SANDBOX" = "SANDBOX",
): LiveTradingOrchestrationSession {
  return Object.freeze({
    schemaVersion: "LIVE_TRADING_ORCHESTRATION_SESSION_V1",
    sessionId: "runner-session",
    mode,
    instrumentId: "test:SPOT:BTC-USD",
  }) as LiveTradingOrchestrationSession;
}

export function planned(
  session: LiveTradingOrchestrationSession,
  command: LiveTradingOrchestrationCommand,
): CommandPlannedResult {
  return Object.freeze({ status: "COMMAND_PLANNED", session, command });
}

export type RuntimeMocks = Readonly<Record<keyof SandboxOrchestrationRuntime, Mock>>;

export function runtimeReturning(result: unknown): SandboxOrchestrationRuntime & RuntimeMocks {
  const operation = () => result;
  return {
    planLiveTradingStep: vi.fn(),
    processLiveIngestion: vi.fn(operation),
    processRealtimeAnalysis: vi.fn(operation),
    processRealtimeDecision: vi.fn(operation),
    processRealtimeExecutionPreparation: vi.fn(operation),
    submitRealtimeExecution: vi.fn(operation),
    initializeRealtimeExecutionFillLifecycle: vi.fn(operation),
    applyRealtimeExecutionFill: vi.fn(operation),
    submitRealtimeExecutionProtection: vi.fn(operation),
    applyRealtimeExecutionProtectionAcknowledgement: vi.fn(operation),
    applyRealtimeExecutionExitFill: vi.fn(operation),
    createTradeRiskBasis: vi.fn(operation),
    projectRealtimePositionExposure: vi.fn(operation),
    projectRealtimeRealizedAccounting: vi.fn(operation),
    projectRealtimeValuation: vi.fn(operation),
    projectRealtimeGrossPerformance: vi.fn(operation),
    projectRealtimeCostAccounting: vi.fn(operation),
    projectRealtimeNetPerformance: vi.fn(operation),
    projectRealtimeRMultiple: vi.fn(operation),
  } as unknown as SandboxOrchestrationRuntime & RuntimeMocks;
}
