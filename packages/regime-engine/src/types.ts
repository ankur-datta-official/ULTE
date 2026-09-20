import type { InstrumentId, TimeframeId, UnixMs } from "@ulte/instrument-model";

export const PRIMARY_REGIMES = ["TREND_UP", "TREND_DOWN", "RANGE", "COMPRESSION", "EXPANSION", "TRANSITION"] as const;
export type PrimaryRegime = (typeof PRIMARY_REGIMES)[number];
export type RegimeDirection = "UP" | "DOWN" | "NEUTRAL";
export type VolatilityState = "COMPRESSION" | "NORMAL" | "EXPANSION";
export type NetMoveSign = "POSITIVE" | "NEGATIVE" | "ZERO";

export type RegimeRejectionReason =
  | "OPEN_CANDLE"
  | "INSTRUMENT_MISMATCH"
  | "TIMEFRAME_MISMATCH"
  | "DUPLICATE_CANDLE"
  | "OUT_OF_ORDER"
  | "DATA_GAP";

export interface ReadyRegimeResult {
  readonly status: "READY";
  readonly primaryRegime: PrimaryRegime;
  readonly direction: RegimeDirection;
  readonly volatilityState: VolatilityState;
  readonly instrumentId: InstrumentId;
  readonly timeframe: TimeframeId;
  readonly windowStart: UnixMs;
  readonly windowEnd: UnixMs;
  readonly evidence: Readonly<{
    readonly efficiencyBps: number;
    readonly directionalConsistencyBps: number;
    readonly volatilityRatioBps: string | "UNBOUNDED";
    readonly netMoveSign: NetMoveSign;
  }>;
}

export interface InsufficientDataResult {
  readonly status: "INSUFFICIENT_DATA";
  readonly reason: "NOT_ENOUGH_CANDLES";
  readonly requiredCandles: number;
  readonly availableCandles: number;
}

export interface RejectedDataResult {
  readonly status: "DATA_REJECTED";
  readonly reason: RegimeRejectionReason;
}

export type RegimeResult = ReadyRegimeResult | InsufficientDataResult | RejectedDataResult;
