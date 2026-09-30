import { unixMs } from "@ulte/instrument-model";
import { restoreReadyTradeIntent } from "@ulte/trade-intent-engine";
import {
  createExecutionMarketSnapshot,
  createExecutionPreparationConfig,
  createInstrumentExecutionSpec,
} from "./contracts.js";
import { prepareExecutionPlan } from "./evaluator.js";
import {
  READY_EXECUTION_PLAN_RECOVERY_DATA_SCHEMA_VERSION,
  type ExecutionMarketSnapshotInput,
  type ExecutionPreparationConfig,
  type InstrumentExecutionSpecInput,
  type ReadyExecutionPlan,
  type ReadyExecutionPlanRecoverySelectorV2,
  type ReadyExecutionPlanRestorationResult,
} from "./types.js";

type DataRecord = Readonly<Record<string, unknown>>;

interface ValidatedRecoveryData {
  readonly tradeIntentEvidence: unknown;
  readonly marketSnapshot: ExecutionMarketSnapshotInput;
  readonly instrumentExecutionSpec: InstrumentExecutionSpecInput;
  readonly config: ExecutionPreparationConfig;
  readonly executionAsOf: number;
  readonly expectedPlan: ReadyExecutionPlanRecoverySelectorV2;
}

const EXPECTED_PLAN_KEYS = [
  "executionPlanId", "tradeIntentId", "candidateId", "instrumentId", "intentAsOf",
  "marketSnapshotAsOf", "preparedAsOf", "direction", "entrySide", "exitSide", "quantity",
  "quantityUnit", "accountCurrency", "entryInstruction", "protectiveStopInstruction",
  "profitTargetInstruction", "priceTick", "quantityStep", "bidAtPreparation", "askAtPreparation",
  "intentAgeMs", "quoteAgeMs", "entryDeviationBps", "approvedRiskAmount", "actualRiskAmount",
  "netRewardRiskBps",
] as const;

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

function isPlainJsonData(value: unknown, ancestors: ReadonlySet<object> = new Set()): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object" || ancestors.has(value)) return false;
  if (Object.getPrototypeOf(value) !== Object.prototype && !Array.isArray(value)) return false;
  const nextAncestors = new Set(ancestors);
  nextAncestors.add(value);
  if (Array.isArray(value)) {
    return isDenseArray(value) && value.every((item) => isPlainJsonData(item, nextAncestors));
  }
  return Object.values(value).every((item) => isPlainJsonData(item, nextAncestors));
}

function isMarketSnapshotInput(value: unknown): value is ExecutionMarketSnapshotInput {
  return isRecord(value)
    && hasExactKeys(value, ["instrumentId", "asOf", "bid", "ask"])
    && typeof value["instrumentId"] === "string"
    && typeof value["asOf"] === "number"
    && typeof value["bid"] === "string"
    && typeof value["ask"] === "string";
}

function isInstrumentSpecInput(value: unknown): value is InstrumentExecutionSpecInput {
  return isRecord(value)
    && hasExactKeys(value, [
      "instrumentId", "priceTick", "quantityStep", "minimumQuantity", "maximumQuantity",
    ])
    && Object.values(value).every((item) => typeof item === "string");
}

function isConfig(value: unknown): value is ExecutionPreparationConfig {
  return isRecord(value)
    && hasExactKeys(value, ["maxIntentAgeMs", "maxQuoteAgeMs", "maxEntryDeviationBps"])
    && Object.values(value).every((item) => typeof item === "number");
}

function isEntryInstruction(input: unknown): input is ReadyExecutionPlanRecoverySelectorV2["entryInstruction"] {
  return isRecord(input)
    && hasExactKeys(input, ["kind", "side", "price", "quantity", "positionEffect"])
    && input["kind"] === "ENTRY_LIMIT"
    && (input["side"] === "BUY" || input["side"] === "SELL")
    && typeof input["price"] === "string"
    && typeof input["quantity"] === "string"
    && input["positionEffect"] === "OPEN";
}

function isStopInstruction(input: unknown): input is ReadyExecutionPlanRecoverySelectorV2["protectiveStopInstruction"] {
  return isRecord(input)
    && hasExactKeys(input, ["kind", "side", "triggerPrice", "quantity", "positionEffect"])
    && input["kind"] === "PROTECTIVE_STOP_TRIGGER"
    && (input["side"] === "BUY" || input["side"] === "SELL")
    && typeof input["triggerPrice"] === "string"
    && typeof input["quantity"] === "string"
    && input["positionEffect"] === "CLOSE";
}

function isTargetInstruction(input: unknown): input is ReadyExecutionPlanRecoverySelectorV2["profitTargetInstruction"] {
  return isRecord(input)
    && hasExactKeys(input, ["kind", "side", "price", "quantity", "positionEffect"])
    && input["kind"] === "PROFIT_TARGET_LIMIT"
    && (input["side"] === "BUY" || input["side"] === "SELL")
    && typeof input["price"] === "string"
    && typeof input["quantity"] === "string"
    && input["positionEffect"] === "CLOSE";
}

function isExpectedPlan(input: unknown): input is ReadyExecutionPlanRecoverySelectorV2 {
  if (!isRecord(input) || !hasExactKeys(input, EXPECTED_PLAN_KEYS)
      || !isEntryInstruction(input["entryInstruction"])
      || !isStopInstruction(input["protectiveStopInstruction"])
      || !isTargetInstruction(input["profitTargetInstruction"])) return false;
  for (const key of EXPECTED_PLAN_KEYS) {
    if (key === "intentAsOf" || key === "marketSnapshotAsOf" || key === "preparedAsOf"
        || key === "intentAgeMs" || key === "quoteAgeMs") {
      if (typeof input[key] !== "number") return false;
    } else if (key === "entryInstruction" || key === "protectiveStopInstruction"
        || key === "profitTargetInstruction") {
      continue;
    } else if (typeof input[key] !== "string") return false;
  }
  return true;
}

function rejected(
  reason: Extract<ReadyExecutionPlanRestorationResult, {
    readonly status: "READY_EXECUTION_PLAN_RESTORATION_REJECTED";
  }>["reason"],
  upstream?: Readonly<{
    readonly status?: string;
    readonly reason?: string;
    readonly failedPriceField?: "ENTRY" | "INVALIDATION" | "TARGET";
  }>,
): ReadyExecutionPlanRestorationResult {
  return Object.freeze({
    status: "READY_EXECUTION_PLAN_RESTORATION_REJECTED",
    reason,
    ...(upstream?.status === undefined ? {} : { upstreamStatus: upstream.status }),
    ...(upstream?.reason === undefined ? {} : { upstreamReason: upstream.reason }),
    ...(upstream?.failedPriceField === undefined
      ? {}
      : { upstreamFailedPriceField: upstream.failedPriceField }),
  });
}

function validateRecoveryData(value: unknown): ValidatedRecoveryData | ReadyExecutionPlanRestorationResult {
  if (!isRecord(value)) return rejected("INVALID_READY_EXECUTION_PLAN_RECOVERY_DATA");
  if (value["recoverySchemaVersion"] !== READY_EXECUTION_PLAN_RECOVERY_DATA_SCHEMA_VERSION) {
    return typeof value["recoverySchemaVersion"] === "string"
      ? rejected("UNSUPPORTED_READY_EXECUTION_PLAN_RECOVERY_SCHEMA")
      : rejected("INVALID_READY_EXECUTION_PLAN_RECOVERY_DATA");
  }
  if (!isPlainJsonData(value)
      || !hasExactKeys(value, [
        "recoverySchemaVersion", "tradeIntentEvidence", "marketSnapshot", "instrumentExecutionSpec",
        "config", "executionAsOf", "expectedPlan",
      ])
      || !isRecord(value["tradeIntentEvidence"])
      || !isMarketSnapshotInput(value["marketSnapshot"])
      || !isInstrumentSpecInput(value["instrumentExecutionSpec"])
      || !isConfig(value["config"])
      || typeof value["executionAsOf"] !== "number"
      || !isExpectedPlan(value["expectedPlan"])) {
    return rejected("INVALID_READY_EXECUTION_PLAN_RECOVERY_DATA");
  }
  return Object.freeze({
    tradeIntentEvidence: value["tradeIntentEvidence"],
    marketSnapshot: value["marketSnapshot"],
    instrumentExecutionSpec: value["instrumentExecutionSpec"],
    config: value["config"],
    executionAsOf: value["executionAsOf"],
    expectedPlan: value["expectedPlan"],
  });
}

function authorityReason(value: object): string | undefined {
  if ("reason" in value && typeof value.reason === "string") return value.reason;
  if ("upstreamReason" in value && typeof value.upstreamReason === "string") return value.upstreamReason;
  return undefined;
}

function matchesEntryInstruction(
  actual: ReadyExecutionPlanRecoverySelectorV2["entryInstruction"],
  expected: ReadyExecutionPlanRecoverySelectorV2["entryInstruction"],
): boolean {
  return actual.kind === expected.kind && actual.side === expected.side && actual.price === expected.price
    && actual.quantity === expected.quantity && actual.positionEffect === expected.positionEffect;
}

function matchesStopInstruction(
  actual: ReadyExecutionPlanRecoverySelectorV2["protectiveStopInstruction"],
  expected: ReadyExecutionPlanRecoverySelectorV2["protectiveStopInstruction"],
): boolean {
  return actual.kind === expected.kind && actual.side === expected.side
    && actual.triggerPrice === expected.triggerPrice && actual.quantity === expected.quantity
    && actual.positionEffect === expected.positionEffect;
}

function matchesTargetInstruction(
  actual: ReadyExecutionPlanRecoverySelectorV2["profitTargetInstruction"],
  expected: ReadyExecutionPlanRecoverySelectorV2["profitTargetInstruction"],
): boolean {
  return actual.kind === expected.kind && actual.side === expected.side && actual.price === expected.price
    && actual.quantity === expected.quantity && actual.positionEffect === expected.positionEffect;
}

function matchesExpectedPlan(
  plan: ReadyExecutionPlan,
  expected: ReadyExecutionPlanRecoverySelectorV2,
): boolean {
  return EXPECTED_PLAN_KEYS.every((key) => {
    if (key === "entryInstruction") return matchesEntryInstruction(plan[key], expected[key]);
    if (key === "protectiveStopInstruction") return matchesStopInstruction(plan[key], expected[key]);
    if (key === "profitTargetInstruction") return matchesTargetInstruction(plan[key], expected[key]);
    return plan[key] === expected[key];
  });
}

/** Replays normal preparation authority from complete historical inputs. */
export function restoreReadyExecutionPlan(value: unknown): ReadyExecutionPlanRestorationResult {
  const validation = validateRecoveryData(value);
  if (!("expectedPlan" in validation)) return validation;

  const tradeIntentRestoration = restoreReadyTradeIntent(validation.tradeIntentEvidence);
  if (tradeIntentRestoration.status !== "READY_TRADE_INTENT_RESTORED") {
    return rejected("READY_TRADE_INTENT_RESTORATION_REJECTED", {
      status: tradeIntentRestoration.status,
      reason: tradeIntentRestoration.reason,
    });
  }

  let marketSnapshot;
  try {
    marketSnapshot = createExecutionMarketSnapshot(validation.marketSnapshot);
  } catch {
    return rejected("INVALID_EXECUTION_MARKET_SNAPSHOT");
  }
  let instrumentExecutionSpec;
  try {
    instrumentExecutionSpec = createInstrumentExecutionSpec(validation.instrumentExecutionSpec);
  } catch {
    return rejected("INVALID_INSTRUMENT_EXECUTION_SPEC");
  }
  let config;
  try {
    config = createExecutionPreparationConfig(validation.config);
  } catch {
    return rejected("INVALID_EXECUTION_PREPARATION_CONFIG");
  }
  let executionAsOf;
  try {
    executionAsOf = unixMs(validation.executionAsOf);
  } catch {
    return rejected("INVALID_EXECUTION_AS_OF");
  }

  const preparationInput = Object.freeze({
    tradeIntent: tradeIntentRestoration.tradeIntent,
    executionAsOf,
    marketSnapshot,
    instrumentExecutionSpec,
    config,
  });
  const executionPlan = prepareExecutionPlan(preparationInput);
  if (executionPlan.status !== "EXECUTION_PLAN_READY") {
    const reason = authorityReason(executionPlan);
    return rejected("EXECUTION_PLAN_NOT_READY", {
      status: executionPlan.status,
      ...(reason === undefined ? {} : { reason }),
      ...("failedPriceField" in executionPlan
        ? { failedPriceField: executionPlan.failedPriceField }
        : {}),
    });
  }
  if (!matchesExpectedPlan(executionPlan, validation.expectedPlan)) {
    return rejected("EXPECTED_EXECUTION_PLAN_MISMATCH");
  }
  return Object.freeze({
    status: "READY_EXECUTION_PLAN_RESTORED",
    tradeIntentRestoration,
    preparationInput,
    preparationResult: executionPlan,
    executionPlan,
  });
}
