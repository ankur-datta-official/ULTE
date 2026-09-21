import type { InstrumentId, NonNegativeDecimalString, PositiveDecimalString, TimeframeId, UnixMs } from "@ulte/instrument-model";
import type { CandleSnapshot } from "@ulte/market-data";
import type { SetupCandidate, SetupDirection, SetupFamily } from "@ulte/setup-engine";
import type { LiquiditySide, ReadyStructureResult } from "@ulte/structure-engine";
import type { RiskCostAssumptions, RiskQualificationConfig } from "./config.js";

export interface RiskQualificationInput {
  readonly candidate: SetupCandidate;
  readonly structure: ReadyStructureResult;
  readonly setupCandles: readonly CandleSnapshot[];
  readonly costs: RiskCostAssumptions;
  readonly config: RiskQualificationConfig;
}

export interface RiskTargetPathItem {
  readonly price: PositiveDecimalString;
  readonly sourceSwingId: string;
  readonly confirmedAt: UnixMs;
  readonly liquiditySide: LiquiditySide;
}

interface RiskResultIdentity {
  readonly candidateId: string;
  readonly family: SetupFamily;
  readonly direction: SetupDirection;
  readonly instrumentId: InstrumentId;
  readonly setupTimeframe: TimeframeId;
  readonly asOf: UnixMs;
}

export type RiskNotQualifiedReason =
  | "SETUP_NOT_CONFIRMED"
  | "CONFIRMATION_CANDLE_NOT_FOUND"
  | "INITIATION_CANDLE_NOT_FOUND"
  | "INVALID_STRUCTURAL_INVALIDATION"
  | "NO_STRUCTURAL_TARGET"
  | "COSTS_CONSUME_REWARD"
  | "NET_RR_BELOW_MINIMUM";

export type RiskDataRejectionReason =
  | "INSTRUMENT_MISMATCH"
  | "SETUP_TIMEFRAME_MISMATCH"
  | "OPEN_SETUP_CANDLE"
  | "FUTURE_SETUP_CANDLE"
  | "DATA_GAP"
  | "DUPLICATE_SETUP_CANDLE"
  | "OUT_OF_ORDER_SETUP_CANDLES"
  | "FUTURE_STRUCTURE_WINDOW"
  | "INVALID_CONFIRMED_AT"
  | "INVALID_NET_RISK";

export interface RiskCalculation extends RiskResultIdentity {
  readonly entryReferencePrice: PositiveDecimalString;
  readonly invalidationPrice: PositiveDecimalString;
  readonly primaryTargetPrice: PositiveDecimalString;
  readonly grossRisk: PositiveDecimalString;
  readonly grossReward: PositiveDecimalString;
  readonly entryCost: NonNegativeDecimalString;
  readonly targetExitCost: NonNegativeDecimalString;
  readonly stopExitCost: NonNegativeDecimalString;
  readonly netRisk: PositiveDecimalString;
  readonly netReward: PositiveDecimalString;
  readonly netRewardRiskBps: string;
  readonly minimumRequiredNetRewardRiskBps: number;
  readonly targetPath: readonly RiskTargetPathItem[];
}

export interface QualifiedRiskResult extends RiskCalculation {
  readonly status: "QUALIFIED";
}

export interface CalculatedNotQualifiedRiskResult extends RiskCalculation {
  readonly status: "NOT_QUALIFIED";
  readonly reason: "NET_RR_BELOW_MINIMUM";
}

export interface UncalculatedNotQualifiedRiskResult extends RiskResultIdentity {
  readonly status: "NOT_QUALIFIED";
  readonly reason: Exclude<RiskNotQualifiedReason, "NET_RR_BELOW_MINIMUM">;
  readonly entryReferencePrice?: PositiveDecimalString;
  readonly invalidationPrice?: PositiveDecimalString;
  readonly primaryTargetPrice?: PositiveDecimalString;
  readonly targetPath?: readonly RiskTargetPathItem[];
}

export interface RejectedRiskDataResult extends RiskResultIdentity {
  readonly status: "DATA_REJECTED";
  readonly reason: RiskDataRejectionReason;
}

export type RiskQualificationResult =
  | QualifiedRiskResult
  | CalculatedNotQualifiedRiskResult
  | UncalculatedNotQualifiedRiskResult
  | RejectedRiskDataResult;
