import type {
  CurrencyCode,
  InstrumentId,
  PositiveDecimalString,
  UnixMs,
} from "@ulte/instrument-model";
import type {
  ReadyTradeIntent,
  ReadyTradeIntentRecoveryEvidenceV1,
  ReadyTradeIntentRestorationResult,
  TradeIntentResult,
} from "@ulte/trade-intent-engine";

export const EXECUTION_PLAN_SCHEMA_VERSION = "EXECUTION_PLAN_V2" as const;
export const READY_EXECUTION_PLAN_RECOVERY_DATA_V1_SCHEMA_VERSION =
  "READY_EXECUTION_PLAN_RECOVERY_DATA_V1" as const;
export const READY_EXECUTION_PLAN_RECOVERY_DATA_SCHEMA_VERSION =
  "READY_EXECUTION_PLAN_RECOVERY_DATA_V2" as const;

export interface ExecutionMarketSnapshotInput {
  readonly instrumentId: string;
  readonly asOf: number;
  readonly bid: string;
  readonly ask: string;
}

export interface ExecutionMarketSnapshot {
  readonly instrumentId: InstrumentId;
  readonly asOf: UnixMs;
  readonly bid: PositiveDecimalString;
  readonly ask: PositiveDecimalString;
}

export interface InstrumentExecutionSpecInput {
  readonly instrumentId: string;
  readonly priceTick: string;
  readonly quantityStep: string;
  readonly minimumQuantity: string;
  readonly maximumQuantity: string;
}

export interface InstrumentExecutionSpec {
  readonly instrumentId: InstrumentId;
  readonly priceTick: PositiveDecimalString;
  readonly quantityStep: PositiveDecimalString;
  readonly minimumQuantity: PositiveDecimalString;
  readonly maximumQuantity: PositiveDecimalString;
}

export interface ExecutionPreparationConfig {
  readonly maxIntentAgeMs: number;
  readonly maxQuoteAgeMs: number;
  readonly maxEntryDeviationBps: number;
}

export interface ExecutionPreparationInput {
  readonly tradeIntent: TradeIntentResult;
  readonly executionAsOf: number;
  readonly marketSnapshot: ExecutionMarketSnapshot;
  readonly instrumentExecutionSpec: InstrumentExecutionSpec;
  readonly config: ExecutionPreparationConfig;
}

export type ExecutionSide = "BUY" | "SELL";

export interface EntryLimitInstruction {
  readonly kind: "ENTRY_LIMIT";
  readonly side: ExecutionSide;
  readonly price: PositiveDecimalString;
  readonly quantity: PositiveDecimalString;
  readonly positionEffect: "OPEN";
}

export interface ProtectiveStopInstruction {
  readonly kind: "PROTECTIVE_STOP_TRIGGER";
  readonly side: ExecutionSide;
  readonly triggerPrice: PositiveDecimalString;
  readonly quantity: PositiveDecimalString;
  readonly positionEffect: "CLOSE";
}

export interface ProfitTargetInstruction {
  readonly kind: "PROFIT_TARGET_LIMIT";
  readonly side: ExecutionSide;
  readonly price: PositiveDecimalString;
  readonly quantity: PositiveDecimalString;
  readonly positionEffect: "CLOSE";
}

export interface ReadyExecutionPlan {
  readonly status: "EXECUTION_PLAN_READY";
  readonly schemaVersion: typeof EXECUTION_PLAN_SCHEMA_VERSION;
  readonly executionPlanId: string;
  readonly tradeIntentId: string;
  readonly candidateId: string;
  readonly instrumentId: InstrumentId;
  readonly intentAsOf: UnixMs;
  readonly marketSnapshotAsOf: UnixMs;
  readonly preparedAsOf: UnixMs;
  readonly direction: ReadyTradeIntent["direction"];
  readonly entrySide: ExecutionSide;
  readonly exitSide: ExecutionSide;
  readonly quantity: PositiveDecimalString;
  readonly quantityUnit: string;
  readonly accountCurrency: CurrencyCode;
  readonly entryInstruction: EntryLimitInstruction;
  readonly protectiveStopInstruction: ProtectiveStopInstruction;
  readonly profitTargetInstruction: ProfitTargetInstruction;
  readonly priceTick: PositiveDecimalString;
  readonly quantityStep: PositiveDecimalString;
  readonly bidAtPreparation: PositiveDecimalString;
  readonly askAtPreparation: PositiveDecimalString;
  readonly intentAgeMs: number;
  readonly quoteAgeMs: number;
  readonly entryDeviationBps: string;
  readonly approvedRiskAmount: PositiveDecimalString;
  readonly actualRiskAmount: PositiveDecimalString;
  readonly netRewardRiskBps: string;
}

export interface ReadyExecutionPlanRecoveryEntryInstructionV1 {
  readonly kind: "ENTRY_LIMIT";
  readonly side: ExecutionSide;
  readonly price: string;
  readonly quantity: string;
  readonly positionEffect: "OPEN";
}

export interface ReadyExecutionPlanRecoveryStopInstructionV1 {
  readonly kind: "PROTECTIVE_STOP_TRIGGER";
  readonly side: ExecutionSide;
  readonly triggerPrice: string;
  readonly quantity: string;
  readonly positionEffect: "CLOSE";
}

export interface ReadyExecutionPlanRecoveryTargetInstructionV1 {
  readonly kind: "PROFIT_TARGET_LIMIT";
  readonly side: ExecutionSide;
  readonly price: string;
  readonly quantity: string;
  readonly positionEffect: "CLOSE";
}

/** Plain checkpoint data; this type is not execution-plan authority. */
export interface ReadyExecutionPlanRecoveryDataV1 {
  readonly recoverySchemaVersion: typeof READY_EXECUTION_PLAN_RECOVERY_DATA_V1_SCHEMA_VERSION;
  readonly status: "EXECUTION_PLAN_READY";
  readonly executionPlanSchemaVersion: typeof EXECUTION_PLAN_SCHEMA_VERSION;
  readonly executionPlanId: string;
  readonly tradeIntentId: string;
  readonly candidateId: string;
  readonly instrumentId: string;
  readonly intentAsOf: number;
  readonly marketSnapshotAsOf: number;
  readonly preparedAsOf: number;
  readonly direction: "UP" | "DOWN";
  readonly entrySide: ExecutionSide;
  readonly exitSide: ExecutionSide;
  readonly quantity: string;
  readonly quantityUnit: string;
  readonly accountCurrency: string;
  readonly entryInstruction: ReadyExecutionPlanRecoveryEntryInstructionV1;
  readonly protectiveStopInstruction: ReadyExecutionPlanRecoveryStopInstructionV1;
  readonly profitTargetInstruction: ReadyExecutionPlanRecoveryTargetInstructionV1;
  readonly priceTick: string;
  readonly quantityStep: string;
  readonly bidAtPreparation: string;
  readonly askAtPreparation: string;
  readonly intentAgeMs: number;
  readonly quoteAgeMs: number;
  readonly entryDeviationBps: string;
  readonly approvedRiskAmount: string;
  readonly actualRiskAmount: string;
  readonly netRewardRiskBps: string;
}

export interface ReadyExecutionPlanRecoverySelectorV2 {
  readonly executionPlanId: string;
  readonly tradeIntentId: string;
  readonly candidateId: string;
  readonly instrumentId: string;
  readonly intentAsOf: number;
  readonly marketSnapshotAsOf: number;
  readonly preparedAsOf: number;
  readonly direction: "UP" | "DOWN";
  readonly entrySide: ExecutionSide;
  readonly exitSide: ExecutionSide;
  readonly quantity: string;
  readonly quantityUnit: string;
  readonly accountCurrency: string;
  readonly entryInstruction: ReadyExecutionPlanRecoveryEntryInstructionV1;
  readonly protectiveStopInstruction: ReadyExecutionPlanRecoveryStopInstructionV1;
  readonly profitTargetInstruction: ReadyExecutionPlanRecoveryTargetInstructionV1;
  readonly priceTick: string;
  readonly quantityStep: string;
  readonly bidAtPreparation: string;
  readonly askAtPreparation: string;
  readonly intentAgeMs: number;
  readonly quoteAgeMs: number;
  readonly entryDeviationBps: string;
  readonly approvedRiskAmount: string;
  readonly actualRiskAmount: string;
  readonly netRewardRiskBps: string;
}

/** Historical inputs for replay; no field in this DTO is plan authority. */
export interface ReadyExecutionPlanRecoveryDataV2 {
  readonly recoverySchemaVersion: typeof READY_EXECUTION_PLAN_RECOVERY_DATA_SCHEMA_VERSION;
  readonly tradeIntentEvidence: ReadyTradeIntentRecoveryEvidenceV1;
  readonly marketSnapshot: ExecutionMarketSnapshotInput;
  readonly instrumentExecutionSpec: InstrumentExecutionSpecInput;
  readonly config: ExecutionPreparationConfig;
  readonly executionAsOf: number;
  readonly expectedPlan: ReadyExecutionPlanRecoverySelectorV2;
}

type RestoredReadyTradeIntent = Extract<ReadyTradeIntentRestorationResult, {
  readonly status: "READY_TRADE_INTENT_RESTORED";
}>;

export type ReadyExecutionPlanRestorationResult =
  | Readonly<{
      readonly status: "READY_EXECUTION_PLAN_RESTORED";
      readonly tradeIntentRestoration: RestoredReadyTradeIntent;
      readonly preparationInput: Readonly<{
        readonly tradeIntent: ReadyTradeIntent;
        readonly executionAsOf: UnixMs;
        readonly marketSnapshot: Readonly<ExecutionMarketSnapshot>;
        readonly instrumentExecutionSpec: Readonly<InstrumentExecutionSpec>;
        readonly config: Readonly<ExecutionPreparationConfig>;
      }>;
      /** The direct result of this restoration invocation's authority call. */
      readonly preparationResult: ReadyExecutionPlan;
      readonly executionPlan: ReadyExecutionPlan;
    }>
  | Readonly<{
      readonly status: "READY_EXECUTION_PLAN_RESTORATION_REJECTED";
      readonly reason:
        | "INVALID_READY_EXECUTION_PLAN_RECOVERY_DATA"
        | "UNSUPPORTED_READY_EXECUTION_PLAN_RECOVERY_SCHEMA"
        | "READY_TRADE_INTENT_RESTORATION_REJECTED"
        | "INVALID_EXECUTION_MARKET_SNAPSHOT"
        | "INVALID_INSTRUMENT_EXECUTION_SPEC"
        | "INVALID_EXECUTION_PREPARATION_CONFIG"
        | "INVALID_EXECUTION_AS_OF"
        | "EXECUTION_PLAN_NOT_READY"
        | "EXPECTED_EXECUTION_PLAN_MISMATCH";
      readonly upstreamStatus?: string;
      readonly upstreamReason?: string;
      readonly upstreamFailedPriceField?: FailedPriceField;
    }>;

export type FailedPriceField = "ENTRY" | "INVALIDATION" | "TARGET";

export type PlanNotPreparableReason =
  | "TRADE_INTENT_STALE"
  | "MARKET_SNAPSHOT_STALE"
  | "QUOTE_PREDATES_TRADE_INTENT"
  | "PRICE_NOT_TICK_ALIGNED"
  | "QUANTITY_NOT_STEP_ALIGNED"
  | "QUANTITY_BELOW_MINIMUM"
  | "QUANTITY_ABOVE_MAXIMUM"
  | "MARKET_ALREADY_INVALIDATED"
  | "TARGET_ALREADY_REACHED"
  | "ENTRY_DEVIATION_EXCEEDED";

export interface PlanNotPreparableResult {
  readonly status: "PLAN_NOT_PREPARABLE";
  readonly reason: PlanNotPreparableReason;
  readonly tradeIntentId: string;
  readonly candidateId: string;
  readonly failedPriceField?: FailedPriceField;
}

export type ExecutionPreparationDataRejectionReason =
  | "INSTRUMENT_MISMATCH"
  | "FUTURE_TRADE_INTENT"
  | "FUTURE_MARKET_SNAPSHOT"
  | "INVALID_MARKET_SNAPSHOT"
  | "INVALID_EXECUTION_SPEC"
  | "INVALID_EXECUTION_CONFIG"
  | "INVALID_PRICE_DIRECTION";

export interface RejectedExecutionPreparationResult {
  readonly status: "DATA_REJECTED";
  readonly reason: ExecutionPreparationDataRejectionReason;
  readonly tradeIntentId?: string;
  readonly candidateId: string;
}

export interface UpstreamNotReadyExecutionPreparationResult {
  readonly status: "UPSTREAM_NOT_READY";
  readonly candidateId: string;
  readonly tradeIntentStatus: Exclude<TradeIntentResult["status"], "INTENT_READY">;
  readonly tradeIntentReason?: string;
}

export type ExecutionPreparationResult =
  | ReadyExecutionPlan
  | PlanNotPreparableResult
  | RejectedExecutionPreparationResult
  | UpstreamNotReadyExecutionPreparationResult;
