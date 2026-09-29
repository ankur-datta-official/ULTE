import type { LiveIngestionResult, LiveTradeIngestionEngine } from "@ulte/live-market-data-engine";
import type {
  CommandPlannedResult,
  LiveTradingOrchestrationCommand,
  LiveTradingOrchestrationSession,
  LiveTradingOrchestrationStepResult,
  NeedsContextResult,
  NoActionResult,
  OrchestrationRejectedResult,
  planLiveTradingStep,
} from "@ulte/live-trading-orchestration-engine";
import type { RealtimeAnalysisEngine, RealtimeAnalysisProcessResult } from "@ulte/realtime-analysis-engine";
import type { RealtimeDecisionEngine, RealtimeDecisionResult } from "@ulte/realtime-decision-engine";
import type {
  RealtimeExecutionExitFillResult,
  applyRealtimeExecutionExitFill,
} from "@ulte/realtime-execution-exit-fill-engine";
import type {
  FillLifecycleInitializationResult,
  RealtimeExecutionFillResult,
  applyRealtimeExecutionFill,
  initializeRealtimeExecutionFillLifecycle,
} from "@ulte/realtime-execution-fill-engine";
import type {
  RealtimeExecutionPreparationEngine,
  RealtimeExecutionPreparationResult,
} from "@ulte/realtime-execution-preparation-engine";
import type {
  RealtimeExecutionProtectionEngine,
  RealtimeExecutionProtectionResult,
} from "@ulte/realtime-execution-protection-engine";
import type {
  RealtimeExecutionProtectionLifecycleResult,
  applyRealtimeExecutionProtectionAcknowledgement,
} from "@ulte/realtime-execution-protection-lifecycle-engine";
import type {
  RealtimeExecutionSubmissionEngine,
  RealtimeExecutionSubmissionResult,
} from "@ulte/realtime-execution-submission-engine";
import type {
  RealtimeNetTradePerformanceResult,
  projectRealtimeNetTradePerformance,
} from "@ulte/realtime-net-trade-performance-engine";
import type {
  RealtimePositionExposureResult,
  projectRealtimePositionExposure,
} from "@ulte/realtime-position-exposure-engine";
import type {
  RealtimeTradeAccountingResult,
  projectRealtimeTradeAccounting,
} from "@ulte/realtime-trade-accounting-engine";
import type {
  RealtimeTradeCostAccountingResult,
  projectRealtimeTradeCostAccounting,
} from "@ulte/realtime-trade-cost-accounting-engine";
import type {
  RealtimeTradePerformanceResult,
  projectRealtimeTradePerformance,
} from "@ulte/realtime-trade-performance-engine";
import type {
  RealtimeTradeRMultipleResult,
  projectRealtimeTradeRMultiple,
} from "@ulte/realtime-trade-r-multiple-engine";
import type {
  RealtimeTradeValuationResult,
  projectRealtimeTradeValuation,
} from "@ulte/realtime-trade-valuation-engine";
import type {
  TradeRiskBasisCreationResult,
  createTradeRiskBasisFromExecutionAttempt,
} from "@ulte/trade-r-multiple-engine";

export const SANDBOX_ORCHESTRATION_RUNNER_CAPABILITIES_V1 = Object.freeze({
  liveModeSupported: false,
  restartRecoverySupported: false,
  exitSubmissionSupported: false,
  durableSessionSupported: false,
  multiInstrumentSupported: false,
  concurrentDispatchSupported: false,
  maximumCommandsPerDispatch: 1,
  hiddenRetries: false,
} as const);

/** Existing configured APIs only; stateful engine methods must be bound to their owning instances. */
export interface SandboxOrchestrationRuntime {
  readonly planLiveTradingStep: typeof planLiveTradingStep;
  readonly processLiveIngestion: LiveTradeIngestionEngine["ingest"];
  readonly processRealtimeAnalysis: RealtimeAnalysisEngine["processLiveIngestion"];
  readonly processRealtimeDecision: RealtimeDecisionEngine["process"];
  readonly processRealtimeExecutionPreparation: RealtimeExecutionPreparationEngine["process"];
  readonly submitRealtimeExecution: RealtimeExecutionSubmissionEngine["submit"];
  readonly initializeRealtimeExecutionFillLifecycle: typeof initializeRealtimeExecutionFillLifecycle;
  readonly applyRealtimeExecutionFill: typeof applyRealtimeExecutionFill;
  readonly submitRealtimeExecutionProtection: RealtimeExecutionProtectionEngine["submit"];
  readonly applyRealtimeExecutionProtectionAcknowledgement: typeof applyRealtimeExecutionProtectionAcknowledgement;
  readonly applyRealtimeExecutionExitFill: typeof applyRealtimeExecutionExitFill;
  readonly createTradeRiskBasis: typeof createTradeRiskBasisFromExecutionAttempt;
  readonly projectRealtimePositionExposure: typeof projectRealtimePositionExposure;
  readonly projectRealtimeRealizedAccounting: typeof projectRealtimeTradeAccounting;
  readonly projectRealtimeValuation: typeof projectRealtimeTradeValuation;
  readonly projectRealtimeGrossPerformance: typeof projectRealtimeTradePerformance;
  readonly projectRealtimeCostAccounting: typeof projectRealtimeTradeCostAccounting;
  readonly projectRealtimeNetPerformance: typeof projectRealtimeNetTradePerformance;
  readonly projectRealtimeRMultiple: typeof projectRealtimeTradeRMultiple;
}

export interface CommandExecutionResultMap {
  readonly PROCESS_LIVE_INGESTION: LiveIngestionResult;
  readonly PROCESS_REALTIME_ANALYSIS: RealtimeAnalysisProcessResult;
  readonly PROCESS_REALTIME_DECISION: RealtimeDecisionResult;
  readonly PROCESS_REALTIME_EXECUTION_PREPARATION: RealtimeExecutionPreparationResult;
  readonly SUBMIT_REALTIME_EXECUTION: RealtimeExecutionSubmissionResult;
  readonly INITIALIZE_REALTIME_EXECUTION_FILL_LIFECYCLE: FillLifecycleInitializationResult;
  readonly APPLY_REALTIME_EXECUTION_FILL: RealtimeExecutionFillResult;
  readonly SUBMIT_REALTIME_EXECUTION_PROTECTION: RealtimeExecutionProtectionResult;
  readonly APPLY_REALTIME_EXECUTION_PROTECTION_ACKNOWLEDGEMENT: RealtimeExecutionProtectionLifecycleResult;
  readonly APPLY_REALTIME_EXECUTION_EXIT_FILL: RealtimeExecutionExitFillResult;
  readonly CREATE_TRADE_RISK_BASIS: TradeRiskBasisCreationResult;
  readonly PROJECT_REALTIME_POSITION_EXPOSURE: RealtimePositionExposureResult;
  readonly PROJECT_REALTIME_REALIZED_ACCOUNTING: RealtimeTradeAccountingResult;
  readonly PROJECT_REALTIME_VALUATION: RealtimeTradeValuationResult;
  readonly PROJECT_REALTIME_GROSS_PERFORMANCE: RealtimeTradePerformanceResult;
  readonly PROJECT_REALTIME_COST_ACCOUNTING: RealtimeTradeCostAccountingResult;
  readonly PROJECT_REALTIME_NET_PERFORMANCE: RealtimeNetTradePerformanceResult;
  readonly PROJECT_REALTIME_R_MULTIPLE: RealtimeTradeRMultipleResult;
}

export type OrchestrationOperation = keyof CommandExecutionResultMap;
export type CommandFor<O extends OrchestrationOperation> = Extract<
  LiveTradingOrchestrationCommand,
  { readonly operation: O }
>;

export type CommandExecution = {
  readonly [O in OrchestrationOperation]: Readonly<{
    readonly operation: O;
    readonly command: CommandFor<O>;
    readonly result: CommandExecutionResultMap[O];
  }>;
}[OrchestrationOperation];

export type SideEffectExecutionRejectionReason =
  | "SIDE_EFFECT_COMMAND_NOT_ALLOWED_IN_DRY_RUN"
  | "SIDE_EFFECT_SESSION_NOT_SANDBOX"
  | "SIDE_EFFECT_ENVIRONMENT_NOT_SANDBOX";

export interface RunnerNoActionResult {
  readonly status: "RUNNER_NO_ACTION";
  readonly session: LiveTradingOrchestrationSession;
  readonly plannerResult: NoActionResult;
}

export interface RunnerNeedsContextResult {
  readonly status: "RUNNER_NEEDS_CONTEXT";
  readonly session: LiveTradingOrchestrationSession;
  readonly plannerResult: NeedsContextResult;
}

export interface RunnerRejectedResult {
  readonly status: "RUNNER_REJECTED";
  readonly session: LiveTradingOrchestrationSession;
  readonly plannerResult: OrchestrationRejectedResult;
}

export interface CommandExecutedResult {
  readonly status: "COMMAND_EXECUTED";
  readonly session: LiveTradingOrchestrationSession;
  readonly plannerResult: CommandPlannedResult;
  readonly command: LiveTradingOrchestrationCommand;
  readonly execution: CommandExecution;
}

export interface CommandExecutionRejectedResult {
  readonly status: "COMMAND_EXECUTION_REJECTED";
  readonly reason: SideEffectExecutionRejectionReason;
  readonly session: LiveTradingOrchestrationSession;
  readonly plannerResult: CommandPlannedResult;
  readonly command: LiveTradingOrchestrationCommand;
}

export interface CommandExecutionFailedResult {
  readonly status: "COMMAND_EXECUTION_FAILED";
  readonly operation: OrchestrationOperation;
  readonly session: LiveTradingOrchestrationSession;
  readonly plannerResult: CommandPlannedResult;
  readonly command: LiveTradingOrchestrationCommand;
  readonly cause: unknown;
}

export interface RunnerBusyResult {
  readonly status: "RUNNER_BUSY";
  readonly session: LiveTradingOrchestrationSession;
}

export type SandboxOrchestrationDispatchResult =
  | RunnerNoActionResult
  | RunnerNeedsContextResult
  | RunnerRejectedResult
  | CommandExecutedResult
  | CommandExecutionRejectedResult
  | CommandExecutionFailedResult
  | RunnerBusyResult;

export type PlannerNoCommandResult = Exclude<LiveTradingOrchestrationStepResult, CommandPlannedResult>;
