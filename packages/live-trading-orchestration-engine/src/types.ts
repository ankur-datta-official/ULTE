import type { ExecutionAttempt } from "@ulte/execution-engine";
import type { InstrumentId } from "@ulte/instrument-model";
import type {
  LiveIngestionResult,
  LiveTradeEvent,
} from "@ulte/live-market-data-engine";
import type { RealtimeAnalysisProcessResult } from "@ulte/realtime-analysis-engine";
import type { RealtimeDecisionInput, RealtimeDecisionResult } from "@ulte/realtime-decision-engine";
import type { RealtimeExecutionExitFillInput, RealtimeExecutionExitFillResult } from "@ulte/realtime-execution-exit-fill-engine";
import type {
  FillLifecycleInitializationResult,
  RealtimeExecutionFillInput,
  RealtimeExecutionFillResult,
} from "@ulte/realtime-execution-fill-engine";
import type {
  RealtimeExecutionPreparationInput,
  RealtimeExecutionPreparationResult,
} from "@ulte/realtime-execution-preparation-engine";
import type {
  RealtimeExecutionProtectionInput,
  RealtimeExecutionProtectionResult,
} from "@ulte/realtime-execution-protection-engine";
import type {
  RealtimeExecutionProtectionLifecycleInput,
  RealtimeExecutionProtectionLifecycleResult,
} from "@ulte/realtime-execution-protection-lifecycle-engine";
import type {
  RealtimeExecutionSubmissionInput,
  RealtimeExecutionSubmissionResult,
} from "@ulte/realtime-execution-submission-engine";
import type { RealtimeNetTradePerformanceResult } from "@ulte/realtime-net-trade-performance-engine";
import type { RealtimePositionExposureInput, RealtimePositionExposureResult } from "@ulte/realtime-position-exposure-engine";
import type { RealtimeTradeAccountingInput, RealtimeTradeAccountingResult } from "@ulte/realtime-trade-accounting-engine";
import type {
  RealtimeTradeCostAccountingInput,
  RealtimeTradeCostAccountingResult,
} from "@ulte/realtime-trade-cost-accounting-engine";
import type { RealtimeTradePerformanceResult } from "@ulte/realtime-trade-performance-engine";
import type {
  RealtimeTradeRMultipleResult,
  TradeRMultipleProjectedRealtimeResult,
} from "@ulte/realtime-trade-r-multiple-engine";
import type { RealtimeTradeValuationInput, RealtimeTradeValuationResult } from "@ulte/realtime-trade-valuation-engine";
import type { TradeRiskBasis, TradeRiskBasisCreationResult } from "@ulte/trade-r-multiple-engine";

export const LIVE_TRADING_ORCHESTRATION_SESSION_SCHEMA_VERSION =
  "LIVE_TRADING_ORCHESTRATION_SESSION_V1" as const;

export const LIVE_TRADING_ORCHESTRATION_MODES = ["DRY_RUN", "SANDBOX"] as const;
export type LiveTradingOrchestrationMode = (typeof LIVE_TRADING_ORCHESTRATION_MODES)[number];

export interface LiveTradingOrchestrationSession {
  readonly schemaVersion: typeof LIVE_TRADING_ORCHESTRATION_SESSION_SCHEMA_VERSION;
  readonly sessionId: string;
  readonly mode: LiveTradingOrchestrationMode;
  readonly instrumentId: InstrumentId;
  readonly latestExecutionAttempt?: ExecutionAttempt;
  readonly riskBasis?: TradeRiskBasis;
  readonly latestRealtimeRMultiple?: TradeRMultipleProjectedRealtimeResult;
}

export interface CreateLiveTradingOrchestrationSessionInput {
  readonly sessionId: string;
  readonly mode: LiveTradingOrchestrationMode;
  readonly instrumentId: string;
}

export const LIVE_TRADING_ORCHESTRATION_CAPABILITIES_V1 = Object.freeze({
  restartRecoverySupported: false,
  callerMustSerializePerSession: true,
  maximumCommandsPerStep: 1,
  liveModeSupported: false,
  exitSubmissionSupported: false,
} as const);

export type LiveTradingOrchestrationInput =
  | Readonly<{ readonly kind: "OBSERVED_LIVE_TRADE"; readonly event: LiveTradeEvent; readonly observationTime: number }>
  | Readonly<{ readonly kind: "LIVE_INGESTION_RESULT"; readonly result: LiveIngestionResult }>
  | Readonly<{ readonly kind: "REALTIME_ANALYSIS_RESULT"; readonly result: RealtimeAnalysisProcessResult; readonly decisionInput?: RealtimeDecisionInput }>
  | Readonly<{ readonly kind: "REALTIME_DECISION_RESULT"; readonly result: RealtimeDecisionResult; readonly preparationInput?: RealtimeExecutionPreparationInput }>
  | Readonly<{ readonly kind: "REALTIME_EXECUTION_PREPARATION_RESULT"; readonly result: RealtimeExecutionPreparationResult; readonly submissionInput?: RealtimeExecutionSubmissionInput }>
  | Readonly<{ readonly kind: "REALTIME_EXECUTION_SUBMISSION_RESULT"; readonly result: RealtimeExecutionSubmissionResult }>
  | Readonly<{ readonly kind: "FILL_LIFECYCLE_INITIALIZATION_RESULT"; readonly result: FillLifecycleInitializationResult }>
  | Readonly<{ readonly kind: "OBSERVED_ENTRY_FILL"; readonly input: RealtimeExecutionFillInput }>
  | Readonly<{ readonly kind: "REALTIME_ENTRY_FILL_RESULT"; readonly result: RealtimeExecutionFillResult; readonly protectionInput?: RealtimeExecutionProtectionInput }>
  | Readonly<{ readonly kind: "REALTIME_EXECUTION_PROTECTION_RESULT"; readonly result: RealtimeExecutionProtectionResult; readonly lifecycleInput?: RealtimeExecutionProtectionLifecycleInput }>
  | Readonly<{ readonly kind: "REALTIME_EXECUTION_PROTECTION_LIFECYCLE_RESULT"; readonly result: RealtimeExecutionProtectionLifecycleResult }>
  | Readonly<{ readonly kind: "OBSERVED_EXIT_FILL"; readonly input: RealtimeExecutionExitFillInput }>
  | Readonly<{ readonly kind: "REALTIME_EXECUTION_EXIT_FILL_RESULT"; readonly result: RealtimeExecutionExitFillResult }>
  | Readonly<{ readonly kind: "TRADE_RISK_BASIS_CREATION_RESULT"; readonly result: TradeRiskBasisCreationResult }>
  | Readonly<{ readonly kind: "POSITION_EXPOSURE_REQUEST"; readonly input: RealtimePositionExposureInput }>
  | Readonly<{ readonly kind: "POSITION_EXPOSURE_RESULT"; readonly result: RealtimePositionExposureResult }>
  | Readonly<{ readonly kind: "REALIZED_ACCOUNTING_REQUEST"; readonly input: RealtimeTradeAccountingInput }>
  | Readonly<{ readonly kind: "REALIZED_ACCOUNTING_RESULT"; readonly result: RealtimeTradeAccountingResult }>
  | Readonly<{ readonly kind: "VALUATION_REQUEST"; readonly input: RealtimeTradeValuationInput }>
  | Readonly<{ readonly kind: "VALUATION_RESULT"; readonly result: RealtimeTradeValuationResult }>
  | Readonly<{ readonly kind: "COST_ACCOUNTING_REQUEST"; readonly input: RealtimeTradeCostAccountingInput }>
  | Readonly<{ readonly kind: "COST_ACCOUNTING_RESULT"; readonly result: RealtimeTradeCostAccountingResult }>
  | Readonly<{ readonly kind: "NET_PERFORMANCE_AUTHORITIES"; readonly grossPerformance: RealtimeTradePerformanceResult; readonly costAccounting: RealtimeTradeCostAccountingResult }>
  | Readonly<{ readonly kind: "NET_PERFORMANCE_RESULT"; readonly result: RealtimeNetTradePerformanceResult }>
  | Readonly<{ readonly kind: "R_MULTIPLE_RESULT"; readonly result: RealtimeTradeRMultipleResult }>;

export type LiveTradingOrchestrationObservedReference =
  | LiveIngestionResult
  | RealtimeAnalysisProcessResult
  | RealtimeDecisionResult
  | RealtimeExecutionPreparationResult
  | RealtimeExecutionSubmissionResult
  | FillLifecycleInitializationResult
  | RealtimeExecutionFillResult
  | RealtimeExecutionProtectionResult
  | RealtimeExecutionProtectionLifecycleResult
  | RealtimeExecutionExitFillResult
  | TradeRiskBasisCreationResult
  | RealtimePositionExposureResult
  | RealtimeTradeAccountingResult
  | RealtimeTradeValuationResult
  | RealtimeTradePerformanceResult
  | RealtimeTradeCostAccountingResult
  | RealtimeNetTradePerformanceResult
  | RealtimeTradeRMultipleResult;

export type LiveTradingOrchestrationCommand =
  | Readonly<{ readonly operation: "PROCESS_LIVE_INGESTION"; readonly event: LiveTradeEvent; readonly observationTime: number }>
  | Readonly<{ readonly operation: "PROCESS_REALTIME_ANALYSIS"; readonly input: LiveIngestionResult }>
  | Readonly<{ readonly operation: "PROCESS_REALTIME_DECISION"; readonly input: RealtimeDecisionInput }>
  | Readonly<{ readonly operation: "PROCESS_REALTIME_EXECUTION_PREPARATION"; readonly input: RealtimeExecutionPreparationInput }>
  | Readonly<{ readonly operation: "SUBMIT_REALTIME_EXECUTION"; readonly input: RealtimeExecutionSubmissionInput }>
  | Readonly<{ readonly operation: "INITIALIZE_REALTIME_EXECUTION_FILL_LIFECYCLE"; readonly input: RealtimeExecutionSubmissionResult }>
  | Readonly<{ readonly operation: "APPLY_REALTIME_EXECUTION_FILL"; readonly input: RealtimeExecutionFillInput }>
  | Readonly<{ readonly operation: "SUBMIT_REALTIME_EXECUTION_PROTECTION"; readonly input: RealtimeExecutionProtectionInput }>
  | Readonly<{ readonly operation: "APPLY_REALTIME_EXECUTION_PROTECTION_ACKNOWLEDGEMENT"; readonly input: RealtimeExecutionProtectionLifecycleInput }>
  | Readonly<{ readonly operation: "APPLY_REALTIME_EXECUTION_EXIT_FILL"; readonly input: RealtimeExecutionExitFillInput }>
  | Readonly<{ readonly operation: "CREATE_TRADE_RISK_BASIS"; readonly executionAttempt: ExecutionAttempt }>
  | Readonly<{ readonly operation: "PROJECT_REALTIME_POSITION_EXPOSURE"; readonly input: RealtimePositionExposureInput }>
  | Readonly<{ readonly operation: "PROJECT_REALTIME_REALIZED_ACCOUNTING"; readonly input: RealtimeTradeAccountingInput }>
  | Readonly<{ readonly operation: "PROJECT_REALTIME_VALUATION"; readonly input: RealtimeTradeValuationInput }>
  | Readonly<{ readonly operation: "PROJECT_REALTIME_GROSS_PERFORMANCE"; readonly input: RealtimeTradeValuationResult }>
  | Readonly<{ readonly operation: "PROJECT_REALTIME_COST_ACCOUNTING"; readonly input: RealtimeTradeCostAccountingInput }>
  | Readonly<{ readonly operation: "PROJECT_REALTIME_NET_PERFORMANCE"; readonly grossPerformance: RealtimeTradePerformanceResult; readonly costAccounting: RealtimeTradeCostAccountingResult }>
  | Readonly<{ readonly operation: "PROJECT_REALTIME_R_MULTIPLE"; readonly netPerformance: RealtimeNetTradePerformanceResult; readonly riskBasis: TradeRiskBasis }>;

export type LiveTradingOrchestrationRejectionReason =
  | "INVALID_SESSION"
  | "INSTRUMENT_INCOHERENT"
  | "EXECUTION_ATTEMPT_INCOHERENT"
  | "INPUT_INCOHERENT"
  | "RISK_BASIS_INCOHERENT"
  | "UNSUPPORTED_LIVE_OPERATION";

interface StepBase {
  readonly session: LiveTradingOrchestrationSession;
  readonly reference?: LiveTradingOrchestrationObservedReference;
}

export interface CommandPlannedResult extends StepBase {
  readonly status: "COMMAND_PLANNED";
  readonly command: LiveTradingOrchestrationCommand;
}

export interface NoActionResult extends StepBase {
  readonly status: "NO_ACTION";
}

export interface NeedsContextResult extends StepBase {
  readonly status: "NEEDS_CONTEXT";
  readonly reason: "MISSING_REQUIRED_CONTEXT";
}

export interface OrchestrationRejectedResult extends StepBase {
  readonly status: "ORCHESTRATION_REJECTED";
  readonly reason: LiveTradingOrchestrationRejectionReason;
}

export type LiveTradingOrchestrationStepResult =
  | CommandPlannedResult
  | NoActionResult
  | NeedsContextResult
  | OrchestrationRejectedResult;
