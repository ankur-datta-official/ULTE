import type { RealtimeExecutionExitFillResult } from "@ulte/realtime-execution-exit-fill-engine";
import type { RealtimeExecutionFillResult } from "@ulte/realtime-execution-fill-engine";
import type {
  TradeCostAccounting,
  TradeCostAccountingRejectedResult,
  TradeCostAccountingSpec,
  TradeCostEvent,
} from "@ulte/trade-cost-accounting-engine";

export type RealtimeTradeCostAccountingSourceKind = "ENTRY_FILL" | "EXIT_FILL";

export interface EntryFillRealtimeTradeCostAccountingInput {
  readonly sourceKind: "ENTRY_FILL";
  readonly fillLifecycle: RealtimeExecutionFillResult;
  readonly accountingSpec: TradeCostAccountingSpec;
  readonly observedCostEvents: readonly TradeCostEvent[];
}

export interface ExitFillRealtimeTradeCostAccountingInput {
  readonly sourceKind: "EXIT_FILL";
  readonly exitFillLifecycle: RealtimeExecutionExitFillResult;
  readonly accountingSpec: TradeCostAccountingSpec;
  readonly observedCostEvents: readonly TradeCostEvent[];
}

export type RealtimeTradeCostAccountingInput =
  | EntryFillRealtimeTradeCostAccountingInput
  | ExitFillRealtimeTradeCostAccountingInput;

export type RealtimeTradeCostAccountingUpstreamStatus =
  | RealtimeExecutionFillResult["status"]
  | RealtimeExecutionExitFillResult["status"];

export type RealtimeTradeCostAccountingRejectionReason =
  | "COST_EVENT_DELIVERY_INVALID"
  | "CONFLICTING_DUPLICATE_COST_EVENT_ID"
  | "AUTHORITATIVE_COST_ACCOUNTING_REJECTED";

export interface NoCostAccountingProjectionResult {
  readonly status: "NO_COST_ACCOUNTING_PROJECTION";
  readonly sourceKind: RealtimeTradeCostAccountingSourceKind;
  readonly upstreamStatus: RealtimeTradeCostAccountingUpstreamStatus;
}

export interface RealtimeTradeCostAccountingProjectedResult {
  readonly status: "TRADE_COST_ACCOUNTING_PROJECTED";
  readonly sourceKind: RealtimeTradeCostAccountingSourceKind;
  readonly upstreamStatus: RealtimeTradeCostAccountingUpstreamStatus;
  readonly observedDeliveryCount: number;
  readonly uniqueCostEventCount: number;
  readonly duplicateDeliveryCount: number;
  readonly accounting: TradeCostAccounting;
}

export interface RealtimeTradeCostAccountingRejectedResult {
  readonly status: "TRADE_COST_ACCOUNTING_REJECTED";
  readonly sourceKind: RealtimeTradeCostAccountingSourceKind;
  readonly upstreamStatus: RealtimeTradeCostAccountingUpstreamStatus;
  readonly reason: RealtimeTradeCostAccountingRejectionReason;
  readonly costAccountingProjection?: TradeCostAccountingRejectedResult;
}

export type RealtimeTradeCostAccountingResult =
  | NoCostAccountingProjectionResult
  | RealtimeTradeCostAccountingProjectedResult
  | RealtimeTradeCostAccountingRejectedResult;
