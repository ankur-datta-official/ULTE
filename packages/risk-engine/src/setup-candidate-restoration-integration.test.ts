import { expect, it } from "vitest";
import { createInstrumentId } from "@ulte/instrument-model";
import {
  FINALIZED_CANDLE_RECOVERY_EVIDENCE_SCHEMA_VERSION,
  type FinalizedCandleRecoveryEvidenceV1,
} from "@ulte/market-data";
import {
  SETUP_ANALYSIS_IMPLEMENTATION,
  SETUP_CANDIDATE_RECOVERY_EVIDENCE_SCHEMA_VERSION,
  restoreSetupCandidateFromAnalysisEvidence,
} from "@ulte/setup-engine";
import {
  ULTE_MINIMUM_NET_RR_BPS,
  createRiskCostAssumptions,
  createRiskQualificationConfig,
  qualifyStructuralRisk,
} from "./index.js";

const instrumentId = createInstrumentId({ venue: "TEST", venueSymbol: "FORWARD", instrumentKind: "SPOT" });
const source = "PRE0B_FORWARD_TEST";
const regimeConfig = Object.freeze({
  trendLookback: 5,
  baselineVolatilityBars: 3,
  recentVolatilityBars: 2,
  trendEfficiencyMinBps: 7_000,
  trendConsistencyMinBps: 7_000,
  rangeEfficiencyMaxBps: 2_500,
  rangeConsistencyMaxBps: 6_000,
  compressionRatioMaxBps: 5_000,
  expansionRatioMinBps: 15_000,
});
const structureConfig = Object.freeze({ lookbackBars: 5, pivotLeftBars: 1, pivotRightBars: 1 });
const setupConfig = Object.freeze({
  continuationAllowedRegimes: Object.freeze(["TREND_UP"] as const),
  breakoutAllowedRegimes: Object.freeze([]),
  reversalAllowedRegimes: Object.freeze([]),
});

function trade(time: number, price: string, id: string) {
  return Object.freeze({
    eventIdentity: id,
    instrumentId,
    source,
    eventTime: time,
    receivedAt: time,
    price,
    quantity: "1",
    side: "UNKNOWN" as const,
    quality: Object.freeze(["LIVE"] as const),
  });
}

function candle(input: {
  readonly timeframe: string;
  readonly duration: number;
  readonly openTime: number;
  readonly open: string;
  readonly high: string;
  readonly low: string;
  readonly close: string;
  readonly id: string;
}): FinalizedCandleRecoveryEvidenceV1 {
  const closeTime = input.openTime + input.duration;
  return Object.freeze({
    schemaVersion: FINALIZED_CANDLE_RECOVERY_EVIDENCE_SCHEMA_VERSION,
    config: Object.freeze({ instrumentId, source, timeframe: input.timeframe, anchorTime: 0 }),
    target: Object.freeze({ openTime: input.openTime, closeTime }),
    previousAcceptedTrade: trade(input.openTime - 1, input.open, `${input.id}:previous`),
    targetAcceptedTrades: Object.freeze([
      trade(input.openTime, input.open, `${input.id}:open`),
      trade(input.openTime + 1, input.high, `${input.id}:high`),
      trade(input.openTime + 2, input.low, `${input.id}:low`),
      trade(closeTime - 1, input.close, `${input.id}:close`),
    ]),
    finalizationWitness: trade(closeTime, input.close, `${input.id}:witness`),
  });
}

it("passes the exact restored setup candidate into normal structural risk qualification", () => {
  const contextEvidence = ["10", "11", "12", "13", "14", "15"].map((close, index) => candle({
    timeframe: "5m",
    duration: 300_000,
    openTime: (index + 1) * 300_000,
    open: close,
    high: String(Number(close) + 1),
    low: String(Number(close) - 1),
    close,
    id: `context:${index}`,
  }));
  const setupEvidence = [
    { open: "5", high: "6", low: "5", close: "5" },
    { open: "2", high: "7", low: "2", close: "2" },
    { open: "5", high: "6", low: "5", close: "5" },
    { open: "2", high: "7", low: "1", close: "2" },
    { open: "8", high: "8", low: "4", close: "8" },
  ].map((value, index) => candle({
    timeframe: "1m",
    duration: 60_000,
    openTime: (index + 1) * 60_000,
    ...value,
    id: `setup:${index}`,
  }));
  const restored = restoreSetupCandidateFromAnalysisEvidence({
    schemaVersion: SETUP_CANDIDATE_RECOVERY_EVIDENCE_SCHEMA_VERSION,
    analysisImplementation: SETUP_ANALYSIS_IMPLEMENTATION,
    analysisAsOf: 2_100_000,
    contextCandles: contextEvidence,
    setupCandles: setupEvidence,
    regimeConfig,
    structureConfig,
    setupConfig,
    expectedCandidate: {
      id: "TREND_PULLBACK_CONTINUATION:UP:300000:LOW:120000",
      family: "TREND_PULLBACK_CONTINUATION",
      direction: "UP",
      stage: "CONFIRMED",
      instrumentId,
      contextTimeframe: "5m",
      setupTimeframe: "1m",
      asOf: 2_100_000,
      initiatedAt: 300_000,
      confirmedAt: 360_000,
    },
  });
  expect(restored.status).toBe("SETUP_CANDIDATE_RESTORED");
  if (restored.status !== "SETUP_CANDIDATE_RESTORED") throw new Error(restored.reason);
  expect(restored.candidate).toBe(restored.setupEvaluation.candidates[0]);

  const risk = qualifyStructuralRisk({
    candidate: restored.candidate,
    structure: restored.setupStructure,
    setupCandles: restored.setupCandles,
    costs: createRiskCostAssumptions({ entryCostBps: 0, targetExitCostBps: 0, stopExitCostBps: 0 }),
    config: createRiskQualificationConfig({ minimumNetRewardRiskBps: ULTE_MINIMUM_NET_RR_BPS }),
  });
  expect(risk).toMatchObject({
    candidateId: restored.candidate.id,
    family: restored.candidate.family,
    direction: restored.candidate.direction,
    instrumentId: restored.candidate.instrumentId,
    setupTimeframe: restored.candidate.setupTimeframe,
    asOf: restored.candidate.asOf,
  });
  expect(risk.status).not.toBe("DATA_REJECTED");
});
