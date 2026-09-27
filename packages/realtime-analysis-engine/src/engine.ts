import { unixMs, type TimeframeId, type UnixMs } from "@ulte/instrument-model";
import {
  createLiveStreamId,
  type LiveIngestionResult,
  type StreamResetResult,
} from "@ulte/live-market-data-engine";
import { createCandle, type CandleEngineEvent, type CandleSnapshot } from "@ulte/market-data";
import { classifyMarketRegime, requiredCandleCount } from "@ulte/regime-engine";
import { evaluatePositionSetups } from "@ulte/setup-engine";
import { analyzeMarketStructure } from "@ulte/structure-engine";
import { analysisProfileId, createRealtimeAnalysisConfig } from "./config.js";
import { createAnalysisCycleId, type AnalysisCycleId, type AnalysisProfileId } from "./identity.js";
import type {
  AnalysisCycleResult,
  AnalysisFrame,
  AnalysisTimeframeSnapshot,
  HistoryShortfall,
  RealtimeAnalysisConfig,
  RealtimeAnalysisEvaluators,
  RealtimeAnalysisProcessResult,
} from "./types.js";

const DEFAULT_EVALUATORS: RealtimeAnalysisEvaluators = Object.freeze({
  classifyRegime: classifyMarketRegime,
  analyzeStructure: analyzeMarketStructure,
  evaluateSetups: evaluatePositionSetups,
});

function cloneSnapshot(snapshot: CandleSnapshot): CandleSnapshot {
  return Object.freeze({
    candle: createCandle({ ...snapshot.candle }),
    quality: Object.freeze([...snapshot.quality]),
  });
}

function sameSnapshot(left: CandleSnapshot, right: CandleSnapshot): boolean {
  const a = left.candle;
  const b = right.candle;
  return a.instrumentId === b.instrumentId && a.timeframe === b.timeframe &&
    a.openTime === b.openTime && a.closeTime === b.closeTime && a.open === b.open &&
    a.high === b.high && a.low === b.low && a.close === b.close && a.volume === b.volume &&
    a.quoteVolume === b.quoteVolume && a.tradeCount === b.tradeCount && a.isClosed === b.isClosed &&
    left.quality.length === right.quality.length &&
    left.quality.every((value, index) => value === right.quality[index]);
}

function frozenNoAnalysis(
  reason: "INPUT_NOT_ACCEPTED" | "NO_FINALIZED_CANDLE" | "DUPLICATE_BOUNDARY" | "SOURCE_RESET",
  inputStatus?: Exclude<LiveIngestionResult["status"], "ACCEPTED">,
): RealtimeAnalysisProcessResult {
  return Object.freeze({
    status: "NO_ANALYSIS" as const,
    reason,
    ...(inputStatus === undefined ? {} : { inputStatus }),
  });
}

export class LateSameBoundaryFinalizationError extends TypeError {
  readonly code = "LATE_SAME_BOUNDARY_FINALIZATION" as const;
  readonly timeframe: TimeframeId;
  readonly closeTime: UnixMs;
  readonly latestPublishedBoundaryTime: UnixMs;

  constructor(timeframe: TimeframeId, closeTime: UnixMs, latestPublishedBoundaryTime: UnixMs) {
    super(
      `New ${timeframe} finalized candle at ${closeTime} cannot reopen analysis at or before ` +
      `latest published boundary ${latestPublishedBoundaryTime}`,
    );
    this.name = "LateSameBoundaryFinalizationError";
    this.timeframe = timeframe;
    this.closeTime = closeTime;
    this.latestPublishedBoundaryTime = latestPublishedBoundaryTime;
  }
}

export class RealtimeAnalysisEngine {
  readonly config: Readonly<RealtimeAnalysisConfig>;
  readonly analysisProfileId: AnalysisProfileId;
  private readonly evaluators: RealtimeAnalysisEvaluators;
  private readonly expectedStreamId: ReturnType<typeof createLiveStreamId>;
  private histories: Map<TimeframeId, readonly CandleSnapshot[]>;
  private readonly retainedCycleIds = new Set<AnalysisCycleId>();
  private readonly cycleOrder: AnalysisCycleId[] = [];
  private latestPublishedBoundaryTime: UnixMs | undefined;

  constructor(config: RealtimeAnalysisConfig, evaluators: RealtimeAnalysisEvaluators = DEFAULT_EVALUATORS) {
    this.config = createRealtimeAnalysisConfig(config);
    this.analysisProfileId = analysisProfileId(this.config);
    this.evaluators = Object.freeze({ ...evaluators });
    this.expectedStreamId = createLiveStreamId({
      sourceId: this.config.source,
      instrumentId: this.config.instrumentId,
      eventKind: "TRADE",
    });
    this.histories = new Map(this.config.timeframes.map((item) => [item.timeframe, Object.freeze([])]));
  }

  processLiveIngestion(result: LiveIngestionResult): RealtimeAnalysisProcessResult {
    if (result.streamId !== this.expectedStreamId) throw new TypeError("Live ingestion stream does not match analysis config");
    if (result.status !== "ACCEPTED") return frozenNoAnalysis("INPUT_NOT_ACCEPTED", result.status);
    return this.processCandleEvents(result.candleEvents);
  }

  processSourceReset(result: StreamResetResult): RealtimeAnalysisProcessResult {
    if (result.streamId !== this.expectedStreamId) throw new TypeError("Source reset stream does not match analysis config");
    return frozenNoAnalysis("SOURCE_RESET");
  }

  /**
   * Processes the complete, coherent output of exactly one
   * MultiTimeframeCandleEngine.process(...) call as one atomic batch.
   * This is not an arbitrary candle-event accumulator: a new timeframe
   * finalization for an already-published close boundary fails closed.
   */
  processCandleEvents(events: readonly CandleEngineEvent[]): RealtimeAnalysisProcessResult {
    const finalized = events.filter((event) => event.type === "CANDLE_CLOSED");
    if (finalized.length === 0) return frozenNoAnalysis("NO_FINALIZED_CANDLE");

    const staged = new Map<TimeframeId, readonly CandleSnapshot[]>(this.histories);
    const boundaries = new Map<UnixMs, true>();
    for (const event of finalized) {
      const snapshot = cloneSnapshot(event.snapshot);
      this.validateFinalized(event, snapshot);
      const current = staged.get(event.timeframe)!;
      const latest = current[current.length - 1];
      const existing = current.find((item) => item.candle.closeTime === snapshot.candle.closeTime);
      if (existing !== undefined) {
        if (!sameSnapshot(existing, snapshot)) {
          throw new TypeError("Conflicting finalized candle at an existing close time");
        }
        continue;
      }
      if (this.latestPublishedBoundaryTime !== undefined &&
          snapshot.candle.closeTime <= this.latestPublishedBoundaryTime) {
        throw new LateSameBoundaryFinalizationError(
          event.timeframe,
          snapshot.candle.closeTime,
          this.latestPublishedBoundaryTime,
        );
      }
      if (latest !== undefined && snapshot.candle.closeTime < latest.candle.closeTime) {
        throw new TypeError("Finalized candle history must be appended chronologically");
      }
      const limit = this.config.timeframes.find((item) => item.timeframe === event.timeframe)!.historyLimit;
      const appended = [...current, snapshot];
      if (appended.length > limit) appended.shift();
      staged.set(event.timeframe, Object.freeze(appended));
      boundaries.set(snapshot.candle.closeTime, true);
    }
    if (boundaries.size === 0) return frozenNoAnalysis("DUPLICATE_BOUNDARY");

    const pendingCycleIds: AnalysisCycleId[] = [];
    const cycles: AnalysisCycleResult[] = [];
    let greatestPublishedBoundaryTime: UnixMs | undefined;
    for (const triggerCloseTime of boundaries.keys()) {
      const cycleId = this.cycleId(triggerCloseTime);
      if (this.retainedCycleIds.has(cycleId)) continue;
      const frame = this.createFrame(staged, triggerCloseTime);
      cycles.push(this.evaluateCycle(cycleId, frame));
      pendingCycleIds.push(cycleId);
      if (greatestPublishedBoundaryTime === undefined || triggerCloseTime > greatestPublishedBoundaryTime) {
        greatestPublishedBoundaryTime = triggerCloseTime;
      }
    }
    if (cycles.length === 0) return frozenNoAnalysis("DUPLICATE_BOUNDARY");

    this.histories = staged;
    for (const cycleId of pendingCycleIds) this.retainCycleId(cycleId);
    if (greatestPublishedBoundaryTime === undefined) throw new Error("Published analysis batch has no boundary");
    this.latestPublishedBoundaryTime = greatestPublishedBoundaryTime;
    return Object.freeze({ status: "ANALYSIS_CYCLES", cycles: Object.freeze(cycles) });
  }

  getFinalizedHistories(): ReadonlyMap<TimeframeId, readonly CandleSnapshot[]> {
    return new Map([...this.histories].map(([timeframe, candles]) => [timeframe, Object.freeze([...candles])]));
  }

  private validateFinalized(event: Extract<CandleEngineEvent, { readonly type: "CANDLE_CLOSED" }>, snapshot: CandleSnapshot): void {
    if (!this.histories.has(event.timeframe)) throw new TypeError("Finalized candle timeframe is not configured");
    if (snapshot.candle.timeframe !== event.timeframe) throw new TypeError("Candle event timeframe does not match snapshot");
    if (snapshot.candle.instrumentId !== this.config.instrumentId) throw new TypeError("Finalized candle instrument mismatch");
    if (!snapshot.candle.isClosed) throw new TypeError("Only finalized candles may enter analysis history");
  }

  private createFrame(histories: ReadonlyMap<TimeframeId, readonly CandleSnapshot[]>, boundary: UnixMs): AnalysisFrame {
    const timeframes = this.config.timeframes.map((item): AnalysisTimeframeSnapshot => {
      const visible = histories.get(item.timeframe)!.filter((snapshot) => snapshot.candle.closeTime <= boundary);
      const candles = Object.freeze([...visible]);
      const gapCandleOpenTimes = Object.freeze(candles
        .filter((snapshot) => snapshot.quality.includes("GAP_DETECTED"))
        .map((snapshot) => snapshot.candle.openTime));
      return Object.freeze({
        timeframe: item.timeframe,
        status: candles.length === 0 ? "NO_FINALIZED_CANDLE" : "READY",
        candles,
        continuity: gapCandleOpenTimes.length === 0 ? "CONTIGUOUS" : "GAPPED",
        gapCandleOpenTimes,
      });
    });
    return Object.freeze({
      analysisAsOf: unixMs(boundary),
      triggerCloseTime: unixMs(boundary),
      timeframes: Object.freeze(timeframes),
    });
  }

  private evaluateCycle(cycleId: AnalysisCycleId, frame: AnalysisFrame): AnalysisCycleResult {
    const base = Object.freeze({
      analysisCycleId: cycleId,
      analysisProfileId: this.analysisProfileId,
      instrumentId: this.config.instrumentId,
      source: this.config.source,
      analysisAsOf: frame.analysisAsOf,
      triggerCloseTime: frame.triggerCloseTime,
      frame,
    });
    const shortfalls = this.historyShortfalls(frame);
    if (shortfalls.length > 0) {
      return Object.freeze({ ...base, status: "INSUFFICIENT_HISTORY", shortfalls: Object.freeze(shortfalls) });
    }
    const regimeCandles = this.frameCandles(frame, this.config.roles.regimeTimeframe);
    const structureCandles = this.frameCandles(frame, this.config.roles.structureTimeframe);
    const setupCandles = this.frameCandles(frame, this.config.roles.setupTimeframe);
    const regime = this.evaluators.classifyRegime(regimeCandles, this.config.regime);
    const structure = this.evaluators.analyzeStructure(structureCandles, this.config.structure);
    const setup = this.evaluators.evaluateSetups({
      asOf: frame.analysisAsOf,
      contextRegime: regime,
      setupStructure: structure,
      setupCandles,
    }, this.config.setup);
    const status = setup.status === "READY" && setup.candidates.length === 0 ? "NO_SETUP" : "ANALYZED";
    return Object.freeze({ ...base, status, regime, structure, setup });
  }

  private historyShortfalls(frame: AnalysisFrame): HistoryShortfall[] {
    const requirements = new Map<TimeframeId, number>();
    requirements.set(this.config.roles.regimeTimeframe, requiredCandleCount(this.config.regime));
    const structureRequired = this.config.structure.lookbackBars;
    const currentStructureRequired = requirements.get(this.config.roles.structureTimeframe) ?? 0;
    if (structureRequired > currentStructureRequired) {
      requirements.set(this.config.roles.structureTimeframe, structureRequired);
    }
    const currentSetupRequired = requirements.get(this.config.roles.setupTimeframe) ?? 0;
    if (currentSetupRequired < 1) requirements.set(this.config.roles.setupTimeframe, 1);
    const shortfalls: HistoryShortfall[] = [];
    for (const item of this.config.timeframes) {
      const requiredCandles = requirements.get(item.timeframe);
      if (requiredCandles === undefined) continue;
      const availableCandles = this.frameCandles(frame, item.timeframe).length;
      if (availableCandles < requiredCandles) {
        shortfalls.push(Object.freeze({ timeframe: item.timeframe, requiredCandles, availableCandles }));
      }
    }
    return shortfalls;
  }

  private frameCandles(frame: AnalysisFrame, timeframe: TimeframeId): readonly CandleSnapshot[] {
    const snapshot = frame.timeframes.find((item) => item.timeframe === timeframe);
    if (snapshot === undefined) throw new Error("Configured timeframe missing from analysis frame");
    return snapshot.candles;
  }

  private retainCycleId(cycleId: AnalysisCycleId): void {
    this.retainedCycleIds.add(cycleId);
    this.cycleOrder.push(cycleId);
    if (this.cycleOrder.length > this.config.cycleDeduplicationWindowSize) {
      const evicted = this.cycleOrder.shift();
      if (evicted === undefined) throw new Error("Analysis cycle deduplication state is corrupt");
      this.retainedCycleIds.delete(evicted);
    }
  }

  private cycleId(triggerCloseTime: UnixMs): AnalysisCycleId {
    return createAnalysisCycleId({
      instrumentId: this.config.instrumentId,
      source: this.config.source,
      triggerCloseTime,
      analysisProfileId: this.analysisProfileId,
    });
  }
}
