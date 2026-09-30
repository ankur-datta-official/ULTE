import { createInstrumentId } from "../../packages/instrument-model/src/index.js";
import {
  FINALIZED_CANDLE_RECOVERY_EVIDENCE_SCHEMA_VERSION,
  restoreFinalizedCandleSnapshot,
  type FinalizedCandleRecoveryEvidenceV1,
} from "../../packages/market-data/src/index.js";
import {
  createAccountRiskSnapshot,
  createPortfolioRiskConfig,
  evaluatePortfolioRisk,
} from "../../packages/portfolio-risk-engine/src/index.js";
import { createLinearInstrumentSizingSpec, sizePosition } from "../../packages/position-sizing-engine/src/index.js";
import { classifyMarketRegime, createRegimeConfig } from "../../packages/regime-engine/src/index.js";
import {
  ULTE_MINIMUM_NET_RR_BPS,
  createRiskCostAssumptions,
  createRiskQualificationConfig,
  qualifyStructuralRisk,
} from "../../packages/risk-engine/src/index.js";
import {
  SETUP_ANALYSIS_IMPLEMENTATION,
  SETUP_CANDIDATE_RECOVERY_EVIDENCE_SCHEMA_VERSION,
  createPositionSetupConfig,
  evaluatePositionSetups,
  type SetupCandidate,
  type SetupCandidateRecoveryEvidenceV1,
} from "../../packages/setup-engine/src/index.js";
import { analyzeMarketStructure, createStructureConfig } from "../../packages/structure-engine/src/index.js";
import {
  READY_TRADE_INTENT_RECOVERY_EVIDENCE_SCHEMA_VERSION,
  createTradeIntent,
  type ReadyTradeIntent,
  type ReadyTradeIntentRecoveryEvidenceV1,
  type ReadyTradeIntentRecoverySelectorV1,
} from "../../packages/trade-intent-engine/src/index.js";
export const PHASE33A_INSTRUMENT = createInstrumentId({
  venue: "TEST", venueSymbol: "PRE2", instrumentKind: "SPOT",
});
export const PHASE33A_AS_OF = 2_100_000;
export const PHASE33A_EXECUTION_AS_OF = PHASE33A_AS_OF + 100;
const SOURCE = "PHASE33A_TEST";

const REGIME_CONFIG = Object.freeze({
  trendLookback: 5, baselineVolatilityBars: 3, recentVolatilityBars: 2,
  trendEfficiencyMinBps: 7_000, trendConsistencyMinBps: 7_000,
  rangeEfficiencyMaxBps: 2_500, rangeConsistencyMaxBps: 6_000,
  compressionRatioMaxBps: 5_000, expansionRatioMinBps: 15_000,
});
const STRUCTURE_CONFIG = Object.freeze({ lookbackBars: 7, pivotLeftBars: 1, pivotRightBars: 1 });
const SETUP_CONFIG = Object.freeze({
  continuationAllowedRegimes: Object.freeze(["TREND_UP"] as const),
  breakoutAllowedRegimes: Object.freeze([]),
  reversalAllowedRegimes: Object.freeze([]),
});
const RISK_COSTS = Object.freeze({ entryCostBps: 0, targetExitCostBps: 0, stopExitCostBps: 0 });
const RISK_CONFIG = Object.freeze({ minimumNetRewardRiskBps: ULTE_MINIMUM_NET_RR_BPS });
const ACCOUNT = Object.freeze({
  asOf: PHASE33A_AS_OF, baseCurrency: "USD", currentEquity: "10000", dayStartEquity: "10000",
  openPositions: Object.freeze([]),
});
const PORTFOLIO_CONFIG = Object.freeze({
  maxRiskPerTradeBps: 200, maxTotalOpenRiskBps: 500, maxConcurrentPositions: 5,
  maxDailyLossBps: 500,
  riskGroupLimits: Object.freeze([Object.freeze({ groupId: "swing", maxRiskBps: 400 })]),
});
const SIZING_SPEC = Object.freeze({
  valuationModel: "LINEAR_PRICE_PNL", instrumentId: PHASE33A_INSTRUMENT, pnlCurrency: "USD",
  quantityUnit: "unit", quantityStep: "1", minimumQuantity: "1", maximumQuantity: "100",
  pnlValuePerPriceUnitPerQuantity: "1",
});

export interface Phase33aPriceFixture {
  readonly entry?: string;
  readonly invalidation?: string;
  readonly target?: string;
}

function trade(time: number, price: string, id: string) {
  return Object.freeze({
    eventIdentity: id, instrumentId: PHASE33A_INSTRUMENT, source: SOURCE,
    eventTime: time, receivedAt: time, price, quantity: "1", side: "UNKNOWN" as const,
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
    config: Object.freeze({
      instrumentId: PHASE33A_INSTRUMENT, source: SOURCE, timeframe: input.timeframe, anchorTime: 0,
    }),
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

function contextEvidence(): readonly FinalizedCandleRecoveryEvidenceV1[] {
  return Object.freeze(["10", "11", "12", "13", "14", "15"].map((close, index) => candle({
    timeframe: "5m", duration: 300_000, openTime: (index + 1) * 300_000, open: close,
    high: String(Number(close) + 1), low: String(Number(close) - 1), close, id: `context:${index}`,
  })));
}

function setupCandleEvidence(prices: Phase33aPriceFixture = {}): readonly FinalizedCandleRecoveryEvidenceV1[] {
  const entry = prices.entry ?? "13";
  const invalidation = prices.invalidation ?? "7";
  const target = prices.target ?? "50";
  const values = [
    { open: "9", high: "10", low: "9", close: "9" },
    { open: "20", high: target, low: "20", close: "20" },
    { open: "9", high: "10", low: "9", close: "9" },
    { open: "8", high: "12", low: "8", close: "8" },
    { open: "9", high: "10", low: "9", close: "9" },
    { open: "8", high: "12", low: invalidation, close: "8" },
    { open: "13", high: entry, low: "9", close: entry },
  ];
  return Object.freeze(values.map((value, index) => candle({
    timeframe: "1m", duration: 60_000, openTime: (index + 1) * 60_000,
    ...value, id: `setup:${index}`,
  })));
}

function restoreCandles(evidence: readonly FinalizedCandleRecoveryEvidenceV1[]) {
  return evidence.map((item) => {
    const result = restoreFinalizedCandleSnapshot(item);
    if (result.status !== "FINALIZED_CANDLE_SNAPSHOT_RESTORED") throw new Error(result.reason);
    return result.snapshot;
  });
}

function candidateSelector(candidate: SetupCandidate): SetupCandidateRecoveryEvidenceV1["expectedCandidate"] {
  return Object.freeze({
    id: candidate.id, family: candidate.family, direction: candidate.direction, stage: candidate.stage,
    instrumentId: candidate.instrumentId, contextTimeframe: candidate.contextTimeframe,
    setupTimeframe: candidate.setupTimeframe, asOf: candidate.asOf, initiatedAt: candidate.initiatedAt,
    ...(candidate.confirmedAt === undefined ? {} : { confirmedAt: candidate.confirmedAt }),
  });
}

function normalSetup(prices: Phase33aPriceFixture = {}) {
  const contextCandles = restoreCandles(contextEvidence());
  const setupCandles = restoreCandles(setupCandleEvidence(prices));
  const contextRegime = classifyMarketRegime(contextCandles, createRegimeConfig(REGIME_CONFIG));
  const setupStructure = analyzeMarketStructure(setupCandles, createStructureConfig(STRUCTURE_CONFIG));
  const setupEvaluation = evaluatePositionSetups({
    asOf: PHASE33A_AS_OF, contextRegime, setupStructure, setupCandles,
  }, createPositionSetupConfig(SETUP_CONFIG));
  if (setupEvaluation.status !== "READY") throw new Error(setupEvaluation.reason);
  const candidate = setupEvaluation.candidates.find((item) => item.stage === "CONFIRMED");
  if (candidate === undefined) throw new Error("Fixture did not produce a confirmed candidate");
  return { contextCandles, setupCandles, contextRegime, setupStructure, setupEvaluation, candidate };
}

function setupRecoveryEvidence(prices: Phase33aPriceFixture): SetupCandidateRecoveryEvidenceV1 {
  const normal = normalSetup(prices);
  return Object.freeze({
    schemaVersion: SETUP_CANDIDATE_RECOVERY_EVIDENCE_SCHEMA_VERSION,
    analysisImplementation: SETUP_ANALYSIS_IMPLEMENTATION,
    analysisAsOf: PHASE33A_AS_OF,
    contextCandles: contextEvidence(), setupCandles: setupCandleEvidence(prices),
    regimeConfig: REGIME_CONFIG, structureConfig: STRUCTURE_CONFIG, setupConfig: SETUP_CONFIG,
    expectedCandidate: candidateSelector(normal.candidate),
  });
}

function expectedIntent(intent: ReadyTradeIntent): ReadyTradeIntentRecoverySelectorV1 {
  const {
    intentId, candidateId, instrumentId, asOf, family, direction, contextTimeframe,
    setupTimeframe, entryReferencePrice, invalidationPrice, primaryTargetPrice,
    quantityUnit, quantity, quantityStep, accountCurrency, pnlCurrency, conversionRate,
    approvedRiskAmount, actualRiskAmount, unusedRiskAmount, riskUtilizationBps,
    structuralNetRisk, netRewardRiskBps, minimumRequiredNetRewardRiskBps,
    pnlValuePerPriceUnitPerQuantity, riskPerQuantityUnitInAccountCurrency,
    riskPerQuantityStep, cappedByMaximumQuantity,
  } = intent;
  return Object.freeze({
    intentId, candidateId, instrumentId, asOf, family, direction, contextTimeframe,
    setupTimeframe, entryReferencePrice, invalidationPrice, primaryTargetPrice,
    quantityUnit, quantity, quantityStep, accountCurrency, pnlCurrency, conversionRate,
    approvedRiskAmount, actualRiskAmount, unusedRiskAmount, riskUtilizationBps,
    structuralNetRisk, netRewardRiskBps, minimumRequiredNetRewardRiskBps,
    pnlValuePerPriceUnitPerQuantity, riskPerQuantityUnitInAccountCurrency,
    riskPerQuantityStep, cappedByMaximumQuantity,
  });
}

function normalTradeIntent(requestedRiskAmount: string, prices: Phase33aPriceFixture) {
  const setup = normalSetup(prices);
  const riskQualification = qualifyStructuralRisk({
    candidate: setup.candidate, structure: setup.setupStructure, setupCandles: setup.setupCandles,
    costs: createRiskCostAssumptions(RISK_COSTS), config: createRiskQualificationConfig(RISK_CONFIG),
  });
  if (riskQualification.status !== "QUALIFIED") throw new Error(riskQualification.reason);
  const portfolioRisk = evaluatePortfolioRisk({
    structuralRiskResult: riskQualification, account: createAccountRiskSnapshot(ACCOUNT),
    requestedRiskAmount, proposedRiskGroupIds: ["swing"],
    config: createPortfolioRiskConfig(PORTFOLIO_CONFIG),
  });
  if (portfolioRisk.status !== "CAPITAL_ELIGIBLE") throw new Error(portfolioRisk.status);
  const sizing = sizePosition({
    structuralRiskResult: riskQualification, portfolioRiskResult: portfolioRisk,
    instrumentSpec: createLinearInstrumentSizingSpec(SIZING_SPEC),
  });
  if (sizing.status !== "SIZED") throw new Error(sizing.status);
  const tradeIntent = createTradeIntent({
    setupCandidate: setup.candidate, structuralRiskResult: riskQualification,
    portfolioRiskResult: portfolioRisk, positionSizingResult: sizing,
  });
  if (tradeIntent.status !== "INTENT_READY") throw new Error(tradeIntent.status);
  return { setup, riskQualification, portfolioRisk, sizing, tradeIntent };
}

function tradeIntentEvidence(
  tradeIntent: ReadyTradeIntent,
  requestedRiskAmount: string,
  prices: Phase33aPriceFixture,
): ReadyTradeIntentRecoveryEvidenceV1 {
  return Object.freeze({
    schemaVersion: READY_TRADE_INTENT_RECOVERY_EVIDENCE_SCHEMA_VERSION,
    setupCandidateEvidence: setupRecoveryEvidence(prices),
    structuralRisk: Object.freeze({ costs: RISK_COSTS, config: RISK_CONFIG }),
    portfolioRisk: Object.freeze({
      account: ACCOUNT, requestedRiskAmount, proposedRiskGroupIds: Object.freeze(["swing"]),
      config: PORTFOLIO_CONFIG,
    }),
    positionSizing: Object.freeze({ instrumentSpec: SIZING_SPEC }),
    expectedIntent: expectedIntent(tradeIntent),
  });
}

export function createReadyTradeIntentRecoveryFixture(
  requestedRiskAmount = "100",
  prices: Phase33aPriceFixture = {},
): Readonly<{
  readonly tradeIntent: ReadyTradeIntent;
  readonly recoveryEvidence: ReadyTradeIntentRecoveryEvidenceV1;
}> {
  const normal = normalTradeIntent(requestedRiskAmount, prices);
  return Object.freeze({
    tradeIntent: normal.tradeIntent,
    recoveryEvidence: tradeIntentEvidence(normal.tradeIntent, requestedRiskAmount, prices),
  });
}
