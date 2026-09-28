import type { MarketDataEvent, TradeTick } from "@ulte/market-data";
import type { RealtimeExecutionExitFillResult } from "@ulte/realtime-execution-exit-fill-engine";
import type { RealtimeExecutionFillResult } from "@ulte/realtime-execution-fill-engine";
import type {
  UnrealizedTradeValuation,
  UnrealizedValuationAccountingSpec,
  UnrealizedValuationRejectedResult,
  UnrealizedValuationRejectionReason,
} from "@ulte/trade-valuation-engine";

export const REALTIME_VALUATION_MARK_POLICY_V1 = "LAST_TRADE_V1" as const;
export type RealtimeValuationMarkPolicy = typeof REALTIME_VALUATION_MARK_POLICY_V1;
export type AuthoritativeTradeMarkSource = MarketDataEvent<TradeTick>;
export type RealtimeTradeValuationSourceKind = "ENTRY_FILL" | "EXIT_FILL";

export interface EntryFillRealtimeTradeValuationInput {
  readonly sourceKind: "ENTRY_FILL";
  readonly fillLifecycle: RealtimeExecutionFillResult;
  readonly accountingSpec: UnrealizedValuationAccountingSpec;
  readonly markSource: AuthoritativeTradeMarkSource;
}

export interface ExitFillRealtimeTradeValuationInput {
  readonly sourceKind: "EXIT_FILL";
  readonly exitFillLifecycle: RealtimeExecutionExitFillResult;
  readonly accountingSpec: UnrealizedValuationAccountingSpec;
  readonly markSource: AuthoritativeTradeMarkSource;
}

export type RealtimeTradeValuationInput =
  | EntryFillRealtimeTradeValuationInput
  | ExitFillRealtimeTradeValuationInput;

export type RealtimeTradeValuationUpstreamStatus =
  | RealtimeExecutionFillResult["status"]
  | RealtimeExecutionExitFillResult["status"];

export interface NoValuationProjectionResult {
  readonly status: "NO_VALUATION_PROJECTION";
  readonly sourceKind: RealtimeTradeValuationSourceKind;
  readonly upstreamStatus: RealtimeTradeValuationUpstreamStatus;
}

export interface UnrealizedValuationProjectedRealtimeResult {
  readonly status: "UNREALIZED_VALUATION_PROJECTED";
  readonly sourceKind: RealtimeTradeValuationSourceKind;
  readonly upstreamStatus: RealtimeTradeValuationUpstreamStatus;
  readonly markPolicy: RealtimeValuationMarkPolicy;
  readonly valuation: UnrealizedTradeValuation;
}

export type RealtimeTradeValuationRejectionReason =
  | "MARK_SOURCE_INVALID"
  | UnrealizedValuationRejectionReason;

export interface UnrealizedValuationRejectedRealtimeResult {
  readonly status: "UNREALIZED_VALUATION_REJECTED";
  readonly sourceKind: RealtimeTradeValuationSourceKind;
  readonly upstreamStatus: RealtimeTradeValuationUpstreamStatus;
  readonly markPolicy: RealtimeValuationMarkPolicy;
  readonly reason: RealtimeTradeValuationRejectionReason;
  readonly valuationProjection?: UnrealizedValuationRejectedResult;
}

export type RealtimeTradeValuationResult =
  | NoValuationProjectionResult
  | UnrealizedValuationProjectedRealtimeResult
  | UnrealizedValuationRejectedRealtimeResult;
