import type {
  ExecutionMarketSnapshotInput,
  ExecutionPreparationConfig,
  ExecutionPreparationInput,
  ExecutionPreparationResult,
  InstrumentExecutionSpecInput,
  ReadyExecutionPlan,
} from "@ulte/execution-preparation-engine";
import type { UnixMs } from "@ulte/instrument-model";
import type {
  RealtimeDecisionResult,
  TradeIntentCreatedResult,
} from "@ulte/realtime-decision-engine";
import type {
  PreparationCycleId,
  PreparationProfileId,
} from "./identity.js";

export interface RealtimeExecutionPreparationConfig {
  readonly profileVersion: string;
  readonly recentPreparationWindowSize: number;
}

export interface ExecutionPreparationContext {
  /** The caller-observed boundary passed to the existing engine as executionAsOf. */
  readonly preparationAsOf: number;
  readonly marketSnapshot: ExecutionMarketSnapshotInput;
  readonly instrumentExecutionSpec: InstrumentExecutionSpecInput;
  readonly config: ExecutionPreparationConfig;
}

export interface RealtimeExecutionPreparationInput {
  readonly decision: RealtimeDecisionResult;
  readonly context?: ExecutionPreparationContext;
}

export interface RealtimeExecutionPreparationEvaluators {
  readonly prepareExecutionPlan: (
    input: ExecutionPreparationInput,
  ) => ExecutionPreparationResult;
}

interface PreparationBase {
  readonly analysisCycleId: RealtimeDecisionResult["analysisCycleId"];
  readonly decisionCycleId: RealtimeDecisionResult["decisionCycleId"];
  readonly preparationCycleId: PreparationCycleId;
  readonly preparationProfileId: PreparationProfileId;
  readonly analysisAsOf: UnixMs;
  readonly triggerCloseTime: UnixMs;
}

export type NoPreparationReason =
  | "UPSTREAM_NO_DECISION"
  | "UPSTREAM_DECISION_REJECTED"
  | "DUPLICATE_DECISION_INPUT";

export interface NoPreparationResult extends PreparationBase {
  readonly status: "NO_PREPARATION";
  readonly reason: NoPreparationReason;
  readonly upstreamDecisionStatus: Exclude<RealtimeDecisionResult["status"], "TRADE_INTENT_CREATED">;
}

type RejectedPreparation = Exclude<ExecutionPreparationResult, ReadyExecutionPlan>;

export interface PreparationRejectedResult extends PreparationBase {
  readonly status: "PREPARATION_REJECTED";
  readonly preparationAsOf: UnixMs;
  readonly tradeIntentResult: TradeIntentCreatedResult["tradeIntentResult"];
  readonly executionPreparationResult: RejectedPreparation;
}

export interface ExecutionPreparedResult extends PreparationBase {
  readonly status: "EXECUTION_PREPARED";
  readonly preparationAsOf: UnixMs;
  readonly tradeIntentResult: TradeIntentCreatedResult["tradeIntentResult"];
  readonly executionPreparationResult: ReadyExecutionPlan;
}

export type PublishedPreparationResult =
  | NoPreparationResult
  | PreparationRejectedResult
  | ExecutionPreparedResult;

export interface DuplicatePreparationResult extends PreparationBase {
  readonly status: "DUPLICATE_PREPARATION";
  readonly originalStatus: PublishedPreparationResult["status"];
}

export type RealtimeExecutionPreparationResult =
  | PublishedPreparationResult
  | DuplicatePreparationResult;
