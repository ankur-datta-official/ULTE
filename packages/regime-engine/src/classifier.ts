import type { CandleSnapshot } from "@ulte/market-data";
import { createRegimeConfig, requiredCandleCount, type RegimeConfig } from "./config.js";
import {
  absolute, add, compare, compareRatioToBps, maximum, meanRatioBpsFloor, parseExact,
  scaledRatioFloor, subtract, type ExactDecimal,
} from "./internal/decimal.js";
import type {
  NetMoveSign, PrimaryRegime, ReadyRegimeResult, RegimeDirection, RegimeRejectionReason,
  RegimeResult, VolatilityState,
} from "./types.js";

const ZERO: ExactDecimal = Object.freeze({ coefficient: 0n, scale: 0 });

function rejected(reason: RegimeRejectionReason): RegimeResult {
  return Object.freeze({ status: "DATA_REJECTED", reason });
}

function validateWindow(candles: readonly CandleSnapshot[]): RegimeRejectionReason | undefined {
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

function trueRange(current: CandleSnapshot, previous: CandleSnapshot): ExactDecimal {
  const candle = current.candle;
  const priorClose = parseExact(previous.candle.close);
  return maximum(
    subtract(parseExact(candle.high), parseExact(candle.low)),
    absolute(subtract(parseExact(candle.high), priorClose)),
    absolute(subtract(parseExact(candle.low), priorClose)),
  );
}

function sum(values: readonly ExactDecimal[]): ExactDecimal {
  return values.reduce(add, ZERO);
}

export function classifyMarketRegime(
  candles: readonly CandleSnapshot[],
  config: RegimeConfig,
): RegimeResult {
  const validated = createRegimeConfig(config);
  const required = requiredCandleCount(validated);
  if (candles.length < required) {
    return Object.freeze({
      status: "INSUFFICIENT_DATA", reason: "NOT_ENOUGH_CANDLES",
      requiredCandles: required, availableCandles: candles.length,
    });
  }

  const window = candles.slice(candles.length - required);
  const invalidReason = validateWindow(window);
  if (invalidReason !== undefined) return rejected(invalidReason);

  const trend = window.slice(window.length - validated.trendLookback);
  const firstClose = parseExact(trend[0]!.candle.close);
  const lastClose = parseExact(trend[trend.length - 1]!.candle.close);
  const netMove = subtract(lastClose, firstClose);
  const netMoveSign: NetMoveSign = netMove.coefficient > 0n ? "POSITIVE" : netMove.coefficient < 0n ? "NEGATIVE" : "ZERO";
  const direction: RegimeDirection = netMoveSign === "POSITIVE" ? "UP" : netMoveSign === "NEGATIVE" ? "DOWN" : "NEUTRAL";

  const moves: ExactDecimal[] = [];
  let positiveMoves = 0;
  let negativeMoves = 0;
  for (let index = 1; index < trend.length; index += 1) {
    const move = subtract(parseExact(trend[index]!.candle.close), parseExact(trend[index - 1]!.candle.close));
    moves.push(absolute(move));
    if (move.coefficient > 0n) positiveMoves += 1;
    if (move.coefficient < 0n) negativeMoves += 1;
  }
  const pathLength = sum(moves);
  const efficiencyBps = pathLength.coefficient === 0n
    ? 0
    : parseInt(scaledRatioFloor(absolute(netMove), pathLength, 10_000n).toString(), 10);
  const nonZeroMoves = positiveMoves + negativeMoves;
  const matchingMoves = netMoveSign === "POSITIVE" ? positiveMoves : netMoveSign === "NEGATIVE" ? negativeMoves : 0;
  const directionalConsistencyBps = nonZeroMoves === 0 ? 0 : parseInt(
    (BigInt(matchingMoves) * 10_000n / BigInt(nonZeroMoves)).toString(), 10,
  );

  const volatilityCandleCount = validated.baselineVolatilityBars + validated.recentVolatilityBars + 1;
  const volatilityCandles = window.slice(window.length - volatilityCandleCount);
  const ranges: ExactDecimal[] = [];
  for (let index = 1; index < volatilityCandles.length; index += 1) {
    ranges.push(trueRange(volatilityCandles[index]!, volatilityCandles[index - 1]!));
  }
  const baselineSum = sum(ranges.slice(0, validated.baselineVolatilityBars));
  const recentSum = sum(ranges.slice(validated.baselineVolatilityBars));

  let volatilityState: VolatilityState;
  let volatilityRatioBps: string | "UNBOUNDED";
  if (baselineSum.coefficient === 0n) {
    if (recentSum.coefficient === 0n) {
      volatilityRatioBps = "10000";
      volatilityState = validated.compressionRatioMaxBps >= 10_000 ? "COMPRESSION"
        : validated.expansionRatioMinBps <= 10_000 ? "EXPANSION" : "NORMAL";
    } else {
      volatilityRatioBps = "UNBOUNDED";
      volatilityState = "EXPANSION";
    }
  } else {
    volatilityRatioBps = meanRatioBpsFloor(
      recentSum, validated.recentVolatilityBars, baselineSum, validated.baselineVolatilityBars,
    ).toString();
    if (compareRatioToBps(recentSum, validated.recentVolatilityBars, baselineSum,
      validated.baselineVolatilityBars, validated.compressionRatioMaxBps) <= 0) {
      volatilityState = "COMPRESSION";
    } else if (compareRatioToBps(recentSum, validated.recentVolatilityBars, baselineSum,
      validated.baselineVolatilityBars, validated.expansionRatioMinBps) >= 0) {
      volatilityState = "EXPANSION";
    } else volatilityState = "NORMAL";
  }

  let primaryRegime: PrimaryRegime;
  if (volatilityState === "COMPRESSION") primaryRegime = "COMPRESSION";
  else if (volatilityState === "EXPANSION") primaryRegime = "EXPANSION";
  else if (efficiencyBps >= validated.trendEfficiencyMinBps &&
           directionalConsistencyBps >= validated.trendConsistencyMinBps && netMoveSign === "POSITIVE") primaryRegime = "TREND_UP";
  else if (efficiencyBps >= validated.trendEfficiencyMinBps &&
           directionalConsistencyBps >= validated.trendConsistencyMinBps && netMoveSign === "NEGATIVE") primaryRegime = "TREND_DOWN";
  else if (efficiencyBps <= validated.rangeEfficiencyMaxBps &&
           directionalConsistencyBps <= validated.rangeConsistencyMaxBps) primaryRegime = "RANGE";
  else primaryRegime = "TRANSITION";

  const evidence = Object.freeze({ efficiencyBps, directionalConsistencyBps, volatilityRatioBps, netMoveSign });
  const result: ReadyRegimeResult = {
    status: "READY", primaryRegime, direction, volatilityState,
    instrumentId: window[0]!.candle.instrumentId, timeframe: window[0]!.candle.timeframe,
    windowStart: window[0]!.candle.openTime, windowEnd: window[window.length - 1]!.candle.closeTime,
    evidence,
  };
  return Object.freeze(result);
}
