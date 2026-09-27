import type { InstrumentId, TimeframeId, UnixMs } from "@ulte/instrument-model";
import type { LiveIngestionResult } from "@ulte/live-market-data-engine";
import type { CandleSnapshot, MarketDataSource } from "@ulte/market-data";
import type { RegimeConfig, RegimeResult } from "@ulte/regime-engine";
import type { PositionSetupConfig, SetupEvaluationResult } from "@ulte/setup-engine";
import type { StructureAnalysisResult, StructureConfig } from "@ulte/structure-engine";
import type { AnalysisCycleId, AnalysisProfileId } from "./identity.js";

export interface AnalysisTimeframeConfig {
  readonly timeframe: TimeframeId;
  readonly historyLimit: number;
}

export interface AnalysisTimeframeRoles {
  readonly regimeTimeframe: TimeframeId;
  readonly structureTimeframe: TimeframeId;
  readonly setupTimeframe: TimeframeId;
}

export interface RealtimeAnalysisConfig {
  readonly profileVersion: string;
  readonly instrumentId: InstrumentId;
  readonly source: MarketDataSource;
  readonly timeframes: readonly AnalysisTimeframeConfig[];
  readonly roles: AnalysisTimeframeRoles;
  readonly regime: RegimeConfig;
  readonly structure: StructureConfig;
  readonly setup: PositionSetupConfig;
  readonly cycleDeduplicationWindowSize: number;
}

export interface AnalysisTimeframeSnapshot {
  readonly timeframe: TimeframeId;
  readonly status: "READY" | "NO_FINALIZED_CANDLE";
  readonly candles: readonly CandleSnapshot[];
  readonly continuity: "CONTIGUOUS" | "GAPPED";
  readonly gapCandleOpenTimes: readonly UnixMs[];
}

export interface AnalysisFrame {
  readonly analysisAsOf: UnixMs;
  readonly triggerCloseTime: UnixMs;
  readonly timeframes: readonly AnalysisTimeframeSnapshot[];
}

export interface HistoryShortfall {
  readonly timeframe: TimeframeId;
  readonly requiredCandles: number;
  readonly availableCandles: number;
}

interface CycleBase {
  readonly analysisCycleId: AnalysisCycleId;
  readonly analysisProfileId: AnalysisProfileId;
  readonly instrumentId: InstrumentId;
  readonly source: MarketDataSource;
  readonly analysisAsOf: UnixMs;
  readonly triggerCloseTime: UnixMs;
  readonly frame: AnalysisFrame;
}

export interface InsufficientHistoryCycleResult extends CycleBase {
  readonly status: "INSUFFICIENT_HISTORY";
  readonly shortfalls: readonly HistoryShortfall[];
}

export interface EvaluatedAnalysisCycleResult extends CycleBase {
  readonly status: "ANALYZED" | "NO_SETUP";
  readonly regime: RegimeResult;
  readonly structure: StructureAnalysisResult;
  readonly setup: SetupEvaluationResult;
}

export type AnalysisCycleResult = InsufficientHistoryCycleResult | EvaluatedAnalysisCycleResult;

export type NoAnalysisReason =
  | "INPUT_NOT_ACCEPTED"
  | "NO_FINALIZED_CANDLE"
  | "DUPLICATE_BOUNDARY"
  | "SOURCE_RESET";

export type RealtimeAnalysisProcessResult =
  | Readonly<{
      readonly status: "NO_ANALYSIS";
      readonly reason: NoAnalysisReason;
      readonly inputStatus?: Exclude<LiveIngestionResult["status"], "ACCEPTED">;
    }>
  | Readonly<{
      readonly status: "ANALYSIS_CYCLES";
      readonly cycles: readonly AnalysisCycleResult[];
    }>;

export interface RealtimeAnalysisEvaluators {
  readonly classifyRegime: (candles: readonly CandleSnapshot[], config: RegimeConfig) => RegimeResult;
  readonly analyzeStructure: (
    candles: readonly CandleSnapshot[], config: StructureConfig,
  ) => StructureAnalysisResult;
  readonly evaluateSetups: (
    input: {
      readonly asOf: UnixMs;
      readonly contextRegime: RegimeResult;
      readonly setupStructure: StructureAnalysisResult;
      readonly setupCandles: readonly CandleSnapshot[];
    },
    config: PositionSetupConfig,
  ) => SetupEvaluationResult;
}
