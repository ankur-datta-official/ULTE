import type { DecimalString } from "@ulte/instrument-model";
import { ULTE_MINIMUM_NET_RR_BPS } from "@ulte/risk-engine";
import { createIntentId } from "./internal/canonical-id.js";
import { compareDecimal } from "./internal/decimal.js";
import {
  TRADE_INTENT_SCHEMA_VERSION,
  type RejectedTradeIntentResult,
  type TradeIntentBlockingLayer,
  type TradeIntentDataRejectionReason,
  type TradeIntentInput,
  type TradeIntentResult,
  type TradeIntentUpstreamStatus,
  type UpstreamNotReadyTradeIntentResult,
} from "./types.js";

function upstreamReason(value: object): string | undefined {
  if ("reason" in value && typeof value.reason === "string") return value.reason;
  if ("upstreamReason" in value && typeof value.upstreamReason === "string") return value.upstreamReason;
  if ("structuralReason" in value && typeof value.structuralReason === "string") return value.structuralReason;
  if ("portfolioReason" in value && typeof value.portfolioReason === "string") return value.portfolioReason;
  return undefined;
}

function notReady(
  blockingLayer: TradeIntentBlockingLayer,
  upstreamStatus: TradeIntentUpstreamStatus,
  candidateId: string,
  upstream: object,
): UpstreamNotReadyTradeIntentResult {
  const reason = upstreamReason(upstream);
  return Object.freeze({
    status: "UPSTREAM_NOT_READY",
    blockingLayer,
    upstreamStatus,
    candidateId,
    ...(reason === undefined ? {} : { upstreamReason: reason }),
  });
}

function rejected(reason: TradeIntentDataRejectionReason, candidateId: string): RejectedTradeIntentResult {
  return Object.freeze({ status: "DATA_REJECTED", reason, candidateId });
}

function invalidRiskRatio(netRewardRiskBps: string, minimumRequiredNetRewardRiskBps: number): boolean {
  if (!/^(0|[1-9]\d*)$/.test(netRewardRiskBps)) return true;
  if (!Number.isSafeInteger(minimumRequiredNetRewardRiskBps)) return true;
  if (minimumRequiredNetRewardRiskBps < ULTE_MINIMUM_NET_RR_BPS) return true;
  return BigInt(netRewardRiskBps) < BigInt(minimumRequiredNetRewardRiskBps);
}

export function createTradeIntent(input: TradeIntentInput): TradeIntentResult {
  const { setupCandidate, structuralRiskResult, portfolioRiskResult, positionSizingResult } = input;

  if (setupCandidate.stage !== "CONFIRMED") {
    return notReady("SETUP", setupCandidate.stage, setupCandidate.id, setupCandidate);
  }
  if (structuralRiskResult.status !== "QUALIFIED") {
    return notReady("STRUCTURAL_RISK", structuralRiskResult.status, structuralRiskResult.candidateId, structuralRiskResult);
  }
  if (portfolioRiskResult.status !== "CAPITAL_ELIGIBLE") {
    return notReady("PORTFOLIO_RISK", portfolioRiskResult.status, portfolioRiskResult.candidateId, portfolioRiskResult);
  }
  if (positionSizingResult.status !== "SIZED") {
    return notReady("POSITION_SIZING", positionSizingResult.status, positionSizingResult.candidateId, positionSizingResult);
  }

  const candidateId = setupCandidate.id;
  if (
    setupCandidate.asOf !== structuralRiskResult.asOf
    || setupCandidate.asOf !== portfolioRiskResult.asOf
    || setupCandidate.asOf !== positionSizingResult.asOf
  ) return rejected("AS_OF_MISMATCH", candidateId);

  if (
    candidateId !== structuralRiskResult.candidateId
    || candidateId !== portfolioRiskResult.candidateId
    || candidateId !== positionSizingResult.candidateId
  ) return rejected("CANDIDATE_ID_MISMATCH", candidateId);

  if (
    setupCandidate.instrumentId !== structuralRiskResult.instrumentId
    || setupCandidate.instrumentId !== portfolioRiskResult.instrumentId
    || setupCandidate.instrumentId !== positionSizingResult.instrumentId
  ) return rejected("INSTRUMENT_MISMATCH", candidateId);

  if (setupCandidate.family !== structuralRiskResult.family) return rejected("FAMILY_MISMATCH", candidateId);
  if (setupCandidate.direction !== structuralRiskResult.direction) return rejected("DIRECTION_MISMATCH", candidateId);
  if (setupCandidate.setupTimeframe !== structuralRiskResult.setupTimeframe) {
    return rejected("SETUP_TIMEFRAME_MISMATCH", candidateId);
  }
  if (compareDecimal(positionSizingResult.approvedRiskAmount, portfolioRiskResult.requestedRiskAmount) !== 0) {
    return rejected("APPROVED_RISK_MISMATCH", candidateId);
  }
  if (positionSizingResult.accountCurrency !== portfolioRiskResult.baseCurrency) {
    return rejected("ACCOUNT_CURRENCY_MISMATCH", candidateId);
  }
  if (compareDecimal(positionSizingResult.actualRiskAmount, portfolioRiskResult.requestedRiskAmount) > 0) {
    return rejected("ACTUAL_RISK_EXCEEDS_APPROVED_RISK", candidateId);
  }
  if (compareDecimal(positionSizingResult.structuralNetRisk, structuralRiskResult.netRisk) !== 0) {
    return rejected("STRUCTURAL_NET_RISK_MISMATCH", candidateId);
  }
  if (invalidRiskRatio(
    structuralRiskResult.netRewardRiskBps,
    structuralRiskResult.minimumRequiredNetRewardRiskBps,
  )) return rejected("INVALID_STRUCTURAL_RISK_RESULT", candidateId);

  const entry = structuralRiskResult.entryReferencePrice as DecimalString;
  const invalidation = structuralRiskResult.invalidationPrice as DecimalString;
  const target = structuralRiskResult.primaryTargetPrice as DecimalString;
  const validPrices = setupCandidate.direction === "UP"
    ? compareDecimal(invalidation, entry) < 0 && compareDecimal(target, entry) > 0
    : compareDecimal(invalidation, entry) > 0 && compareDecimal(target, entry) < 0;
  if (!validPrices) return rejected("INVALID_PRICE_DIRECTION", candidateId);

  const intentId = createIntentId({
    candidateId,
    instrumentId: setupCandidate.instrumentId,
    asOf: setupCandidate.asOf,
    direction: setupCandidate.direction,
    entryReferencePrice: structuralRiskResult.entryReferencePrice,
    invalidationPrice: structuralRiskResult.invalidationPrice,
    primaryTargetPrice: structuralRiskResult.primaryTargetPrice,
    quantity: positionSizingResult.sizedQuantity,
    accountCurrency: positionSizingResult.accountCurrency,
  });

  return Object.freeze({
    status: "INTENT_READY",
    schemaVersion: TRADE_INTENT_SCHEMA_VERSION,
    intentId,
    candidateId,
    instrumentId: setupCandidate.instrumentId,
    asOf: setupCandidate.asOf,
    family: setupCandidate.family,
    direction: setupCandidate.direction,
    contextTimeframe: setupCandidate.contextTimeframe,
    setupTimeframe: setupCandidate.setupTimeframe,
    entryReferencePrice: structuralRiskResult.entryReferencePrice,
    invalidationPrice: structuralRiskResult.invalidationPrice,
    primaryTargetPrice: structuralRiskResult.primaryTargetPrice,
    quantityUnit: positionSizingResult.quantityUnit,
    quantity: positionSizingResult.sizedQuantity,
    quantityStep: positionSizingResult.quantityStep,
    accountCurrency: positionSizingResult.accountCurrency,
    pnlCurrency: positionSizingResult.pnlCurrency,
    conversionRate: positionSizingResult.conversionRate,
    approvedRiskAmount: positionSizingResult.approvedRiskAmount,
    actualRiskAmount: positionSizingResult.actualRiskAmount,
    unusedRiskAmount: positionSizingResult.unusedRiskAmount,
    riskUtilizationBps: positionSizingResult.riskUtilizationBps,
    structuralNetRisk: positionSizingResult.structuralNetRisk,
    netRewardRiskBps: structuralRiskResult.netRewardRiskBps,
    minimumRequiredNetRewardRiskBps: structuralRiskResult.minimumRequiredNetRewardRiskBps,
    pnlValuePerPriceUnitPerQuantity: positionSizingResult.pnlValuePerPriceUnitPerQuantity,
    riskPerQuantityUnitInAccountCurrency: positionSizingResult.riskPerQuantityUnitInAccountCurrency,
    riskPerQuantityStep: positionSizingResult.riskPerQuantityStep,
    cappedByMaximumQuantity: positionSizingResult.cappedByMaximumQuantity,
  });
}
