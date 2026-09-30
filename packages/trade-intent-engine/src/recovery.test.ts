import { describe, expect, it } from "vitest";
import { createInstrumentId } from "@ulte/instrument-model";
import {
  FINALIZED_CANDLE_RECOVERY_EVIDENCE_SCHEMA_VERSION,
  restoreFinalizedCandleSnapshot,
  type FinalizedCandleRecoveryEvidenceV1,
} from "@ulte/market-data";
import {
  createAccountRiskSnapshot,
  createPortfolioRiskConfig,
  evaluatePortfolioRisk,
} from "@ulte/portfolio-risk-engine";
import {
  createLinearInstrumentSizingSpec,
  sizePosition,
} from "@ulte/position-sizing-engine";
import { classifyMarketRegime, createRegimeConfig } from "@ulte/regime-engine";
import {
  ULTE_MINIMUM_NET_RR_BPS,
  createRiskCostAssumptions,
  createRiskQualificationConfig,
  qualifyStructuralRisk,
} from "@ulte/risk-engine";
import {
  SETUP_ANALYSIS_IMPLEMENTATION,
  SETUP_CANDIDATE_RECOVERY_EVIDENCE_SCHEMA_VERSION,
  createPositionSetupConfig,
  evaluatePositionSetups,
  restoreSetupCandidateFromAnalysisEvidence,
  type SetupCandidate,
  type SetupCandidateRecoveryEvidenceV1,
} from "@ulte/setup-engine";
import { analyzeMarketStructure, createStructureConfig } from "@ulte/structure-engine";
import {
  READY_TRADE_INTENT_RECOVERY_EVIDENCE_SCHEMA_VERSION,
  createTradeIntent,
  restoreReadyTradeIntent,
  type ReadyTradeIntent,
  type ReadyTradeIntentRecoveryEvidenceV1,
  type ReadyTradeIntentRecoverySelectorV1,
} from "./index.js";

const INSTRUMENT = createInstrumentId({ venue: "TEST", venueSymbol: "PRE1", instrumentKind: "SPOT" });
const OTHER_INSTRUMENT = createInstrumentId({ venue: "TEST", venueSymbol: "OTHER", instrumentKind: "SPOT" });
const SOURCE = "PRE1_TEST";
const AS_OF = 2_100_000;

const REGIME_CONFIG = Object.freeze({
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
const STRUCTURE_CONFIG = Object.freeze({ lookbackBars: 7, pivotLeftBars: 1, pivotRightBars: 1 });
const SETUP_CONFIG = Object.freeze({
  continuationAllowedRegimes: Object.freeze(["TREND_UP"] as const),
  breakoutAllowedRegimes: Object.freeze([]),
  reversalAllowedRegimes: Object.freeze([]),
});
const RISK_COSTS = Object.freeze({ entryCostBps: 0, targetExitCostBps: 0, stopExitCostBps: 0 });
const RISK_CONFIG = Object.freeze({ minimumNetRewardRiskBps: ULTE_MINIMUM_NET_RR_BPS });
const ACCOUNT = Object.freeze({
  asOf: AS_OF,
  baseCurrency: "USD",
  currentEquity: "10000",
  dayStartEquity: "10000",
  openPositions: Object.freeze([]),
});
const PORTFOLIO_CONFIG = Object.freeze({
  maxRiskPerTradeBps: 200,
  maxTotalOpenRiskBps: 500,
  maxConcurrentPositions: 5,
  maxDailyLossBps: 500,
  riskGroupLimits: Object.freeze([Object.freeze({ groupId: "swing", maxRiskBps: 400 })]),
});
const SIZING_SPEC = Object.freeze({
  valuationModel: "LINEAR_PRICE_PNL",
  instrumentId: INSTRUMENT,
  pnlCurrency: "USD",
  quantityUnit: "unit",
  quantityStep: "1",
  minimumQuantity: "1",
  maximumQuantity: "100",
  pnlValuePerPriceUnitPerQuantity: "1",
});

function trade(time: number, price: string, id: string) {
  return Object.freeze({
    eventIdentity: id,
    instrumentId: INSTRUMENT,
    source: SOURCE,
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
    config: Object.freeze({ instrumentId: INSTRUMENT, source: SOURCE, timeframe: input.timeframe, anchorTime: 0 }),
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
    timeframe: "5m",
    duration: 300_000,
    openTime: (index + 1) * 300_000,
    open: close,
    high: String(Number(close) + 1),
    low: String(Number(close) - 1),
    close,
    id: `context:${index}`,
  })));
}

function setupCandleEvidence(): readonly FinalizedCandleRecoveryEvidenceV1[] {
  const values = [
    { open: "9", high: "10", low: "9", close: "9" },
    { open: "20", high: "50", low: "20", close: "20" },
    { open: "9", high: "10", low: "9", close: "9" },
    { open: "8", high: "12", low: "8", close: "8" },
    { open: "9", high: "10", low: "9", close: "9" },
    { open: "8", high: "12", low: "7", close: "8" },
    { open: "13", high: "13", low: "9", close: "13" },
  ];
  return Object.freeze(values.map((value, index) => candle({
    timeframe: "1m",
    duration: 60_000,
    openTime: (index + 1) * 60_000,
    ...value,
    id: `setup:${index}`,
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
    id: candidate.id,
    family: candidate.family,
    direction: candidate.direction,
    stage: candidate.stage,
    instrumentId: candidate.instrumentId,
    contextTimeframe: candidate.contextTimeframe,
    setupTimeframe: candidate.setupTimeframe,
    asOf: candidate.asOf,
    initiatedAt: candidate.initiatedAt,
    ...(candidate.confirmedAt === undefined ? {} : { confirmedAt: candidate.confirmedAt }),
  });
}

function normalSetup() {
  const contextCandles = restoreCandles(contextEvidence());
  const setupCandles = restoreCandles(setupCandleEvidence());
  const contextRegime = classifyMarketRegime(contextCandles, createRegimeConfig(REGIME_CONFIG));
  const setupStructure = analyzeMarketStructure(setupCandles, createStructureConfig(STRUCTURE_CONFIG));
  const setupEvaluation = evaluatePositionSetups({
    asOf: AS_OF,
    contextRegime,
    setupStructure,
    setupCandles,
  }, createPositionSetupConfig(SETUP_CONFIG));
  if (setupEvaluation.status !== "READY") throw new Error(setupEvaluation.reason);
  const candidate = setupEvaluation.candidates.find((item) => item.stage === "CONFIRMED");
  if (candidate === undefined) throw new Error("Fixture did not produce a confirmed candidate");
  return { contextCandles, setupCandles, contextRegime, setupStructure, setupEvaluation, candidate };
}

function setupRecoveryEvidence(): SetupCandidateRecoveryEvidenceV1 {
  const normal = normalSetup();
  return Object.freeze({
    schemaVersion: SETUP_CANDIDATE_RECOVERY_EVIDENCE_SCHEMA_VERSION,
    analysisImplementation: SETUP_ANALYSIS_IMPLEMENTATION,
    analysisAsOf: AS_OF,
    contextCandles: contextEvidence(),
    setupCandles: setupCandleEvidence(),
    regimeConfig: REGIME_CONFIG,
    structureConfig: STRUCTURE_CONFIG,
    setupConfig: SETUP_CONFIG,
    expectedCandidate: candidateSelector(normal.candidate),
  });
}

function normalChain() {
  const setup = normalSetup();
  const riskQualification = qualifyStructuralRisk({
    candidate: setup.candidate,
    structure: setup.setupStructure,
    setupCandles: setup.setupCandles,
    costs: createRiskCostAssumptions(RISK_COSTS),
    config: createRiskQualificationConfig(RISK_CONFIG),
  });
  if (riskQualification.status !== "QUALIFIED") {
    throw new Error(`Fixture risk is ${riskQualification.status}:${riskQualification.reason}`);
  }
  const portfolioRisk = evaluatePortfolioRisk({
    structuralRiskResult: riskQualification,
    account: createAccountRiskSnapshot(ACCOUNT),
    requestedRiskAmount: "100",
    proposedRiskGroupIds: ["swing"],
    config: createPortfolioRiskConfig(PORTFOLIO_CONFIG),
  });
  if (portfolioRisk.status !== "CAPITAL_ELIGIBLE") throw new Error(`Fixture portfolio is ${portfolioRisk.status}`);
  const sizing = sizePosition({
    structuralRiskResult: riskQualification,
    portfolioRiskResult: portfolioRisk,
    instrumentSpec: createLinearInstrumentSizingSpec(SIZING_SPEC),
  });
  if (sizing.status !== "SIZED") throw new Error(`Fixture sizing is ${sizing.status}`);
  const tradeIntent = createTradeIntent({
    setupCandidate: setup.candidate,
    structuralRiskResult: riskQualification,
    portfolioRiskResult: portfolioRisk,
    positionSizingResult: sizing,
  });
  if (tradeIntent.status !== "INTENT_READY") throw new Error(`Fixture intent is ${tradeIntent.status}`);
  return { setup, riskQualification, portfolioRisk, sizing, tradeIntent };
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

function fixture(): ReadyTradeIntentRecoveryEvidenceV1 {
  const normal = normalChain();
  return Object.freeze({
    schemaVersion: READY_TRADE_INTENT_RECOVERY_EVIDENCE_SCHEMA_VERSION,
    setupCandidateEvidence: setupRecoveryEvidence(),
    structuralRisk: Object.freeze({ costs: RISK_COSTS, config: RISK_CONFIG }),
    portfolioRisk: Object.freeze({
      account: ACCOUNT,
      requestedRiskAmount: "100",
      proposedRiskGroupIds: Object.freeze(["swing"]),
      config: PORTFOLIO_CONFIG,
    }),
    positionSizing: Object.freeze({ instrumentSpec: SIZING_SPEC }),
    expectedIntent: expectedIntent(normal.tradeIntent),
  });
}

function mutableEvidence(): Record<string, any> {
  return structuredClone(fixture());
}

function restored() {
  const result = restoreReadyTradeIntent(fixture());
  expect(result.status).toBe("READY_TRADE_INTENT_RESTORED");
  if (result.status !== "READY_TRADE_INTENT_RESTORED") throw new Error(result.reason);
  return result;
}

describe("authoritative ready trade intent restoration", () => {
  it("restores a canonical ReadyTradeIntent", () => {
    expect(restored().tradeIntent.status).toBe("INTENT_READY");
  });

  it("rejects compensated sparse proposed risk groups at the structural boundary", () => {
    const evidence = mutableEvidence();
    const proposedRiskGroupIds = new Array<string>(1);
    (proposedRiskGroupIds as any).extra = "compensating-key";
    evidence.portfolioRisk.proposedRiskGroupIds = proposedRiskGroupIds;

    expect(() => restoreReadyTradeIntent(evidence)).not.toThrow();
    expect(restoreReadyTradeIntent(evidence)).toMatchObject({
      status: "READY_TRADE_INTENT_RESTORATION_REJECTED",
      reason: "INVALID_RECOVERY_EVIDENCE",
    });
  });

  it("obtains setup authority only through PRE0B and retains its candidate reference", () => {
    const result = restored();
    expect(result.setupAuthority.status).toBe("SETUP_CANDIDATE_RESTORED");
    expect(result.setupAuthority.setupEvaluation.candidates).toContain(result.setupAuthority.candidate);
  });

  it("retains the normal QUALIFIED structural-risk authority", () => {
    const result = restored();
    const replay = qualifyStructuralRisk({
      candidate: result.setupAuthority.candidate,
      structure: result.setupAuthority.setupStructure,
      setupCandles: result.setupAuthority.setupCandles,
      costs: createRiskCostAssumptions(RISK_COSTS),
      config: createRiskQualificationConfig(RISK_CONFIG),
    });
    expect(result.riskQualification).toEqual(replay);
  });

  it("retains normal CAPITAL_ELIGIBLE portfolio authority", () => {
    expect(restored().portfolioRisk.status).toBe("CAPITAL_ELIGIBLE");
  });

  it("retains normal SIZED position authority", () => {
    expect(restored().sizing.status).toBe("SIZED");
  });

  it("returns the unmodified frozen createTradeIntent result in the success graph", () => {
    const result = restored();
    expect(Object.isFrozen(result.tradeIntent)).toBe(true);
    expect(result.tradeIntent).toEqual(createTradeIntent({
      setupCandidate: result.setupAuthority.candidate,
      structuralRiskResult: result.riskQualification,
      portfolioRiskResult: result.portfolioRisk,
      positionSizingResult: result.sizing,
    }));
  });

  it("freezes the restoration wrapper", () => {
    expect(Object.isFrozen(restored())).toBe(true);
  });

  it("rejects an unsupported recovery schema", () => {
    const evidence = mutableEvidence();
    evidence.schemaVersion = "READY_TRADE_INTENT_RECOVERY_EVIDENCE_V2";
    expect(restoreReadyTradeIntent(evidence)).toMatchObject({ reason: "UNSUPPORTED_RECOVERY_SCHEMA" });
  });

  it.each([null, {}, { schemaVersion: READY_TRADE_INTENT_RECOVERY_EVIDENCE_SCHEMA_VERSION }])(
    "rejects malformed plain evidence %#",
    (evidence) => expect(restoreReadyTradeIntent(evidence)).toMatchObject({ reason: "INVALID_RECOVERY_EVIDENCE" }),
  );

  it("propagates setup restoration rejection without bypassing PRE0B", () => {
    const evidence = mutableEvidence();
    evidence.setupCandidateEvidence.expectedCandidate.id = "missing";
    expect(restoreReadyTradeIntent(evidence)).toMatchObject({
      reason: "SETUP_RESTORATION_REJECTED",
      upstreamStatus: "SETUP_CANDIDATE_RESTORATION_REJECTED",
      upstreamReason: "EXPECTED_CANDIDATE_NOT_FOUND",
    });
  });

  it("rejects invalid risk costs through the normal constructor", () => {
    const evidence = mutableEvidence();
    evidence.structuralRisk.costs.entryCostBps = -1;
    expect(restoreReadyTradeIntent(evidence)).toMatchObject({ reason: "INVALID_RISK_COSTS" });
  });

  it("rejects invalid risk config through the normal constructor", () => {
    const evidence = mutableEvidence();
    evidence.structuralRisk.config.minimumNetRewardRiskBps = 29_999;
    expect(restoreReadyTradeIntent(evidence)).toMatchObject({ reason: "INVALID_RISK_CONFIG" });
  });

  it("fails closed when normal risk authority is not qualified", () => {
    const evidence = mutableEvidence();
    evidence.structuralRisk.costs.entryCostBps = 5_000;
    expect(restoreReadyTradeIntent(evidence)).toMatchObject({ reason: "RISK_NOT_QUALIFIED", upstreamStatus: "NOT_QUALIFIED" });
  });

  it("rejects an invalid historical account through its constructor", () => {
    const evidence = mutableEvidence();
    evidence.portfolioRisk.account.currentEquity = "bad";
    expect(restoreReadyTradeIntent(evidence)).toMatchObject({ reason: "INVALID_PORTFOLIO_ACCOUNT" });
  });

  it("rejects invalid portfolio config through its constructor", () => {
    const evidence = mutableEvidence();
    evidence.portfolioRisk.config.maxRiskPerTradeBps = 600;
    evidence.portfolioRisk.config.maxTotalOpenRiskBps = 500;
    expect(restoreReadyTradeIntent(evidence)).toMatchObject({ reason: "INVALID_PORTFOLIO_CONFIG" });
  });

  it("retains a normal portfolio data rejection", () => {
    const evidence = mutableEvidence();
    evidence.portfolioRisk.requestedRiskAmount = "bad";
    expect(restoreReadyTradeIntent(evidence)).toMatchObject({
      reason: "PORTFOLIO_NOT_CAPITAL_ELIGIBLE", upstreamStatus: "DATA_REJECTED",
      upstreamReason: "INVALID_REQUESTED_RISK",
    });
  });

  it("fails closed when portfolio authority blocks capital", () => {
    const evidence = mutableEvidence();
    evidence.portfolioRisk.requestedRiskAmount = "300";
    expect(restoreReadyTradeIntent(evidence)).toMatchObject({
      reason: "PORTFOLIO_NOT_CAPITAL_ELIGIBLE", upstreamStatus: "BLOCKED",
    });
  });

  it("rejects invalid sizing specification through its constructor", () => {
    const evidence = mutableEvidence();
    evidence.positionSizing.instrumentSpec.minimumQuantity = "1.5";
    expect(restoreReadyTradeIntent(evidence)).toMatchObject({ reason: "INVALID_SIZING_SPEC" });
  });

  it("rejects an invalid supplied FX snapshot through its constructor", () => {
    const evidence = mutableEvidence();
    evidence.positionSizing.fxConversion = { asOf: AS_OF, fromCurrency: "USD", toCurrency: "USD", rate: "0" };
    expect(restoreReadyTradeIntent(evidence)).toMatchObject({ reason: "INVALID_FX_CONVERSION" });
  });

  it("retains a normal sizing data rejection", () => {
    const evidence = mutableEvidence();
    evidence.positionSizing.instrumentSpec.instrumentId = OTHER_INSTRUMENT;
    expect(restoreReadyTradeIntent(evidence)).toMatchObject({
      reason: "POSITION_NOT_SIZED", upstreamStatus: "DATA_REJECTED",
      upstreamReason: "INSTRUMENT_SPEC_MISMATCH",
    });
  });

  it("fails closed when the risk budget cannot size the minimum quantity", () => {
    const evidence = mutableEvidence();
    evidence.positionSizing.instrumentSpec.minimumQuantity = "20";
    expect(restoreReadyTradeIntent(evidence)).toMatchObject({
      reason: "POSITION_NOT_SIZED", upstreamStatus: "NOT_SIZEABLE",
    });
  });

  it.each([
    ["intent ID", "intentId", "other"],
    ["instrument", "instrumentId", OTHER_INSTRUMENT],
    ["candidate", "candidateId", "other"],
    ["currency", "accountCurrency", "EUR"],
    ["approved risk", "approvedRiskAmount", "101"],
    ["actual risk", "actualRiskAmount", "95"],
    ["quantity", "quantity", "15"],
    ["quantity unit", "quantityUnit", "contract"],
    ["reward/risk", "netRewardRiskBps", "99999"],
    ["asOf", "asOf", AS_OF + 1],
    ["direction", "direction", "DOWN"],
    ["family", "family", "BREAKOUT_RETEST"],
  ])("rejects an expected-intent %s mismatch", (_label, field, value) => {
    const evidence = mutableEvidence();
    evidence.expectedIntent[field] = value;
    expect(restoreReadyTradeIntent(evidence)).toMatchObject({ reason: "EXPECTED_INTENT_IDENTITY_MISMATCH" });
  });

  it("does not mutate recovery evidence", () => {
    const evidence = fixture();
    const before = structuredClone(evidence);
    restoreReadyTradeIntent(evidence);
    expect(evidence).toEqual(before);
  });

  it("repeats restoration deeply equivalently", () => {
    expect(restoreReadyTradeIntent(fixture())).toEqual(restoreReadyTradeIntent(fixture()));
  });

  it("is fully equivalent to the normal candle-to-intent authority chain", () => {
    const normal = normalChain();
    const result = restored();
    expect(result.riskQualification).toEqual(normal.riskQualification);
    expect(result.portfolioRisk).toEqual(normal.portfolioRisk);
    expect(result.sizing).toEqual(normal.sizing);
    expect(result.tradeIntent).toEqual(normal.tradeIntent);
  });

  it("invalidates an upstream setup-candle mutation", () => {
    const evidence = mutableEvidence();
    evidence.setupCandidateEvidence.setupCandles[6].targetAcceptedTrades[3].price = "12";
    expect(restoreReadyTradeIntent(evidence).status).toBe("READY_TRADE_INTENT_RESTORATION_REJECTED");
  });

  it("invalidates a risk-config mutation through normal qualification", () => {
    const evidence = mutableEvidence();
    evidence.structuralRisk.config.minimumNetRewardRiskBps = 70_000;
    expect(restoreReadyTradeIntent(evidence)).toMatchObject({ reason: "RISK_NOT_QUALIFIED" });
  });

  it("invalidates a portfolio-state mutation through normal capital evaluation", () => {
    const evidence = mutableEvidence();
    evidence.portfolioRisk.account.currentEquity = "1000";
    expect(restoreReadyTradeIntent(evidence)).toMatchObject({ reason: "PORTFOLIO_NOT_CAPITAL_ELIGIBLE" });
  });

  it("invalidates a portfolio-config mutation through normal capital evaluation", () => {
    const evidence = mutableEvidence();
    evidence.portfolioRisk.config.maxRiskPerTradeBps = 50;
    expect(restoreReadyTradeIntent(evidence)).toMatchObject({ reason: "PORTFOLIO_NOT_CAPITAL_ELIGIBLE" });
  });

  it("invalidates a sizing-input mutation through normal sizing and selector binding", () => {
    const evidence = mutableEvidence();
    evidence.positionSizing.instrumentSpec.quantityStep = "2";
    evidence.positionSizing.instrumentSpec.minimumQuantity = "2";
    expect(restoreReadyTradeIntent(evidence)).toMatchObject({ reason: "EXPECTED_INTENT_IDENTITY_MISMATCH" });
  });

  it("uses the expected selector only as verification, never as output authority", () => {
    const evidence = mutableEvidence();
    evidence.expectedIntent.quantity = "999";
    const result = restoreReadyTradeIntent(evidence);
    expect(result).toEqual({
      status: "READY_TRADE_INTENT_RESTORATION_REJECTED",
      reason: "EXPECTED_INTENT_IDENTITY_MISMATCH",
    });
  });

  it("binds the setup candidate, risk, portfolio, sizing, and intent to one replay graph", () => {
    const result = restored();
    expect(result.riskQualification.candidateId).toBe(result.setupAuthority.candidate.id);
    expect(result.portfolioRisk.candidateId).toBe(result.riskQualification.candidateId);
    expect(result.sizing.candidateId).toBe(result.portfolioRisk.candidateId);
    expect(result.tradeIntent.candidateId).toBe(result.sizing.candidateId);
    expect(result.tradeIntent.accountCurrency).toBe(result.sizing.accountCurrency);
    expect(result.tradeIntent.actualRiskAmount).toBe(result.sizing.actualRiskAmount);
  });

  it("returns frozen rejection wrappers", () => {
    expect(Object.isFrozen(restoreReadyTradeIntent(null))).toBe(true);
  });

  it("accepts the canonical selector produced by the normal intent and no stored authority objects", () => {
    const evidence = fixture();
    expect("tradeIntent" in evidence).toBe(false);
    expect("riskQualification" in evidence).toBe(false);
    expect("portfolioRiskResult" in evidence).toBe(false);
    expect("positionSizingResult" in evidence).toBe(false);
    expect(restored().tradeIntent).toEqual(normalChain().tradeIntent);
  });
});
