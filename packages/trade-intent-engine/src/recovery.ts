import {
  createAccountRiskSnapshot,
  createPortfolioRiskConfig,
  evaluatePortfolioRisk,
  type AccountRiskSnapshotInput,
  type CapitalEligibleResult,
  type PortfolioRiskConfig,
} from "@ulte/portfolio-risk-engine";
import {
  createFxConversionSnapshot,
  createLinearInstrumentSizingSpec,
  sizePosition,
  type FxConversionSnapshotInput,
  type LinearInstrumentSizingSpecInput,
  type SizedPositionResult,
} from "@ulte/position-sizing-engine";
import {
  createRiskCostAssumptions,
  createRiskQualificationConfig,
  qualifyStructuralRisk,
  type QualifiedRiskResult,
  type RiskCostAssumptions,
  type RiskQualificationConfig,
} from "@ulte/risk-engine";
import {
  restoreSetupCandidateFromAnalysisEvidence,
  type SetupCandidateRecoveryEvidenceV1,
  type SetupCandidateRestorationResult,
} from "@ulte/setup-engine";
import { createTradeIntent } from "./orchestrator.js";
import type { ReadyTradeIntent, TradeIntentResult } from "./types.js";

export const READY_TRADE_INTENT_RECOVERY_EVIDENCE_SCHEMA_VERSION =
  "READY_TRADE_INTENT_RECOVERY_EVIDENCE_V1" as const;

export interface ReadyTradeIntentRecoverySelectorV1 {
  readonly intentId: string;
  readonly candidateId: string;
  readonly instrumentId: string;
  readonly asOf: number;
  readonly family: string;
  readonly direction: string;
  readonly contextTimeframe: string;
  readonly setupTimeframe: string;
  readonly entryReferencePrice: string;
  readonly invalidationPrice: string;
  readonly primaryTargetPrice: string;
  readonly quantityUnit: string;
  readonly quantity: string;
  readonly quantityStep: string;
  readonly accountCurrency: string;
  readonly pnlCurrency: string;
  readonly conversionRate: string;
  readonly approvedRiskAmount: string;
  readonly actualRiskAmount: string;
  readonly unusedRiskAmount: string;
  readonly riskUtilizationBps: string;
  readonly structuralNetRisk: string;
  readonly netRewardRiskBps: string;
  readonly minimumRequiredNetRewardRiskBps: number;
  readonly pnlValuePerPriceUnitPerQuantity: string;
  readonly riskPerQuantityUnitInAccountCurrency: string;
  readonly riskPerQuantityStep: string;
  readonly cappedByMaximumQuantity: boolean;
}

export interface ReadyTradeIntentRecoveryEvidenceV1 {
  readonly schemaVersion: typeof READY_TRADE_INTENT_RECOVERY_EVIDENCE_SCHEMA_VERSION;
  readonly setupCandidateEvidence: SetupCandidateRecoveryEvidenceV1;
  readonly structuralRisk: Readonly<{
    readonly costs: RiskCostAssumptions;
    readonly config: RiskQualificationConfig;
  }>;
  readonly portfolioRisk: Readonly<{
    readonly account: AccountRiskSnapshotInput;
    readonly requestedRiskAmount: string;
    readonly proposedRiskGroupIds: readonly string[];
    readonly config: PortfolioRiskConfig;
  }>;
  readonly positionSizing: Readonly<{
    readonly instrumentSpec: LinearInstrumentSizingSpecInput;
    readonly fxConversion?: FxConversionSnapshotInput;
  }>;
  readonly expectedIntent: ReadyTradeIntentRecoverySelectorV1;
}

export type ReadyTradeIntentRestorationRejectionReason =
  | "INVALID_RECOVERY_EVIDENCE"
  | "UNSUPPORTED_RECOVERY_SCHEMA"
  | "SETUP_RESTORATION_REJECTED"
  | "INVALID_RISK_COSTS"
  | "INVALID_RISK_CONFIG"
  | "RISK_NOT_QUALIFIED"
  | "INVALID_PORTFOLIO_ACCOUNT"
  | "INVALID_PORTFOLIO_CONFIG"
  | "PORTFOLIO_NOT_CAPITAL_ELIGIBLE"
  | "INVALID_SIZING_SPEC"
  | "INVALID_FX_CONVERSION"
  | "POSITION_NOT_SIZED"
  | "TRADE_INTENT_CREATION_REJECTED"
  | "EXPECTED_INTENT_IDENTITY_MISMATCH";

type RestoredSetupAuthority = Extract<SetupCandidateRestorationResult, {
  readonly status: "SETUP_CANDIDATE_RESTORED";
}>;

export type ReadyTradeIntentRestorationResult =
  | Readonly<{
      readonly status: "READY_TRADE_INTENT_RESTORED";
      readonly setupAuthority: RestoredSetupAuthority;
      readonly riskQualification: QualifiedRiskResult;
      readonly portfolioRisk: CapitalEligibleResult;
      readonly sizing: SizedPositionResult;
      readonly tradeIntent: ReadyTradeIntent;
    }>
  | Readonly<{
      readonly status: "READY_TRADE_INTENT_RESTORATION_REJECTED";
      readonly reason: ReadyTradeIntentRestorationRejectionReason;
      readonly upstreamStatus?: string;
      readonly upstreamReason?: string;
    }>;

type DataRecord = Readonly<Record<string, unknown>>;

interface ValidatedEvidence {
  readonly setupCandidateEvidence: unknown;
  readonly riskCosts: RiskCostAssumptions;
  readonly riskConfig: RiskQualificationConfig;
  readonly account: AccountRiskSnapshotInput;
  readonly requestedRiskAmount: string;
  readonly proposedRiskGroupIds: readonly string[];
  readonly portfolioConfig: PortfolioRiskConfig;
  readonly instrumentSpec: LinearInstrumentSizingSpecInput;
  readonly fxConversion?: FxConversionSnapshotInput;
  readonly expectedIntent: ReadyTradeIntentRecoverySelectorV1;
}

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

function isStringArray(value: unknown): value is readonly string[] {
  return isDenseArray(value) && value.every((item) => typeof item === "string");
}

function isRiskCosts(value: unknown): value is RiskCostAssumptions {
  return isRecord(value)
    && hasExactKeys(value, ["entryCostBps", "targetExitCostBps", "stopExitCostBps"])
    && Object.values(value).every((item) => typeof item === "number");
}

function isRiskConfig(value: unknown): value is RiskQualificationConfig {
  return isRecord(value)
    && hasExactKeys(value, ["minimumNetRewardRiskBps"])
    && typeof value["minimumNetRewardRiskBps"] === "number";
}

function isOpenPosition(value: unknown): boolean {
  return isRecord(value)
    && hasExactKeys(value, ["positionId", "instrumentId", "riskAmountAtStop", "riskGroupIds"])
    && typeof value["positionId"] === "string"
    && typeof value["instrumentId"] === "string"
    && typeof value["riskAmountAtStop"] === "string"
    && isStringArray(value["riskGroupIds"]);
}

function isAccount(value: unknown): value is AccountRiskSnapshotInput {
  return isRecord(value)
    && hasExactKeys(value, ["asOf", "baseCurrency", "currentEquity", "dayStartEquity", "openPositions"])
    && typeof value["asOf"] === "number"
    && typeof value["baseCurrency"] === "string"
    && typeof value["currentEquity"] === "string"
    && typeof value["dayStartEquity"] === "string"
    && isDenseArray(value["openPositions"])
    && value["openPositions"].every(isOpenPosition);
}

function isRiskGroupLimit(value: unknown): boolean {
  return isRecord(value)
    && hasExactKeys(value, ["groupId", "maxRiskBps"])
    && typeof value["groupId"] === "string"
    && typeof value["maxRiskBps"] === "number";
}

function isPortfolioConfig(value: unknown): value is PortfolioRiskConfig {
  return isRecord(value)
    && hasExactKeys(value, [
      "maxRiskPerTradeBps", "maxTotalOpenRiskBps", "maxConcurrentPositions",
      "maxDailyLossBps", "riskGroupLimits",
    ])
    && typeof value["maxRiskPerTradeBps"] === "number"
    && typeof value["maxTotalOpenRiskBps"] === "number"
    && typeof value["maxConcurrentPositions"] === "number"
    && typeof value["maxDailyLossBps"] === "number"
    && isDenseArray(value["riskGroupLimits"])
    && value["riskGroupLimits"].every(isRiskGroupLimit);
}

function isInstrumentSpec(value: unknown): value is LinearInstrumentSizingSpecInput {
  if (!isRecord(value) || !hasExactKeys(value, [
    "valuationModel", "instrumentId", "pnlCurrency", "quantityUnit", "quantityStep",
    "minimumQuantity", "maximumQuantity", "pnlValuePerPriceUnitPerQuantity",
  ])) return false;
  return Object.values(value).every((item) => typeof item === "string");
}

function isFxConversion(value: unknown): value is FxConversionSnapshotInput {
  return isRecord(value)
    && hasExactKeys(value, ["asOf", "fromCurrency", "toCurrency", "rate"])
    && typeof value["asOf"] === "number"
    && typeof value["fromCurrency"] === "string"
    && typeof value["toCurrency"] === "string"
    && typeof value["rate"] === "string";
}

const EXPECTED_INTENT_KEYS = [
  "intentId", "candidateId", "instrumentId", "asOf", "family", "direction",
  "contextTimeframe", "setupTimeframe", "entryReferencePrice", "invalidationPrice",
  "primaryTargetPrice", "quantityUnit", "quantity", "quantityStep", "accountCurrency",
  "pnlCurrency", "conversionRate", "approvedRiskAmount", "actualRiskAmount",
  "unusedRiskAmount", "riskUtilizationBps", "structuralNetRisk", "netRewardRiskBps",
  "minimumRequiredNetRewardRiskBps", "pnlValuePerPriceUnitPerQuantity",
  "riskPerQuantityUnitInAccountCurrency", "riskPerQuantityStep", "cappedByMaximumQuantity",
] as const;

function isExpectedIntent(value: unknown): value is ReadyTradeIntentRecoverySelectorV1 {
  if (!isRecord(value) || !hasExactKeys(value, EXPECTED_INTENT_KEYS)) return false;
  for (const key of EXPECTED_INTENT_KEYS) {
    if (key === "asOf" || key === "minimumRequiredNetRewardRiskBps") {
      if (typeof value[key] !== "number") return false;
    } else if (key === "cappedByMaximumQuantity") {
      if (typeof value[key] !== "boolean") return false;
    } else if (typeof value[key] !== "string") return false;
  }
  return true;
}

function rejected(
  reason: ReadyTradeIntentRestorationRejectionReason,
  upstream?: Readonly<{
    readonly status?: string | undefined;
    readonly reason?: string | undefined;
  }>,
): ReadyTradeIntentRestorationResult {
  return Object.freeze({
    status: "READY_TRADE_INTENT_RESTORATION_REJECTED",
    reason,
    ...(upstream?.status === undefined ? {} : { upstreamStatus: upstream.status }),
    ...(upstream?.reason === undefined ? {} : { upstreamReason: upstream.reason }),
  });
}

function validateEvidence(value: unknown): ValidatedEvidence | ReadyTradeIntentRestorationResult {
  if (!isRecord(value)) return rejected("INVALID_RECOVERY_EVIDENCE");
  if (value["schemaVersion"] !== READY_TRADE_INTENT_RECOVERY_EVIDENCE_SCHEMA_VERSION) {
    return typeof value["schemaVersion"] === "string"
      ? rejected("UNSUPPORTED_RECOVERY_SCHEMA")
      : rejected("INVALID_RECOVERY_EVIDENCE");
  }
  if (!hasExactKeys(value, [
    "schemaVersion", "setupCandidateEvidence", "structuralRisk", "portfolioRisk",
    "positionSizing", "expectedIntent",
  ])) return rejected("INVALID_RECOVERY_EVIDENCE");

  const structural = value["structuralRisk"];
  const portfolio = value["portfolioRisk"];
  const sizing = value["positionSizing"];
  if (!isRecord(value["setupCandidateEvidence"])
      || !isRecord(structural) || !hasExactKeys(structural, ["costs", "config"])
      || !isRiskCosts(structural["costs"]) || !isRiskConfig(structural["config"])
      || !isRecord(portfolio) || !hasExactKeys(portfolio, [
        "account", "requestedRiskAmount", "proposedRiskGroupIds", "config",
      ])
      || !isAccount(portfolio["account"])
      || typeof portfolio["requestedRiskAmount"] !== "string"
      || !isStringArray(portfolio["proposedRiskGroupIds"])
      || !isPortfolioConfig(portfolio["config"])
      || !isRecord(sizing)
      || !hasExactKeys(sizing, sizing["fxConversion"] === undefined
        ? ["instrumentSpec"] : ["instrumentSpec", "fxConversion"])
      || !isInstrumentSpec(sizing["instrumentSpec"])
      || (sizing["fxConversion"] !== undefined && !isFxConversion(sizing["fxConversion"]))
      || !isExpectedIntent(value["expectedIntent"])) {
    return rejected("INVALID_RECOVERY_EVIDENCE");
  }
  return Object.freeze({
    setupCandidateEvidence: value["setupCandidateEvidence"],
    riskCosts: structural["costs"],
    riskConfig: structural["config"],
    account: portfolio["account"],
    requestedRiskAmount: portfolio["requestedRiskAmount"],
    proposedRiskGroupIds: Object.freeze([...portfolio["proposedRiskGroupIds"]]),
    portfolioConfig: portfolio["config"],
    instrumentSpec: sizing["instrumentSpec"],
    ...(sizing["fxConversion"] === undefined ? {} : { fxConversion: sizing["fxConversion"] }),
    expectedIntent: value["expectedIntent"],
  });
}

function upstreamReason(result: object): string | undefined {
  if ("reason" in result && typeof result.reason === "string") return result.reason;
  if ("upstreamReason" in result && typeof result.upstreamReason === "string") return result.upstreamReason;
  return undefined;
}

function matchesExpectedIntent(
  intent: ReadyTradeIntent,
  expected: ReadyTradeIntentRecoverySelectorV1,
): boolean {
  return EXPECTED_INTENT_KEYS.every((key) => intent[key] === expected[key]);
}

export function restoreReadyTradeIntent(
  recoveryEvidence: unknown,
): ReadyTradeIntentRestorationResult {
  const validation = validateEvidence(recoveryEvidence);
  if (!("expectedIntent" in validation)) return validation;

  const setupAuthority = restoreSetupCandidateFromAnalysisEvidence(validation.setupCandidateEvidence);
  if (setupAuthority.status !== "SETUP_CANDIDATE_RESTORED") {
    return rejected("SETUP_RESTORATION_REJECTED", {
      status: setupAuthority.status,
      reason: setupAuthority.reason,
    });
  }

  let costs: Readonly<RiskCostAssumptions>;
  try {
    costs = createRiskCostAssumptions(validation.riskCosts);
  } catch {
    return rejected("INVALID_RISK_COSTS");
  }
  let riskConfig: Readonly<RiskQualificationConfig>;
  try {
    riskConfig = createRiskQualificationConfig(validation.riskConfig);
  } catch {
    return rejected("INVALID_RISK_CONFIG");
  }
  const riskQualification = qualifyStructuralRisk({
    candidate: setupAuthority.candidate,
    structure: setupAuthority.setupStructure,
    setupCandles: setupAuthority.setupCandles,
    costs,
    config: riskConfig,
  });
  if (riskQualification.status !== "QUALIFIED") {
    return rejected("RISK_NOT_QUALIFIED", {
      status: riskQualification.status,
      reason: riskQualification.reason,
    });
  }

  let account;
  try {
    account = createAccountRiskSnapshot(validation.account);
  } catch {
    return rejected("INVALID_PORTFOLIO_ACCOUNT");
  }
  let portfolioConfig: Readonly<PortfolioRiskConfig>;
  try {
    portfolioConfig = createPortfolioRiskConfig(validation.portfolioConfig);
  } catch {
    return rejected("INVALID_PORTFOLIO_CONFIG");
  }
  const portfolioRisk = evaluatePortfolioRisk({
    structuralRiskResult: riskQualification,
    account,
    requestedRiskAmount: validation.requestedRiskAmount,
    proposedRiskGroupIds: validation.proposedRiskGroupIds,
    config: portfolioConfig,
  });
  if (portfolioRisk.status !== "CAPITAL_ELIGIBLE") {
    return rejected("PORTFOLIO_NOT_CAPITAL_ELIGIBLE", {
      status: portfolioRisk.status,
      reason: upstreamReason(portfolioRisk),
    });
  }

  let instrumentSpec;
  try {
    instrumentSpec = createLinearInstrumentSizingSpec(validation.instrumentSpec);
  } catch {
    return rejected("INVALID_SIZING_SPEC");
  }
  let fxConversion;
  if (validation.fxConversion !== undefined) {
    try {
      fxConversion = createFxConversionSnapshot(validation.fxConversion);
    } catch {
      return rejected("INVALID_FX_CONVERSION");
    }
  }
  const sizing = sizePosition({
    structuralRiskResult: riskQualification,
    portfolioRiskResult: portfolioRisk,
    instrumentSpec,
    ...(fxConversion === undefined ? {} : { fxConversion }),
  });
  if (sizing.status !== "SIZED") {
    return rejected("POSITION_NOT_SIZED", {
      status: sizing.status,
      reason: upstreamReason(sizing),
    });
  }

  const tradeIntent: TradeIntentResult = createTradeIntent({
    setupCandidate: setupAuthority.candidate,
    structuralRiskResult: riskQualification,
    portfolioRiskResult: portfolioRisk,
    positionSizingResult: sizing,
  });
  if (tradeIntent.status !== "INTENT_READY") {
    return rejected("TRADE_INTENT_CREATION_REJECTED", {
      status: tradeIntent.status,
      reason: upstreamReason(tradeIntent),
    });
  }
  if (!matchesExpectedIntent(tradeIntent, validation.expectedIntent)) {
    return rejected("EXPECTED_INTENT_IDENTITY_MISMATCH");
  }

  return Object.freeze({
    status: "READY_TRADE_INTENT_RESTORED",
    setupAuthority,
    riskQualification,
    portfolioRisk,
    sizing,
    tradeIntent,
  });
}
