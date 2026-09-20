import type { InstrumentId, PositiveDecimalString, TimeframeId, UnixMs } from "@ulte/instrument-model";

export type SwingKind = "HIGH" | "LOW";
export type SwingRelation =
  | "UNCLASSIFIED"
  | "HIGHER_HIGH" | "LOWER_HIGH" | "EQUAL_HIGH"
  | "HIGHER_LOW" | "LOWER_LOW" | "EQUAL_LOW";
export type StructuralState = "UP" | "DOWN" | "MIXED" | "UNDETERMINED";
export type LiquiditySide = "BUY_SIDE" | "SELL_SIDE";
export type LiquidityStatus = "ACTIVE" | "SWEPT" | "BROKEN";
export type StructureEventType =
  | "CLOSE_BREAK_ABOVE" | "CLOSE_BREAK_BELOW"
  | "SWEEP_ABOVE_RECLAIM" | "SWEEP_BELOW_RECLAIM";

export interface SwingPoint {
  readonly id: string;
  readonly kind: SwingKind;
  readonly price: PositiveDecimalString;
  readonly pivotOpenTime: UnixMs;
  readonly pivotCloseTime: UnixMs;
  readonly confirmedAt: UnixMs;
  readonly relation: SwingRelation;
}

export interface LiquidityLevel {
  readonly side: LiquiditySide;
  readonly price: PositiveDecimalString;
  readonly sourceSwingId: string;
  readonly sourcePivotOpenTime: UnixMs;
  readonly confirmedAt: UnixMs;
  readonly status: LiquidityStatus;
  readonly resolvedAt?: UnixMs;
}

export interface StructureEvent {
  readonly type: StructureEventType;
  readonly instrumentId: InstrumentId;
  readonly timeframe: TimeframeId;
  readonly detectedAt: UnixMs;
  readonly eventCandleOpenTime: UnixMs;
  readonly referenceSwingId: string;
  readonly referenceSwingTime: UnixMs;
  readonly referencePrice: PositiveDecimalString;
  readonly liquiditySide: LiquiditySide;
}

export type StructureRejectionReason =
  | "OPEN_CANDLE" | "INSTRUMENT_MISMATCH" | "TIMEFRAME_MISMATCH"
  | "DUPLICATE_CANDLE" | "OUT_OF_ORDER" | "DATA_GAP";

export interface ReadyStructureResult {
  readonly status: "READY";
  readonly instrumentId: InstrumentId;
  readonly timeframe: TimeframeId;
  readonly windowStart: UnixMs;
  readonly windowEnd: UnixMs;
  readonly structureState: StructuralState;
  readonly confirmedSwings: readonly SwingPoint[];
  readonly liquidityLevels: readonly LiquidityLevel[];
  readonly structureEvents: readonly StructureEvent[];
  readonly latestConfirmedHigh?: SwingPoint;
  readonly latestConfirmedLow?: SwingPoint;
}

export interface InsufficientStructureDataResult {
  readonly status: "INSUFFICIENT_DATA";
  readonly reason: "NOT_ENOUGH_CANDLES";
  readonly requiredCandles: number;
  readonly availableCandles: number;
}

export interface RejectedStructureDataResult {
  readonly status: "DATA_REJECTED";
  readonly reason: StructureRejectionReason;
}

export type StructureAnalysisResult =
  | ReadyStructureResult | InsufficientStructureDataResult | RejectedStructureDataResult;
