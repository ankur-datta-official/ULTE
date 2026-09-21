import type {
  InstrumentId,
  PositiveDecimalString,
  UnixMs,
} from "@ulte/instrument-model";
import type { ReadyTradeIntent, TradeIntentResult } from "@ulte/trade-intent-engine";

export const EXECUTION_PLAN_SCHEMA_VERSION = "EXECUTION_PLAN_V1" as const;

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
