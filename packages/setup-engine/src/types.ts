import type { InstrumentId, PositiveDecimalString, TimeframeId, UnixMs } from "@ulte/instrument-model";
import type { CandleSnapshot } from "@ulte/market-data";
import type { RegimeResult } from "@ulte/regime-engine";
import type { LiquidityLevel, StructureAnalysisResult, StructureEvent } from "@ulte/structure-engine";

export const SETUP_FAMILIES = [
  "TREND_PULLBACK_CONTINUATION", "BREAKOUT_RETEST", "LIQUIDITY_SWEEP_REVERSAL",
] as const;
export type SetupFamily = (typeof SETUP_FAMILIES)[number];
export type SetupDirection = "UP" | "DOWN";
export type SetupStage = "ARMED" | "CONFIRMED";

export interface PositionSetupInput {
  readonly asOf: UnixMs;
  readonly contextRegime: RegimeResult;
  readonly setupStructure: StructureAnalysisResult;
  readonly setupCandles: readonly CandleSnapshot[];
}

export interface EventEvidence {
  readonly event: StructureEvent;
  readonly referenceLevel: LiquidityLevel;
}

export interface RetestEvidence {
  readonly candleOpenTime: UnixMs;
  readonly candleCloseTime: UnixMs;
  readonly referencePrice: PositiveDecimalString;
}

export interface SetupCandidate {
  readonly id: string;
  readonly family: SetupFamily;
  readonly direction: SetupDirection;
  readonly stage: SetupStage;
  readonly instrumentId: InstrumentId;
  readonly contextTimeframe: TimeframeId;
  readonly setupTimeframe: TimeframeId;
  readonly asOf: UnixMs;
  readonly initiatedAt: UnixMs;
  readonly confirmedAt?: UnixMs;
  readonly evidence: Readonly<{
    readonly initiation: EventEvidence;
    readonly confirmation?: EventEvidence | RetestEvidence;
  }>;
}

export type SetupDataRejectionReason =
  | "INSTRUMENT_MISMATCH" | "SETUP_CANDLE_INSTRUMENT_MISMATCH" | "SETUP_TIMEFRAME_MISMATCH"
  | "OPEN_SETUP_CANDLE" | "FUTURE_SETUP_CANDLE" | "DATA_GAP"
  | "DUPLICATE_SETUP_CANDLE" | "OUT_OF_ORDER_SETUP_CANDLES" | "OUT_OF_ORDER_STRUCTURE_EVENTS"
  | "FUTURE_REGIME_WINDOW" | "FUTURE_STRUCTURE_WINDOW";

export interface ReadySetupEvaluationResult {
  readonly status: "READY";
  readonly instrumentId: InstrumentId;
  readonly asOf: UnixMs;
  readonly contextTimeframe: TimeframeId;
  readonly setupTimeframe: TimeframeId;
  readonly candidates: readonly SetupCandidate[];
}

export interface UpstreamNotReadySetupResult {
  readonly status: "UPSTREAM_NOT_READY";
  readonly source: "REGIME" | "STRUCTURE";
  readonly upstreamStatus: "INSUFFICIENT_DATA" | "DATA_REJECTED";
  readonly reason: string;
}

export interface RejectedSetupEvaluationResult {
  readonly status: "DATA_REJECTED";
  readonly reason: SetupDataRejectionReason;
}

export type SetupEvaluationResult =
  | ReadySetupEvaluationResult | UpstreamNotReadySetupResult | RejectedSetupEvaluationResult;
