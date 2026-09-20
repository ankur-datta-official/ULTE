import type { PositiveDecimalString } from "@ulte/instrument-model";
import type { CandleSnapshot } from "@ulte/market-data";
import { createStructureConfig, type StructureConfig } from "./config.js";
import { compareDecimalStrings } from "./internal/decimal.js";
import type {
  LiquidityLevel, LiquiditySide, ReadyStructureResult, StructureAnalysisResult,
  StructureEvent, StructureEventType, StructureRejectionReason, StructuralState,
  SwingKind, SwingPoint, SwingRelation,
} from "./types.js";

interface MutableLevel {
  readonly side: LiquiditySide;
  readonly price: PositiveDecimalString;
  readonly sourceSwingId: string;
  readonly sourcePivotOpenTime: SwingPoint["pivotOpenTime"];
  readonly confirmedAt: SwingPoint["confirmedAt"];
  status: "ACTIVE" | "SWEPT" | "BROKEN";
  resolvedAt?: SwingPoint["confirmedAt"];
}

function rejected(reason: StructureRejectionReason): StructureAnalysisResult {
  return Object.freeze({ status: "DATA_REJECTED", reason });
}

function validateWindow(candles: readonly CandleSnapshot[]): StructureRejectionReason | undefined {
  const first = candles[0]!;
  const openTimes = new Set<number>();
  for (let index = 0; index < candles.length; index += 1) {
    const current = candles[index]!;
    if (!current.candle.isClosed) return "OPEN_CANDLE";
    if (current.candle.instrumentId !== first.candle.instrumentId) return "INSTRUMENT_MISMATCH";
    if (current.candle.timeframe !== first.candle.timeframe) return "TIMEFRAME_MISMATCH";
    if (current.quality.includes("GAP_DETECTED")) return "DATA_GAP";
    if (openTimes.has(current.candle.openTime)) return "DUPLICATE_CANDLE";
    openTimes.add(current.candle.openTime);
    if (current.candle.closeTime <= current.candle.openTime) return "OUT_OF_ORDER";
    if (index > 0) {
      const previous = candles[index - 1]!.candle;
      if (current.candle.openTime < previous.openTime || current.candle.closeTime <= previous.closeTime ||
          current.candle.openTime < previous.closeTime) return "OUT_OF_ORDER";
    }
  }
  return undefined;
}

function isPivot(
  candles: readonly CandleSnapshot[], index: number, kind: SwingKind, left: number, right: number,
): boolean {
  const price = kind === "HIGH" ? candles[index]!.candle.high : candles[index]!.candle.low;
  for (let compared = index - left; compared <= index + right; compared += 1) {
    if (compared === index) continue;
    const other = kind === "HIGH" ? candles[compared]!.candle.high : candles[compared]!.candle.low;
    const comparison = compareDecimalStrings(price, other);
    if (kind === "HIGH" ? comparison <= 0 : comparison >= 0) return false;
  }
  return true;
}

function relationFor(kind: SwingKind, price: PositiveDecimalString, previous: SwingPoint | undefined): SwingRelation {
  if (previous === undefined) return "UNCLASSIFIED";
  const comparison = compareDecimalStrings(price, previous.price);
  if (kind === "HIGH") return comparison > 0 ? "HIGHER_HIGH" : comparison < 0 ? "LOWER_HIGH" : "EQUAL_HIGH";
  return comparison > 0 ? "HIGHER_LOW" : comparison < 0 ? "LOWER_LOW" : "EQUAL_LOW";
}

function structuralState(high: SwingPoint | undefined, low: SwingPoint | undefined): StructuralState {
  if (high === undefined || low === undefined || high.relation === "UNCLASSIFIED" || low.relation === "UNCLASSIFIED") {
    return "UNDETERMINED";
  }
  if (high.relation === "HIGHER_HIGH" && low.relation === "HIGHER_LOW") return "UP";
  if (high.relation === "LOWER_HIGH" && low.relation === "LOWER_LOW") return "DOWN";
  return "MIXED";
}

function eventType(level: MutableLevel, candle: CandleSnapshot): StructureEventType | undefined {
  if (level.side === "BUY_SIDE") {
    if (compareDecimalStrings(candle.candle.close, level.price) > 0) return "CLOSE_BREAK_ABOVE";
    if (compareDecimalStrings(candle.candle.high, level.price) > 0) return "SWEEP_ABOVE_RECLAIM";
  } else {
    if (compareDecimalStrings(candle.candle.close, level.price) < 0) return "CLOSE_BREAK_BELOW";
    if (compareDecimalStrings(candle.candle.low, level.price) < 0) return "SWEEP_BELOW_RECLAIM";
  }
  return undefined;
}

export function analyzeMarketStructure(
  candles: readonly CandleSnapshot[], config: StructureConfig,
): StructureAnalysisResult {
  const validated = createStructureConfig(config);
  if (candles.length < validated.lookbackBars) {
    return Object.freeze({
      status: "INSUFFICIENT_DATA", reason: "NOT_ENOUGH_CANDLES",
      requiredCandles: validated.lookbackBars, availableCandles: candles.length,
    });
  }
  const window = candles.slice(candles.length - validated.lookbackBars);
  const invalid = validateWindow(window);
  if (invalid !== undefined) return rejected(invalid);

  const swings: SwingPoint[] = [];
  const levels: MutableLevel[] = [];
  const events: StructureEvent[] = [];
  let latestHigh: SwingPoint | undefined;
  let latestLow: SwingPoint | undefined;

  for (let currentIndex = 0; currentIndex < window.length; currentIndex += 1) {
    const current = window[currentIndex]!;
    for (const level of levels) {
      if (level.status !== "ACTIVE") continue;
      const type = eventType(level, current);
      if (type === undefined) continue;
      level.status = type.startsWith("CLOSE_BREAK") ? "BROKEN" : "SWEPT";
      level.resolvedAt = current.candle.closeTime;
      events.push(Object.freeze({
        type, instrumentId: current.candle.instrumentId, timeframe: current.candle.timeframe,
        detectedAt: current.candle.closeTime, eventCandleOpenTime: current.candle.openTime,
        referenceSwingId: level.sourceSwingId, referenceSwingTime: level.sourcePivotOpenTime,
        referencePrice: level.price, liquiditySide: level.side,
      }));
    }

    const pivotIndex = currentIndex - validated.pivotRightBars;
    if (pivotIndex < validated.pivotLeftBars) continue;
    for (const kind of ["HIGH", "LOW"] as const) {
      if (!isPivot(window, pivotIndex, kind, validated.pivotLeftBars, validated.pivotRightBars)) continue;
      const pivot = window[pivotIndex]!.candle;
      const price = kind === "HIGH" ? pivot.high : pivot.low;
      const previous = kind === "HIGH" ? latestHigh : latestLow;
      const swing: SwingPoint = Object.freeze({
        id: `${kind}:${pivot.openTime}`, kind, price, pivotOpenTime: pivot.openTime,
        pivotCloseTime: pivot.closeTime, confirmedAt: current.candle.closeTime,
        relation: relationFor(kind, price, previous),
      });
      swings.push(swing);
      if (kind === "HIGH") latestHigh = swing;
      else latestLow = swing;
      levels.push({
        side: kind === "HIGH" ? "BUY_SIDE" : "SELL_SIDE", price,
        sourceSwingId: swing.id, sourcePivotOpenTime: swing.pivotOpenTime,
        confirmedAt: swing.confirmedAt, status: "ACTIVE",
      });
    }
  }

  const publicLevels: readonly LiquidityLevel[] = Object.freeze(levels.map((level) => Object.freeze({
    side: level.side, price: level.price, sourceSwingId: level.sourceSwingId,
    sourcePivotOpenTime: level.sourcePivotOpenTime, confirmedAt: level.confirmedAt,
    status: level.status, ...(level.resolvedAt === undefined ? {} : { resolvedAt: level.resolvedAt }),
  })));
  const result: ReadyStructureResult = {
    status: "READY", instrumentId: window[0]!.candle.instrumentId, timeframe: window[0]!.candle.timeframe,
    windowStart: window[0]!.candle.openTime, windowEnd: window[window.length - 1]!.candle.closeTime,
    structureState: structuralState(latestHigh, latestLow),
    confirmedSwings: Object.freeze([...swings]), liquidityLevels: publicLevels,
    structureEvents: Object.freeze([...events]),
    ...(latestHigh === undefined ? {} : { latestConfirmedHigh: latestHigh }),
    ...(latestLow === undefined ? {} : { latestConfirmedLow: latestLow }),
  };
  return Object.freeze(result);
}
