import { unixMs } from "@ulte/instrument-model";
import type { CandleSnapshot } from "@ulte/market-data";
import type { PrimaryRegime, ReadyRegimeResult } from "@ulte/regime-engine";
import type { LiquidityLevel, ReadyStructureResult, StructureEvent } from "@ulte/structure-engine";
import { createPositionSetupConfig, type PositionSetupConfig } from "./config.js";
import { compareDecimalStrings } from "./internal/decimal.js";
import type {
  EventEvidence, PositionSetupInput, ReadySetupEvaluationResult, SetupCandidate,
  RetestEvidence, SetupDataRejectionReason, SetupDirection, SetupEvaluationResult, SetupFamily,
} from "./types.js";

function rejected(reason: SetupDataRejectionReason): SetupEvaluationResult {
  return Object.freeze({ status: "DATA_REJECTED", reason });
}

function validateCandles(
  candles: readonly CandleSnapshot[], structure: ReadyStructureResult, asOf: number,
): SetupDataRejectionReason | undefined {
  let previousOpen: number | undefined;
  let previousClose: number | undefined;
  const openTimes = new Set<number>();
  for (const snapshot of candles) {
    const candle = snapshot.candle;
    if (candle.instrumentId !== structure.instrumentId) return "SETUP_CANDLE_INSTRUMENT_MISMATCH";
    if (candle.timeframe !== structure.timeframe) return "SETUP_TIMEFRAME_MISMATCH";
    if (!candle.isClosed) return "OPEN_SETUP_CANDLE";
    if (candle.closeTime > asOf) return "FUTURE_SETUP_CANDLE";
    if (snapshot.quality.includes("GAP_DETECTED")) return "DATA_GAP";
    if (openTimes.has(candle.openTime)) return "DUPLICATE_SETUP_CANDLE";
    if (previousOpen !== undefined) {
      if (candle.openTime < previousOpen || candle.closeTime <= previousClose! || candle.openTime < previousClose!) {
        return "OUT_OF_ORDER_SETUP_CANDLES";
      }
    }
    openTimes.add(candle.openTime);
    previousOpen = candle.openTime;
    previousClose = candle.closeTime;
  }
  return undefined;
}

function cloneLevel(level: LiquidityLevel): LiquidityLevel {
  return Object.freeze({ ...level });
}

function cloneEvent(event: StructureEvent): StructureEvent {
  return Object.freeze({ ...event });
}

function evidence(event: StructureEvent, level: LiquidityLevel): EventEvidence {
  return Object.freeze({ event: cloneEvent(event), referenceLevel: cloneLevel(level) });
}

function levelFor(
  structure: ReadyStructureResult, event: StructureEvent, knownBy: number,
): LiquidityLevel | undefined {
  const level = structure.liquidityLevels.find((item) => item.sourceSwingId === event.referenceSwingId);
  return level !== undefined && level.confirmedAt <= knownBy ? level : undefined;
}

function candidate(
  family: SetupFamily, direction: SetupDirection, initiation: EventEvidence,
  confirmation: EventEvidence | RetestEvidence | undefined,
  regime: ReadyRegimeResult, structure: ReadyStructureResult, asOf: ReadySetupEvaluationResult["asOf"],
): SetupCandidate {
  const confirmedAt = confirmation === undefined ? undefined :
    "event" in confirmation ? confirmation.event.detectedAt : confirmation.candleCloseTime;
  return Object.freeze({
    id: `${family}:${direction}:${initiation.event.detectedAt}:${initiation.event.referenceSwingId}`,
    family, direction, stage: confirmation === undefined ? "ARMED" : "CONFIRMED",
    instrumentId: structure.instrumentId, contextTimeframe: regime.timeframe,
    setupTimeframe: structure.timeframe, asOf, initiatedAt: initiation.event.detectedAt,
    ...(confirmedAt === undefined ? {} : { confirmedAt }),
    evidence: Object.freeze({ initiation, ...(confirmation === undefined ? {} : { confirmation }) }),
  });
}

function latestEvent(
  events: readonly StructureEvent[], type: StructureEvent["type"], structure: ReadyStructureResult,
): EventEvidence | undefined {
  let result: EventEvidence | undefined;
  for (const event of events) {
    if (event.type !== type) continue;
    const level = levelFor(structure, event, event.detectedAt);
    if (level !== undefined) result = evidence(event, level);
  }
  return result;
}

function laterBreak(
  events: readonly StructureEvent[], initiation: EventEvidence, breakType: StructureEvent["type"],
  structure: ReadyStructureResult,
): EventEvidence | undefined {
  for (const event of events) {
    if (event.type !== breakType || event.detectedAt <= initiation.event.detectedAt) continue;
    const level = levelFor(structure, event, initiation.event.detectedAt);
    if (level !== undefined) return evidence(event, level);
  }
  return undefined;
}

function sequenceCandidate(
  family: SetupFamily, direction: SetupDirection, sweepType: StructureEvent["type"],
  breakType: StructureEvent["type"], events: readonly StructureEvent[], regime: ReadyRegimeResult,
  structure: ReadyStructureResult, asOf: ReadySetupEvaluationResult["asOf"],
): SetupCandidate | undefined {
  const initiation = latestEvent(events, sweepType, structure);
  if (initiation === undefined) return undefined;
  return candidate(family, direction, initiation, laterBreak(events, initiation, breakType, structure), regime, structure, asOf);
}

function breakoutCandidate(
  direction: SetupDirection, events: readonly StructureEvent[], candles: readonly CandleSnapshot[],
  regime: ReadyRegimeResult, structure: ReadyStructureResult, asOf: ReadySetupEvaluationResult["asOf"],
): SetupCandidate | undefined {
  const breakType = direction === "UP" ? "CLOSE_BREAK_ABOVE" : "CLOSE_BREAK_BELOW";
  const initiation = latestEvent(events, breakType, structure);
  if (initiation === undefined) return undefined;
  const price = initiation.event.referencePrice;
  const retest = candles.find(({ candle }) => candle.closeTime > initiation.event.detectedAt &&
    (direction === "UP"
      ? compareDecimalStrings(candle.low, price) <= 0 && compareDecimalStrings(candle.close, price) >= 0
      : compareDecimalStrings(candle.high, price) >= 0 && compareDecimalStrings(candle.close, price) <= 0));
  const confirmation = retest === undefined ? undefined : Object.freeze({
    candleOpenTime: retest.candle.openTime, candleCloseTime: retest.candle.closeTime, referencePrice: price,
  });
  return candidate("BREAKOUT_RETEST", direction, initiation, confirmation, regime, structure, asOf);
}

function allows(values: readonly PrimaryRegime[], regime: ReadyRegimeResult): boolean {
  return values.includes(regime.primaryRegime);
}

export function evaluatePositionSetups(
  input: PositionSetupInput, rawConfig: PositionSetupConfig,
): SetupEvaluationResult {
  const config = createPositionSetupConfig(rawConfig);
  const asOf = unixMs(input.asOf);
  if (input.contextRegime.status !== "READY") return Object.freeze({
    status: "UPSTREAM_NOT_READY", source: "REGIME", upstreamStatus: input.contextRegime.status,
    reason: input.contextRegime.reason,
  });
  if (input.setupStructure.status !== "READY") return Object.freeze({
    status: "UPSTREAM_NOT_READY", source: "STRUCTURE", upstreamStatus: input.setupStructure.status,
    reason: input.setupStructure.reason,
  });
  const regime = input.contextRegime;
  const structure = input.setupStructure;
  if (regime.instrumentId !== structure.instrumentId) return rejected("INSTRUMENT_MISMATCH");
  if (regime.windowEnd > asOf) return rejected("FUTURE_REGIME_WINDOW");
  if (structure.windowEnd > asOf) return rejected("FUTURE_STRUCTURE_WINDOW");
  const candleRejection = validateCandles(input.setupCandles, structure, asOf);
  if (candleRejection !== undefined) return rejected(candleRejection);

  const events = structure.structureEvents.filter((event) => event.detectedAt <= asOf);
  let previousEventTime: number | undefined;
  for (const event of events) {
    if (previousEventTime !== undefined && event.detectedAt < previousEventTime) {
      return rejected("OUT_OF_ORDER_STRUCTURE_EVENTS");
    }
    previousEventTime = event.detectedAt;
  }
  const candidates: SetupCandidate[] = [];
  if (allows(config.continuationAllowedRegimes, regime)) {
    if (regime.direction === "UP") {
      const value = sequenceCandidate("TREND_PULLBACK_CONTINUATION", "UP", "SWEEP_BELOW_RECLAIM", "CLOSE_BREAK_ABOVE", events, regime, structure, asOf);
      if (value !== undefined) candidates.push(value);
    } else if (regime.direction === "DOWN") {
      const value = sequenceCandidate("TREND_PULLBACK_CONTINUATION", "DOWN", "SWEEP_ABOVE_RECLAIM", "CLOSE_BREAK_BELOW", events, regime, structure, asOf);
      if (value !== undefined) candidates.push(value);
    }
  }
  if (allows(config.breakoutAllowedRegimes, regime)) {
    if (regime.direction !== "DOWN") {
      const value = breakoutCandidate("UP", events, input.setupCandles, regime, structure, asOf);
      if (value !== undefined) candidates.push(value);
    }
    if (regime.direction !== "UP") {
      const value = breakoutCandidate("DOWN", events, input.setupCandles, regime, structure, asOf);
      if (value !== undefined) candidates.push(value);
    }
  }
  if (allows(config.reversalAllowedRegimes, regime)) {
    const down = sequenceCandidate("LIQUIDITY_SWEEP_REVERSAL", "DOWN", "SWEEP_ABOVE_RECLAIM", "CLOSE_BREAK_BELOW", events, regime, structure, asOf);
    const up = sequenceCandidate("LIQUIDITY_SWEEP_REVERSAL", "UP", "SWEEP_BELOW_RECLAIM", "CLOSE_BREAK_ABOVE", events, regime, structure, asOf);
    if (down !== undefined) candidates.push(down);
    if (up !== undefined) candidates.push(up);
  }
  return Object.freeze({
    status: "READY", instrumentId: structure.instrumentId, asOf,
    contextTimeframe: regime.timeframe, setupTimeframe: structure.timeframe,
    candidates: Object.freeze(candidates),
  });
}
