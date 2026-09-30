import { unixMs } from "@ulte/instrument-model";
import {
  restoreFinalizedCandleSnapshot,
  type CandleSnapshot,
  type FinalizedCandleRecoveryEvidenceV1,
  type FinalizedCandleSnapshotRestorationRejectionReason,
} from "@ulte/market-data";
import {
  PRIMARY_REGIMES,
  classifyMarketRegime,
  createRegimeConfig,
  type PrimaryRegime,
  type ReadyRegimeResult,
  type RegimeConfig,
} from "@ulte/regime-engine";
import {
  analyzeMarketStructure,
  createStructureConfig,
  type ReadyStructureResult,
  type StructureConfig,
} from "@ulte/structure-engine";
import { createPositionSetupConfig, type PositionSetupConfig } from "./config.js";
import { evaluatePositionSetups } from "./evaluator.js";
import {
  SETUP_FAMILIES,
  type ReadySetupEvaluationResult,
  type SetupCandidate,
  type SetupDirection,
  type SetupFamily,
  type SetupStage,
} from "./types.js";

export const SETUP_CANDIDATE_RECOVERY_EVIDENCE_SCHEMA_VERSION =
  "SETUP_CANDIDATE_RECOVERY_EVIDENCE_V1" as const;

export const SETUP_ANALYSIS_IMPLEMENTATION =
  "BUILTIN_REGIME_STRUCTURE_SETUP_V1" as const;

export interface SetupCandidateRecoverySelectorV1 {
  readonly id: string;
  readonly family: SetupFamily;
  readonly direction: SetupDirection;
  readonly stage: SetupStage;
  readonly instrumentId: string;
  readonly contextTimeframe: string;
  readonly setupTimeframe: string;
  readonly asOf: number;
  readonly initiatedAt: number;
  readonly confirmedAt?: number;
}

export interface SetupCandidateRecoveryEvidenceV1 {
  readonly schemaVersion: typeof SETUP_CANDIDATE_RECOVERY_EVIDENCE_SCHEMA_VERSION;
  readonly analysisImplementation: typeof SETUP_ANALYSIS_IMPLEMENTATION;
  readonly analysisAsOf: number;
  readonly contextCandles: readonly FinalizedCandleRecoveryEvidenceV1[];
  readonly setupCandles: readonly FinalizedCandleRecoveryEvidenceV1[];
  readonly regimeConfig: RegimeConfig;
  readonly structureConfig: StructureConfig;
  readonly setupConfig: PositionSetupConfig;
  readonly expectedCandidate: SetupCandidateRecoverySelectorV1;
}

export type SetupCandidateRestorationRejectionReason =
  | "INVALID_RECOVERY_EVIDENCE"
  | "UNSUPPORTED_RECOVERY_SCHEMA"
  | "UNSUPPORTED_ANALYSIS_IMPLEMENTATION"
  | "INVALID_ANALYSIS_AS_OF"
  | "INVALID_REGIME_CONFIG"
  | "INVALID_STRUCTURE_CONFIG"
  | "INVALID_SETUP_CONFIG"
  | "CANDLE_RESTORATION_REJECTED"
  | "CONTEXT_REGIME_NOT_READY"
  | "STRUCTURE_NOT_READY"
  | "SETUP_EVALUATION_REJECTED"
  | "EXPECTED_CANDIDATE_NOT_FOUND"
  | "CANDIDATE_IDENTITY_MISMATCH"
  | "EXPECTED_CANDIDATE_AMBIGUOUS";

export type SetupCandidateRestorationResult =
  | Readonly<{
      readonly status: "SETUP_CANDIDATE_RESTORED";
      readonly contextCandles: readonly CandleSnapshot[];
      readonly setupCandles: readonly CandleSnapshot[];
      readonly contextRegime: ReadyRegimeResult;
      readonly setupStructure: ReadyStructureResult;
      readonly setupEvaluation: ReadySetupEvaluationResult;
      readonly candidate: SetupCandidate;
    }>
  | Readonly<{
      readonly status: "SETUP_CANDIDATE_RESTORATION_REJECTED";
      readonly reason: SetupCandidateRestorationRejectionReason;
      readonly candleRole?: "CONTEXT" | "SETUP";
      readonly candleIndex?: number;
      readonly upstreamStatus?: string;
      readonly upstreamReason?: string;
      readonly candleRestorationReason?: FinalizedCandleSnapshotRestorationRejectionReason;
    }>;

type DataRecord = Readonly<Record<string, unknown>>;

type ValidatedEvidence = Readonly<{
  readonly evidence: Readonly<{
    readonly schemaVersion: typeof SETUP_CANDIDATE_RECOVERY_EVIDENCE_SCHEMA_VERSION;
    readonly analysisImplementation: typeof SETUP_ANALYSIS_IMPLEMENTATION;
    readonly analysisAsOf: number;
    readonly contextCandles: readonly unknown[];
    readonly setupCandles: readonly unknown[];
    readonly regimeConfig: RegimeConfig;
    readonly structureConfig: StructureConfig;
    readonly setupConfig: PositionSetupConfig;
    readonly expectedCandidate: SetupCandidateRecoverySelectorV1;
  }>;
}>;

function isRecord(value: unknown): value is DataRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function hasExactKeys(value: DataRecord, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
}

function isDenseArray(value: unknown): value is readonly unknown[] {
  if (!Array.isArray(value)
      || Object.keys(value).length !== value.length
      || Reflect.ownKeys(value).length !== value.length + 1) return false;
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.prototype.hasOwnProperty.call(value, index)) return false;
  }
  return true;
}

function isPrimaryRegime(value: unknown): value is PrimaryRegime {
  return typeof value === "string" && (PRIMARY_REGIMES as readonly string[]).includes(value);
}

function isRegimeList(value: unknown): value is readonly PrimaryRegime[] {
  return isDenseArray(value) && value.every(isPrimaryRegime);
}

function isRegimeConfig(value: unknown): value is RegimeConfig {
  if (!isRecord(value) || !hasExactKeys(value, [
    "trendLookback", "baselineVolatilityBars", "recentVolatilityBars",
    "trendEfficiencyMinBps", "trendConsistencyMinBps", "rangeEfficiencyMaxBps",
    "rangeConsistencyMaxBps", "compressionRatioMaxBps", "expansionRatioMinBps",
  ])) return false;
  return Object.values(value).every((item) => typeof item === "number");
}

function isStructureConfig(value: unknown): value is StructureConfig {
  return isRecord(value)
    && hasExactKeys(value, ["lookbackBars", "pivotLeftBars", "pivotRightBars"])
    && Object.values(value).every((item) => typeof item === "number");
}

function isSetupConfig(value: unknown): value is PositionSetupConfig {
  return isRecord(value)
    && hasExactKeys(value, [
      "continuationAllowedRegimes", "breakoutAllowedRegimes", "reversalAllowedRegimes",
    ])
    && isRegimeList(value["continuationAllowedRegimes"])
    && isRegimeList(value["breakoutAllowedRegimes"])
    && isRegimeList(value["reversalAllowedRegimes"]);
}

function isSetupFamily(value: unknown): value is SetupFamily {
  return typeof value === "string" && (SETUP_FAMILIES as readonly string[]).includes(value);
}

function isDirection(value: unknown): value is SetupDirection {
  return value === "UP" || value === "DOWN";
}

function isStage(value: unknown): value is SetupStage {
  return value === "ARMED" || value === "CONFIRMED";
}

function isSelector(value: unknown): value is SetupCandidateRecoverySelectorV1 {
  if (!isRecord(value)) return false;
  const keys = [
    "id", "family", "direction", "stage", "instrumentId", "contextTimeframe",
    "setupTimeframe", "asOf", "initiatedAt",
  ];
  if (value["confirmedAt"] !== undefined) keys.push("confirmedAt");
  return hasExactKeys(value, keys)
    && typeof value["id"] === "string" && value["id"].length > 0
    && isSetupFamily(value["family"])
    && isDirection(value["direction"])
    && isStage(value["stage"])
    && typeof value["instrumentId"] === "string"
    && typeof value["contextTimeframe"] === "string"
    && typeof value["setupTimeframe"] === "string"
    && typeof value["asOf"] === "number"
    && typeof value["initiatedAt"] === "number"
    && (value["confirmedAt"] === undefined || typeof value["confirmedAt"] === "number");
}

function rejected(
  reason: SetupCandidateRestorationRejectionReason,
  details: Omit<Extract<SetupCandidateRestorationResult, {
    readonly status: "SETUP_CANDIDATE_RESTORATION_REJECTED";
  }>, "status" | "reason"> = {},
): SetupCandidateRestorationResult {
  return Object.freeze({
    status: "SETUP_CANDIDATE_RESTORATION_REJECTED",
    reason,
    ...details,
  });
}

function validateEvidence(value: unknown): ValidatedEvidence | SetupCandidateRestorationResult {
  if (!isRecord(value)) return rejected("INVALID_RECOVERY_EVIDENCE");
  if (value["schemaVersion"] !== SETUP_CANDIDATE_RECOVERY_EVIDENCE_SCHEMA_VERSION) {
    return typeof value["schemaVersion"] === "string"
      ? rejected("UNSUPPORTED_RECOVERY_SCHEMA")
      : rejected("INVALID_RECOVERY_EVIDENCE");
  }
  if (value["analysisImplementation"] !== SETUP_ANALYSIS_IMPLEMENTATION) {
    return typeof value["analysisImplementation"] === "string"
      ? rejected("UNSUPPORTED_ANALYSIS_IMPLEMENTATION")
      : rejected("INVALID_RECOVERY_EVIDENCE");
  }
  if (!hasExactKeys(value, [
    "schemaVersion", "analysisImplementation", "analysisAsOf", "contextCandles",
    "setupCandles", "regimeConfig", "structureConfig", "setupConfig", "expectedCandidate",
  ])
      || typeof value["analysisAsOf"] !== "number"
      || !isDenseArray(value["contextCandles"])
      || !isDenseArray(value["setupCandles"])
      || !isRegimeConfig(value["regimeConfig"])
      || !isStructureConfig(value["structureConfig"])
      || !isSetupConfig(value["setupConfig"])
      || !isSelector(value["expectedCandidate"])) {
    return rejected("INVALID_RECOVERY_EVIDENCE");
  }
  return Object.freeze({
    evidence: Object.freeze({
      schemaVersion: SETUP_CANDIDATE_RECOVERY_EVIDENCE_SCHEMA_VERSION,
      analysisImplementation: SETUP_ANALYSIS_IMPLEMENTATION,
      analysisAsOf: value["analysisAsOf"],
      contextCandles: value["contextCandles"],
      setupCandles: value["setupCandles"],
      regimeConfig: value["regimeConfig"],
      structureConfig: value["structureConfig"],
      setupConfig: value["setupConfig"],
      expectedCandidate: value["expectedCandidate"],
    }),
  });
}

function restoreCandles(
  evidence: readonly unknown[],
  role: "CONTEXT" | "SETUP",
): readonly CandleSnapshot[] | SetupCandidateRestorationResult {
  const candles: CandleSnapshot[] = [];
  for (let index = 0; index < evidence.length; index += 1) {
    const result = restoreFinalizedCandleSnapshot(evidence[index]);
    if (result.status !== "FINALIZED_CANDLE_SNAPSHOT_RESTORED") {
      return rejected("CANDLE_RESTORATION_REJECTED", {
        candleRole: role,
        candleIndex: index,
        candleRestorationReason: result.reason,
      });
    }
    candles.push(result.snapshot);
  }
  return Object.freeze(candles);
}

function isCandleRestorationRejection(
  value: readonly CandleSnapshot[] | SetupCandidateRestorationResult,
): value is SetupCandidateRestorationResult {
  return !Array.isArray(value);
}

function matchesSelector(candidate: SetupCandidate, selector: SetupCandidateRecoverySelectorV1): boolean {
  return candidate.id === selector.id
    && candidate.family === selector.family
    && candidate.direction === selector.direction
    && candidate.stage === selector.stage
    && candidate.instrumentId === selector.instrumentId
    && candidate.contextTimeframe === selector.contextTimeframe
    && candidate.setupTimeframe === selector.setupTimeframe
    && candidate.asOf === selector.asOf
    && candidate.initiatedAt === selector.initiatedAt
    && candidate.confirmedAt === selector.confirmedAt;
}

export function restoreSetupCandidateFromAnalysisEvidence(
  recoveryEvidence: unknown,
): SetupCandidateRestorationResult {
  const validation = validateEvidence(recoveryEvidence);
  if (!("evidence" in validation)) return validation;
  const evidence = validation.evidence;

  let asOf: ReturnType<typeof unixMs>;
  try {
    asOf = unixMs(evidence.analysisAsOf);
    unixMs(evidence.expectedCandidate.asOf);
    unixMs(evidence.expectedCandidate.initiatedAt);
    if (evidence.expectedCandidate.confirmedAt !== undefined) {
      unixMs(evidence.expectedCandidate.confirmedAt);
    }
  } catch {
    return rejected("INVALID_ANALYSIS_AS_OF");
  }
  if (evidence.expectedCandidate.asOf !== asOf) {
    return rejected("CANDIDATE_IDENTITY_MISMATCH");
  }

  let regimeConfig: Readonly<RegimeConfig>;
  try {
    regimeConfig = createRegimeConfig(evidence.regimeConfig);
  } catch {
    return rejected("INVALID_REGIME_CONFIG");
  }
  let structureConfig: Readonly<StructureConfig>;
  try {
    structureConfig = createStructureConfig(evidence.structureConfig);
  } catch {
    return rejected("INVALID_STRUCTURE_CONFIG");
  }
  let setupConfig: Readonly<PositionSetupConfig>;
  try {
    setupConfig = createPositionSetupConfig(evidence.setupConfig);
  } catch {
    return rejected("INVALID_SETUP_CONFIG");
  }

  const contextCandles = restoreCandles(evidence.contextCandles, "CONTEXT");
  if (isCandleRestorationRejection(contextCandles)) return contextCandles;
  const setupCandles = restoreCandles(evidence.setupCandles, "SETUP");
  if (isCandleRestorationRejection(setupCandles)) return setupCandles;

  const contextRegime = classifyMarketRegime(contextCandles, regimeConfig);
  if (contextRegime.status !== "READY") {
    return rejected("CONTEXT_REGIME_NOT_READY", {
      upstreamStatus: contextRegime.status,
      upstreamReason: contextRegime.reason,
    });
  }
  const setupStructure = analyzeMarketStructure(setupCandles, structureConfig);
  if (setupStructure.status !== "READY") {
    return rejected("STRUCTURE_NOT_READY", {
      upstreamStatus: setupStructure.status,
      upstreamReason: setupStructure.reason,
    });
  }
  const setupEvaluation = evaluatePositionSetups({
    asOf,
    contextRegime,
    setupStructure,
    setupCandles,
  }, setupConfig);
  if (setupEvaluation.status !== "READY") {
    return rejected("SETUP_EVALUATION_REJECTED", {
      upstreamStatus: setupEvaluation.status,
      upstreamReason: setupEvaluation.reason,
    });
  }

  const idMatches = setupEvaluation.candidates.filter((candidate) =>
    candidate.id === evidence.expectedCandidate.id);
  if (idMatches.length === 0) return rejected("EXPECTED_CANDIDATE_NOT_FOUND");
  const matches = idMatches.filter((candidate) => matchesSelector(candidate, evidence.expectedCandidate));
  if (matches.length === 0) return rejected("CANDIDATE_IDENTITY_MISMATCH");
  if (matches.length > 1) return rejected("EXPECTED_CANDIDATE_AMBIGUOUS");

  return Object.freeze({
    status: "SETUP_CANDIDATE_RESTORED",
    contextCandles,
    setupCandles,
    contextRegime,
    setupStructure,
    setupEvaluation,
    candidate: matches[0]!,
  });
}
