import { unixMs, type DecimalString, type PositiveDecimalString } from "@ulte/instrument-model";
import type { CandleSnapshot } from "@ulte/market-data";
import type { EventEvidence, RetestEvidence, SetupCandidate } from "@ulte/setup-engine";
import type { LiquidityLevel, ReadyStructureResult, StructureEvent } from "@ulte/structure-engine";
import { createRiskCostAssumptions, createRiskQualificationConfig } from "./config.js";
import { add, asNonNegative, asPositive, basisPointCost, compare, ratioBps, ratioMeetsMinimum, subtract } from "./internal/decimal.js";
import type {
  RiskCalculation, RiskDataRejectionReason, RiskNotQualifiedReason, RiskQualificationInput,
  RiskQualificationResult, RiskTargetPathItem,
} from "./types.js";

type Identity = Pick<RiskCalculation, "candidateId" | "family" | "direction" | "instrumentId" | "setupTimeframe" | "asOf">;

function identity(candidate: SetupCandidate): Identity {
  return {
    candidateId: candidate.id, family: candidate.family, direction: candidate.direction,
    instrumentId: candidate.instrumentId, setupTimeframe: candidate.setupTimeframe, asOf: candidate.asOf,
  };
}

function dataRejected(candidate: SetupCandidate, reason: RiskDataRejectionReason): RiskQualificationResult {
  return Object.freeze({ status: "DATA_REJECTED", ...identity(candidate), reason });
}

function notQualified(
  candidate: SetupCandidate,
  reason: Exclude<RiskNotQualifiedReason, "NET_RR_BELOW_MINIMUM">,
  details: Partial<Pick<RiskCalculation, "entryReferencePrice" | "invalidationPrice" | "primaryTargetPrice" | "targetPath">> = {},
): RiskQualificationResult {
  return Object.freeze({ status: "NOT_QUALIFIED", ...identity(candidate), reason, ...details });
}

function validateCandles(
  candles: readonly CandleSnapshot[], candidate: SetupCandidate,
): RiskDataRejectionReason | undefined {
  let previousOpen: number | undefined;
  let previousClose: number | undefined;
  const openTimes = new Set<number>();
  for (const snapshot of candles) {
    const candle = snapshot.candle;
    if (candle.instrumentId !== candidate.instrumentId) return "INSTRUMENT_MISMATCH";
    if (candle.timeframe !== candidate.setupTimeframe) return "SETUP_TIMEFRAME_MISMATCH";
    if (!candle.isClosed) return "OPEN_SETUP_CANDLE";
    if (candle.closeTime > candidate.asOf) return "FUTURE_SETUP_CANDLE";
    if (snapshot.quality.includes("GAP_DETECTED")) return "DATA_GAP";
    if (openTimes.has(candle.openTime)) return "DUPLICATE_SETUP_CANDLE";
    if (previousOpen !== undefined &&
        (candle.openTime < previousOpen || candle.closeTime <= previousClose! || candle.openTime < previousClose!)) {
      return "OUT_OF_ORDER_SETUP_CANDLES";
    }
    openTimes.add(candle.openTime);
    previousOpen = candle.openTime;
    previousClose = candle.closeTime;
  }
  return undefined;
}

function eventCandle(candles: readonly CandleSnapshot[], event: StructureEvent): CandleSnapshot | undefined {
  return candles.find(({ candle }) =>
    candle.openTime === event.eventCandleOpenTime && candle.closeTime === event.detectedAt);
}

function retestCandle(candles: readonly CandleSnapshot[], retest: RetestEvidence): CandleSnapshot | undefined {
  return candles.find(({ candle }) =>
    candle.openTime === retest.candleOpenTime && candle.closeTime === retest.candleCloseTime);
}

function confirmationEvidence(candidate: SetupCandidate): EventEvidence | RetestEvidence | undefined {
  return candidate.evidence.confirmation;
}

function evidenceTime(evidence: EventEvidence | RetestEvidence): number {
  return "event" in evidence ? evidence.event.detectedAt : evidence.candleCloseTime;
}

function confirmationCandle(
  candidate: SetupCandidate, candles: readonly CandleSnapshot[],
): CandleSnapshot | undefined {
  const confirmation = confirmationEvidence(candidate);
  if (confirmation === undefined) return undefined;
  return "event" in confirmation
    ? eventCandle(candles, confirmation.event)
    : retestCandle(candles, confirmation);
}

function expectedSweepType(candidate: SetupCandidate): StructureEvent["type"] {
  return candidate.direction === "UP" ? "SWEEP_BELOW_RECLAIM" : "SWEEP_ABOVE_RECLAIM";
}

function orderedTargets(candidate: SetupCandidate, structure: ReadyStructureResult, entry: PositiveDecimalString): readonly RiskTargetPathItem[] {
  const targets: RiskTargetPathItem[] = [];
  for (const level of structure.liquidityLevels) {
    if (level.status !== "ACTIVE" || level.confirmedAt > candidate.asOf) continue;
    const eligible = candidate.direction === "UP"
      ? level.side === "BUY_SIDE" && compare(level.price, entry) > 0
      : level.side === "SELL_SIDE" && compare(level.price, entry) < 0;
    if (!eligible) continue;
    const item = Object.freeze({
      price: level.price, sourceSwingId: level.sourceSwingId,
      confirmedAt: level.confirmedAt, liquiditySide: level.side,
    });
    let insertionIndex = targets.length;
    for (let index = 0; index < targets.length; index += 1) {
      const comparison = compare(item.price, targets[index]!.price);
      if ((candidate.direction === "UP" && comparison < 0) ||
          (candidate.direction === "DOWN" && comparison > 0)) {
        insertionIndex = index;
        break;
      }
    }
    targets.splice(insertionIndex, 0, item);
  }
  return Object.freeze(targets);
}

function invalidationCandle(
  candidate: SetupCandidate, candles: readonly CandleSnapshot[], confirmation: CandleSnapshot,
): CandleSnapshot | "INVALID" | undefined {
  if (candidate.family === "BREAKOUT_RETEST") return confirmation;
  const initiation = candidate.evidence.initiation;
  if (initiation === undefined || initiation.event.type !== expectedSweepType(candidate)) return "INVALID";
  return eventCandle(candles, initiation.event);
}

function directionDifference(
  candidate: SetupCandidate, higher: PositiveDecimalString, lower: PositiveDecimalString,
): PositiveDecimalString {
  return asPositive(candidate.direction === "UP" ? subtract(higher, lower) : subtract(lower, higher));
}

export function qualifyStructuralRisk(input: RiskQualificationInput): RiskQualificationResult {
  const config = createRiskQualificationConfig(input.config);
  const costs = createRiskCostAssumptions(input.costs);
  const candidate = input.candidate;
  unixMs(candidate.asOf);

  if (candidate.stage !== "CONFIRMED") return notQualified(candidate, "SETUP_NOT_CONFIRMED");
  if (candidate.instrumentId !== input.structure.instrumentId) return dataRejected(candidate, "INSTRUMENT_MISMATCH");
  if (candidate.setupTimeframe !== input.structure.timeframe) return dataRejected(candidate, "SETUP_TIMEFRAME_MISMATCH");
  if (input.structure.windowEnd > candidate.asOf) return dataRejected(candidate, "FUTURE_STRUCTURE_WINDOW");
  const candleRejection = validateCandles(input.setupCandles, candidate);
  if (candleRejection !== undefined) return dataRejected(candidate, candleRejection);

  const confirmation = confirmationEvidence(candidate);
  if (candidate.confirmedAt === undefined || candidate.confirmedAt > candidate.asOf ||
      confirmation === undefined || evidenceTime(confirmation) !== candidate.confirmedAt) {
    return dataRejected(candidate, "INVALID_CONFIRMED_AT");
  }
  const confirmationSnapshot = confirmationCandle(candidate, input.setupCandles);
  if (confirmationSnapshot === undefined) return notQualified(candidate, "CONFIRMATION_CANDLE_NOT_FOUND");
  const entry = confirmationSnapshot.candle.close;
  const invalidationSnapshot = invalidationCandle(candidate, input.setupCandles, confirmationSnapshot);
  if (invalidationSnapshot === "INVALID") {
    return notQualified(candidate, "INVALID_STRUCTURAL_INVALIDATION", { entryReferencePrice: entry });
  }
  if (invalidationSnapshot === undefined) {
    return notQualified(candidate, "INITIATION_CANDLE_NOT_FOUND", { entryReferencePrice: entry });
  }
  const invalidation = candidate.direction === "UP"
    ? invalidationSnapshot.candle.low
    : invalidationSnapshot.candle.high;
  const invalidationComparison = compare(invalidation, entry);
  if ((candidate.direction === "UP" && invalidationComparison >= 0) ||
      (candidate.direction === "DOWN" && invalidationComparison <= 0)) {
    return notQualified(candidate, "INVALID_STRUCTURAL_INVALIDATION", {
      entryReferencePrice: entry, invalidationPrice: invalidation,
    });
  }

  const targetPath = orderedTargets(candidate, input.structure, entry);
  const primaryTarget = targetPath[0];
  if (primaryTarget === undefined) {
    return notQualified(candidate, "NO_STRUCTURAL_TARGET", {
      entryReferencePrice: entry, invalidationPrice: invalidation, targetPath,
    });
  }
  const grossRisk = directionDifference(candidate, entry, invalidation);
  const grossReward = directionDifference(candidate, primaryTarget.price, entry);
  const entryCost = basisPointCost(entry, costs.entryCostBps);
  const targetExitCost = basisPointCost(primaryTarget.price, costs.targetExitCostBps);
  const stopExitCost = basisPointCost(invalidation, costs.stopExitCostBps);
  const netRiskValue = add(add(grossRisk, entryCost), stopExitCost);
  if (compare(netRiskValue, "0" as DecimalString) <= 0) return dataRejected(candidate, "INVALID_NET_RISK");
  const netRisk = asPositive(netRiskValue);
  const netRewardValue = subtract(subtract(grossReward, entryCost), targetExitCost);
  if (compare(netRewardValue, "0" as DecimalString) <= 0) {
    return notQualified(candidate, "COSTS_CONSUME_REWARD", {
      entryReferencePrice: entry, invalidationPrice: invalidation,
      primaryTargetPrice: primaryTarget.price, targetPath,
    });
  }
  const netReward = asPositive(netRewardValue);
  const calculation: RiskCalculation = {
    ...identity(candidate), entryReferencePrice: entry, invalidationPrice: invalidation,
    primaryTargetPrice: primaryTarget.price, grossRisk, grossReward,
    entryCost: asNonNegative(entryCost), targetExitCost: asNonNegative(targetExitCost),
    stopExitCost: asNonNegative(stopExitCost), netRisk, netReward,
    netRewardRiskBps: ratioBps(netReward, netRisk),
    minimumRequiredNetRewardRiskBps: config.minimumNetRewardRiskBps, targetPath,
  };
  if (!ratioMeetsMinimum(netReward, netRisk, config.minimumNetRewardRiskBps)) {
    return Object.freeze({ status: "NOT_QUALIFIED", ...calculation, reason: "NET_RR_BELOW_MINIMUM" });
  }
  return Object.freeze({ status: "QUALIFIED", ...calculation });
}
