import { describe, expect, it } from "vitest";
import { createInstrumentId } from "@ulte/instrument-model";
import {
  FINALIZED_CANDLE_RECOVERY_EVIDENCE_SCHEMA_VERSION,
  restoreFinalizedCandleSnapshot,
  type FinalizedCandleRecoveryEvidenceV1,
} from "@ulte/market-data";
import { classifyMarketRegime, createRegimeConfig } from "@ulte/regime-engine";
import { analyzeMarketStructure, createStructureConfig } from "@ulte/structure-engine";
import {
  SETUP_ANALYSIS_IMPLEMENTATION,
  SETUP_CANDIDATE_RECOVERY_EVIDENCE_SCHEMA_VERSION,
  createPositionSetupConfig,
  evaluatePositionSetups,
  restoreSetupCandidateFromAnalysisEvidence,
  type SetupCandidate,
  type SetupCandidateRecoveryEvidenceV1,
} from "./index.js";

const INSTRUMENT = createInstrumentId({ venue: "TEST", venueSymbol: "ABC", instrumentKind: "SPOT" });
const OTHER_INSTRUMENT = createInstrumentId({ venue: "TEST", venueSymbol: "XYZ", instrumentKind: "SPOT" });
const SOURCE = "RECOVERY_TEST";

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

const STRUCTURE_CONFIG = Object.freeze({
  lookbackBars: 5,
  pivotLeftBars: 1,
  pivotRightBars: 1,
});

const SETUP_CONFIG = Object.freeze({
  continuationAllowedRegimes: Object.freeze(["TREND_UP"] as const),
  breakoutAllowedRegimes: Object.freeze([]),
  reversalAllowedRegimes: Object.freeze([]),
});

function recoveryTrade(
  instrumentId: string,
  eventTime: number,
  price: string,
  identity: string,
): FinalizedCandleRecoveryEvidenceV1["previousAcceptedTrade"] {
  return Object.freeze({
    eventIdentity: identity,
    instrumentId,
    source: SOURCE,
    eventTime,
    receivedAt: eventTime,
    price,
    quantity: "1",
    side: "UNKNOWN",
    quality: Object.freeze(["LIVE"]),
  });
}

function candleEvidence(input: {
  readonly instrumentId?: string;
  readonly timeframe: string;
  readonly duration: number;
  readonly openTime: number;
  readonly open: string;
  readonly high: string;
  readonly low: string;
  readonly close: string;
  readonly identity: string;
}): FinalizedCandleRecoveryEvidenceV1 {
  const instrumentId = input.instrumentId ?? INSTRUMENT;
  const closeTime = input.openTime + input.duration;
  return Object.freeze({
    schemaVersion: FINALIZED_CANDLE_RECOVERY_EVIDENCE_SCHEMA_VERSION,
    config: Object.freeze({ instrumentId, source: SOURCE, timeframe: input.timeframe, anchorTime: 0 }),
    target: Object.freeze({ openTime: input.openTime, closeTime }),
    previousAcceptedTrade: recoveryTrade(
      instrumentId,
      input.openTime - 1,
      input.open,
      `${input.identity}:previous`,
    ),
    targetAcceptedTrades: Object.freeze([
      recoveryTrade(instrumentId, input.openTime, input.open, `${input.identity}:open`),
      recoveryTrade(instrumentId, input.openTime + 1, input.high, `${input.identity}:high`),
      recoveryTrade(instrumentId, input.openTime + 2, input.low, `${input.identity}:low`),
      recoveryTrade(instrumentId, closeTime - 1, input.close, `${input.identity}:close`),
    ]),
    finalizationWitness: recoveryTrade(
      instrumentId,
      closeTime,
      input.close,
      `${input.identity}:witness`,
    ),
  });
}

function contextEvidence(instrumentId = INSTRUMENT): readonly FinalizedCandleRecoveryEvidenceV1[] {
  return Object.freeze(["10", "11", "12", "13", "14", "15"].map((close, index) =>
    candleEvidence({
      instrumentId,
      timeframe: "5m",
      duration: 300_000,
      openTime: (index + 1) * 300_000,
      open: close,
      high: String(Number(close) + 1),
      low: String(Number(close) - 1),
      close,
      identity: `context:${index}`,
    })));
}

function setupEvidence(instrumentId = INSTRUMENT): readonly FinalizedCandleRecoveryEvidenceV1[] {
  const values = [
    { open: "5", high: "6", low: "5", close: "5" },
    { open: "2", high: "7", low: "2", close: "2" },
    { open: "5", high: "6", low: "5", close: "5" },
    { open: "2", high: "7", low: "1", close: "2" },
    { open: "8", high: "8", low: "4", close: "8" },
  ];
  return Object.freeze(values.map((value, index) => candleEvidence({
    instrumentId,
    timeframe: "1m",
    duration: 60_000,
    openTime: (index + 1) * 60_000,
    ...value,
    identity: `setup:${index}`,
  })));
}

function restoreCandles(evidence: readonly FinalizedCandleRecoveryEvidenceV1[]) {
  return evidence.map((item) => {
    const result = restoreFinalizedCandleSnapshot(item);
    if (result.status !== "FINALIZED_CANDLE_SNAPSHOT_RESTORED") {
      throw new Error(`Fixture candle rejected: ${result.reason}`);
    }
    return result.snapshot;
  });
}

function normalEvaluation(options: {
  readonly context?: readonly FinalizedCandleRecoveryEvidenceV1[];
  readonly setup?: readonly FinalizedCandleRecoveryEvidenceV1[];
  readonly setupConfig?: typeof SETUP_CONFIG;
} = {}) {
  const contextCandles = restoreCandles(options.context ?? contextEvidence());
  const setupCandles = restoreCandles(options.setup ?? setupEvidence());
  const contextRegime = classifyMarketRegime(contextCandles, createRegimeConfig(REGIME_CONFIG));
  const setupStructure = analyzeMarketStructure(setupCandles, createStructureConfig(STRUCTURE_CONFIG));
  const setupEvaluation = evaluatePositionSetups({
    asOf: 2_100_000,
    contextRegime,
    setupStructure,
    setupCandles,
  }, createPositionSetupConfig(options.setupConfig ?? SETUP_CONFIG));
  if (setupEvaluation.status !== "READY" || setupEvaluation.candidates.length === 0) {
    throw new Error("Fixture did not produce a setup candidate");
  }
  return { contextCandles, setupCandles, contextRegime, setupStructure, setupEvaluation };
}

function selector(candidate: SetupCandidate): SetupCandidateRecoveryEvidenceV1["expectedCandidate"] {
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

function fixture(options: {
  readonly context?: readonly FinalizedCandleRecoveryEvidenceV1[];
  readonly setup?: readonly FinalizedCandleRecoveryEvidenceV1[];
  readonly setupConfig?: typeof SETUP_CONFIG;
  readonly candidateIndex?: number;
} = {}): SetupCandidateRecoveryEvidenceV1 {
  const context = options.context ?? contextEvidence();
  const setup = options.setup ?? setupEvidence();
  const normal = normalEvaluation({ context, setup, setupConfig: options.setupConfig });
  const candidate = normal.setupEvaluation.candidates[options.candidateIndex ?? 0];
  if (candidate === undefined) throw new Error("Requested candidate is absent");
  return Object.freeze({
    schemaVersion: SETUP_CANDIDATE_RECOVERY_EVIDENCE_SCHEMA_VERSION,
    analysisImplementation: SETUP_ANALYSIS_IMPLEMENTATION,
    analysisAsOf: 2_100_000,
    contextCandles: context,
    setupCandles: setup,
    regimeConfig: REGIME_CONFIG,
    structureConfig: STRUCTURE_CONFIG,
    setupConfig: options.setupConfig ?? SETUP_CONFIG,
    expectedCandidate: selector(candidate),
  });
}

function mutableEvidence(): Record<string, any> {
  return structuredClone(fixture());
}

describe("setup candidate authority restoration", () => {
  it("replays the complete built-in authority graph and preserves the selected candidate reference", () => {
    const evidence = fixture();
    const before = structuredClone(evidence);
    const normal = normalEvaluation();
    const restored = restoreSetupCandidateFromAnalysisEvidence(evidence);

    expect(restored.status).toBe("SETUP_CANDIDATE_RESTORED");
    if (restored.status !== "SETUP_CANDIDATE_RESTORED") throw new Error(restored.reason);
    expect(restored.contextRegime).toEqual(normal.contextRegime);
    expect(restored.setupStructure).toEqual(normal.setupStructure);
    expect(restored.setupEvaluation).toEqual(normal.setupEvaluation);
    expect(restored.candidate).toEqual(normal.setupEvaluation.candidates[0]);
    expect(restored.setupEvaluation.candidates).toContain(restored.candidate);
    expect(restored.setupEvaluation.candidates.find((item) => item.id === restored.candidate.id))
      .toBe(restored.candidate);
    expect(Object.isFrozen(restored)).toBe(true);
    expect(Object.isFrozen(restored.contextCandles)).toBe(true);
    expect(Object.isFrozen(restored.setupCandles)).toBe(true);
    expect(evidence).toEqual(before);
  });

  it("is deterministic across repeated restoration", () => {
    const evidence = fixture();
    expect(restoreSetupCandidateFromAnalysisEvidence(evidence))
      .toEqual(restoreSetupCandidateFromAnalysisEvidence(evidence));
  });

  it("rejects a compensated sparse context-candle array at the structural boundary", () => {
    const evidence = mutableEvidence();
    const contextCandles = new Array<FinalizedCandleRecoveryEvidenceV1>(1);
    (contextCandles as any).extra = "compensating-key";
    evidence.contextCandles = contextCandles;

    expect(() => restoreSetupCandidateFromAnalysisEvidence(evidence)).not.toThrow();
    expect(restoreSetupCandidateFromAnalysisEvidence(evidence)).toMatchObject({
      status: "SETUP_CANDIDATE_RESTORATION_REJECTED",
      reason: "INVALID_RECOVERY_EVIDENCE",
    });
  });

  it.each([
    ["unsupported schema", (value: Record<string, any>) => { value.schemaVersion = "V2"; }, "UNSUPPORTED_RECOVERY_SCHEMA"],
    ["unsupported implementation", (value: Record<string, any>) => { value.analysisImplementation = "custom"; }, "UNSUPPORTED_ANALYSIS_IMPLEMENTATION"],
    ["missing implementation", (value: Record<string, any>) => { delete value.analysisImplementation; }, "INVALID_RECOVERY_EVIDENCE"],
    ["malformed asOf", (value: Record<string, any>) => { value.analysisAsOf = -1; }, "INVALID_ANALYSIS_AS_OF"],
    ["invalid regime config", (value: Record<string, any>) => { value.regimeConfig.trendLookback = 1; }, "INVALID_REGIME_CONFIG"],
    ["invalid structure config", (value: Record<string, any>) => { value.structureConfig.lookbackBars = 2; }, "INVALID_STRUCTURE_CONFIG"],
    ["invalid setup config", (value: Record<string, any>) => { value.setupConfig.continuationAllowedRegimes = ["TREND_UP", "TREND_UP"]; }, "INVALID_SETUP_CONFIG"],
  ])("rejects %s", (_name, mutate, reason) => {
    const evidence = mutableEvidence();
    mutate(evidence);
    expect(restoreSetupCandidateFromAnalysisEvidence(evidence)).toMatchObject({
      status: "SETUP_CANDIDATE_RESTORATION_REJECTED",
      reason,
    });
  });

  it("reports the exact candle role and index when canonical restoration fails", () => {
    const context = mutableEvidence();
    context.contextCandles[2].finalizationWitness.eventTime = context.contextCandles[2].target.closeTime - 1;
    expect(restoreSetupCandidateFromAnalysisEvidence(context)).toMatchObject({
      status: "SETUP_CANDIDATE_RESTORATION_REJECTED",
      reason: "CANDLE_RESTORATION_REJECTED",
      candleRole: "CONTEXT",
      candleIndex: 2,
      candleRestorationReason: "FINALIZATION_WITNESS_IN_TARGET_BUCKET",
    });

    const setup = mutableEvidence();
    setup.setupCandles[3].previousAcceptedTrade.eventTime = setup.setupCandles[3].target.openTime;
    expect(restoreSetupCandidateFromAnalysisEvidence(setup)).toMatchObject({
      reason: "CANDLE_RESTORATION_REJECTED",
      candleRole: "SETUP",
      candleIndex: 3,
    });
  });

  it("fails closed for non-ready regime and structure authority", () => {
    const regime = mutableEvidence();
    regime.contextCandles = regime.contextCandles.slice(0, 2);
    expect(restoreSetupCandidateFromAnalysisEvidence(regime)).toMatchObject({
      reason: "CONTEXT_REGIME_NOT_READY",
      upstreamStatus: "INSUFFICIENT_DATA",
      upstreamReason: "NOT_ENOUGH_CANDLES",
    });

    const structure = mutableEvidence();
    structure.setupCandles = structure.setupCandles.slice(0, 2);
    expect(restoreSetupCandidateFromAnalysisEvidence(structure)).toMatchObject({
      reason: "STRUCTURE_NOT_READY",
      upstreamStatus: "INSUFFICIENT_DATA",
      upstreamReason: "NOT_ENOUGH_CANDLES",
    });
  });

  it("preserves normal setup rejection for cross-instrument analysis", () => {
    const evidence = mutableEvidence();
    evidence.contextCandles = structuredClone(contextEvidence(OTHER_INSTRUMENT));
    expect(restoreSetupCandidateFromAnalysisEvidence(evidence)).toMatchObject({
      reason: "SETUP_EVALUATION_REJECTED",
      upstreamStatus: "DATA_REJECTED",
      upstreamReason: "INSTRUMENT_MISMATCH",
    });
  });

  it("does not fall back for zero candidates, absent IDs, or selector mismatches", () => {
    const zero = mutableEvidence();
    zero.setupConfig.continuationAllowedRegimes = [];
    expect(restoreSetupCandidateFromAnalysisEvidence(zero)).toMatchObject({
      reason: "EXPECTED_CANDIDATE_NOT_FOUND",
    });

    const missing = mutableEvidence();
    missing.expectedCandidate.id = "missing";
    expect(restoreSetupCandidateFromAnalysisEvidence(missing)).toMatchObject({
      reason: "EXPECTED_CANDIDATE_NOT_FOUND",
    });

    const mismatch = mutableEvidence();
    mismatch.expectedCandidate.stage = mismatch.expectedCandidate.stage === "ARMED" ? "CONFIRMED" : "ARMED";
    expect(restoreSetupCandidateFromAnalysisEvidence(mismatch)).toMatchObject({
      reason: "CANDIDATE_IDENTITY_MISMATCH",
    });
  });

  it("selects an explicitly identified non-first candidate from a multi-candidate result", () => {
    const multiConfig = Object.freeze({
      continuationAllowedRegimes: Object.freeze(["TREND_UP"] as const),
      breakoutAllowedRegimes: Object.freeze(["TREND_UP"] as const),
      reversalAllowedRegimes: Object.freeze(["TREND_UP"] as const),
    });
    const evidence = fixture({ setupConfig: multiConfig, candidateIndex: 1 });
    const restored = restoreSetupCandidateFromAnalysisEvidence(evidence);
    expect(restored.status).toBe("SETUP_CANDIDATE_RESTORED");
    if (restored.status !== "SETUP_CANDIDATE_RESTORED") throw new Error(restored.reason);
    expect(restored.setupEvaluation.candidates.length).toBeGreaterThan(1);
    expect(restored.candidate).toBe(restored.setupEvaluation.candidates[1]);
    expect(restored.candidate).not.toBe(restored.setupEvaluation.candidates[0]);
  });

  it("invalidates the expected candidate after output-changing config mutations", () => {
    const regime = mutableEvidence();
    regime.regimeConfig.expansionRatioMinBps = 10_000;
    expect(restoreSetupCandidateFromAnalysisEvidence(regime)).toMatchObject({ reason: "EXPECTED_CANDIDATE_NOT_FOUND" });

    const structure = mutableEvidence();
    structure.structureConfig.lookbackBars = 4;
    expect(restoreSetupCandidateFromAnalysisEvidence(structure)).toMatchObject({ reason: "EXPECTED_CANDIDATE_NOT_FOUND" });

    const setup = mutableEvidence();
    setup.setupConfig.continuationAllowedRegimes = [];
    expect(restoreSetupCandidateFromAnalysisEvidence(setup)).toMatchObject({ reason: "EXPECTED_CANDIDATE_NOT_FOUND" });
  });

  it("invalidates authority after candle value, chronology, identity, alignment, predecessor, witness, and quality mutations", () => {
    const mutations: Array<(value: Record<string, any>) => void> = [
      (value) => { value.setupCandles[3].targetAcceptedTrades[2].price = "2"; },
      (value) => { value.setupCandles[3].targetAcceptedTrades[2].eventTime = value.setupCandles[3].targetAcceptedTrades[1].eventTime - 1; },
      (value) => { value.setupCandles[3].targetAcceptedTrades[0].instrumentId = OTHER_INSTRUMENT; },
      (value) => { value.setupCandles[3].config.timeframe = "5m"; },
      (value) => { value.setupCandles[3].previousAcceptedTrade.eventTime = value.setupCandles[3].target.openTime; },
      (value) => { value.setupCandles[3].finalizationWitness.eventTime = value.setupCandles[3].target.closeTime - 1; },
      (value) => { value.setupCandles[3].targetAcceptedTrades[0].quality = ["LIVE", "GAP_DETECTED"]; },
    ];
    for (const mutate of mutations) {
      const evidence = mutableEvidence();
      mutate(evidence);
      expect(restoreSetupCandidateFromAnalysisEvidence(evidence).status)
        .toBe("SETUP_CANDIDATE_RESTORATION_REJECTED");
    }
  });

  it("rejects setup timeframe incoherence through the normal replay chain", () => {
    const evidence = mutableEvidence();
    const changed = candleEvidence({
      timeframe: "5m",
      duration: 300_000,
      openTime: 300_000,
      open: "8",
      high: "8",
      low: "4",
      close: "8",
      identity: "wrong-timeframe",
    });
    evidence.setupCandles[4] = changed;
    expect(restoreSetupCandidateFromAnalysisEvidence(evidence).status)
      .toBe("SETUP_CANDIDATE_RESTORATION_REJECTED");
  });
});
