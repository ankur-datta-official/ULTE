import {
  instrumentId,
  positiveDecimalString,
  unixMs,
  type PositiveDecimalString,
} from "@ulte/instrument-model";
import { createExecutionPlanId } from "./internal/canonical-id.js";
import {
  compareDecimal,
  deviationBpsFloor,
  deviationExceedsBps,
  isExactIntegerMultiple,
} from "./internal/decimal.js";
import {
  EXECUTION_PLAN_SCHEMA_VERSION,
  type ExecutionPreparationDataRejectionReason,
  type ExecutionPreparationInput,
  type ExecutionPreparationResult,
  type FailedPriceField,
  type PlanNotPreparableReason,
  type ReadyExecutionPlan,
} from "./types.js";

function upstreamReason(value: object): string | undefined {
  if ("reason" in value && typeof value.reason === "string") return value.reason;
  if ("upstreamReason" in value && typeof value.upstreamReason === "string") return value.upstreamReason;
  return undefined;
}

function rejected(
  reason: ExecutionPreparationDataRejectionReason,
  candidateId: string,
  tradeIntentId?: string,
): ExecutionPreparationResult {
  return Object.freeze({
    status: "DATA_REJECTED",
    reason,
    candidateId,
    ...(tradeIntentId === undefined ? {} : { tradeIntentId }),
  });
}

function notPreparable(
  reason: PlanNotPreparableReason,
  tradeIntentId: string,
  candidateId: string,
  failedPriceField?: FailedPriceField,
): ExecutionPreparationResult {
  return Object.freeze({
    status: "PLAN_NOT_PREPARABLE",
    reason,
    tradeIntentId,
    candidateId,
    ...(failedPriceField === undefined ? {} : { failedPriceField }),
  });
}

function validConfig(config: ExecutionPreparationInput["config"]): boolean {
  return Number.isSafeInteger(config.maxIntentAgeMs)
    && config.maxIntentAgeMs >= 0
    && Number.isSafeInteger(config.maxQuoteAgeMs)
    && config.maxQuoteAgeMs >= 0
    && Number.isSafeInteger(config.maxEntryDeviationBps)
    && config.maxEntryDeviationBps >= 0
    && config.maxEntryDeviationBps <= 10_000;
}

export function prepareExecutionPlan(input: ExecutionPreparationInput): ExecutionPreparationResult {
  const { tradeIntent } = input;
  if (tradeIntent.status !== "INTENT_READY") {
    const reason = upstreamReason(tradeIntent);
    return Object.freeze({
      status: "UPSTREAM_NOT_READY",
      candidateId: tradeIntent.candidateId,
      tradeIntentStatus: tradeIntent.status,
      ...(reason === undefined ? {} : { tradeIntentReason: reason }),
    });
  }

  let executionAsOf;
  try {
    executionAsOf = unixMs(input.executionAsOf);
  } catch {
    return rejected("FUTURE_TRADE_INTENT", tradeIntent.candidateId, tradeIntent.intentId);
  }

  let bid: PositiveDecimalString;
  let ask: PositiveDecimalString;
  try {
    instrumentId(input.marketSnapshot.instrumentId);
    unixMs(input.marketSnapshot.asOf);
    bid = positiveDecimalString(input.marketSnapshot.bid);
    ask = positiveDecimalString(input.marketSnapshot.ask);
    if (compareDecimal(bid, ask) > 0) throw new RangeError("crossed quote");
  } catch {
    return rejected("INVALID_MARKET_SNAPSHOT", tradeIntent.candidateId, tradeIntent.intentId);
  }

  let priceTick: PositiveDecimalString;
  let quantityStep: PositiveDecimalString;
  let minimumQuantity: PositiveDecimalString;
  let maximumQuantity: PositiveDecimalString;
  try {
    instrumentId(input.instrumentExecutionSpec.instrumentId);
    priceTick = positiveDecimalString(input.instrumentExecutionSpec.priceTick);
    quantityStep = positiveDecimalString(input.instrumentExecutionSpec.quantityStep);
    minimumQuantity = positiveDecimalString(input.instrumentExecutionSpec.minimumQuantity);
    maximumQuantity = positiveDecimalString(input.instrumentExecutionSpec.maximumQuantity);
    if (compareDecimal(maximumQuantity, minimumQuantity) < 0) throw new RangeError("invalid range");
    if (!isExactIntegerMultiple(minimumQuantity, quantityStep)) throw new RangeError("invalid minimum");
    if (!isExactIntegerMultiple(maximumQuantity, quantityStep)) throw new RangeError("invalid maximum");
  } catch {
    return rejected("INVALID_EXECUTION_SPEC", tradeIntent.candidateId, tradeIntent.intentId);
  }

  if (!validConfig(input.config)) {
    return rejected("INVALID_EXECUTION_CONFIG", tradeIntent.candidateId, tradeIntent.intentId);
  }
  if (
    input.marketSnapshot.instrumentId !== tradeIntent.instrumentId
    || input.instrumentExecutionSpec.instrumentId !== tradeIntent.instrumentId
  ) return rejected("INSTRUMENT_MISMATCH", tradeIntent.candidateId, tradeIntent.intentId);

  if (executionAsOf < tradeIntent.asOf) {
    return rejected("FUTURE_TRADE_INTENT", tradeIntent.candidateId, tradeIntent.intentId);
  }
  if (input.marketSnapshot.asOf < tradeIntent.asOf) {
    return notPreparable("QUOTE_PREDATES_TRADE_INTENT", tradeIntent.intentId, tradeIntent.candidateId);
  }
  if (input.marketSnapshot.asOf > executionAsOf) {
    return rejected("FUTURE_MARKET_SNAPSHOT", tradeIntent.candidateId, tradeIntent.intentId);
  }

  const intentAgeMs = executionAsOf - tradeIntent.asOf;
  const quoteAgeMs = executionAsOf - input.marketSnapshot.asOf;
  if (intentAgeMs > input.config.maxIntentAgeMs) {
    return notPreparable("TRADE_INTENT_STALE", tradeIntent.intentId, tradeIntent.candidateId);
  }
  if (quoteAgeMs > input.config.maxQuoteAgeMs) {
    return notPreparable("MARKET_SNAPSHOT_STALE", tradeIntent.intentId, tradeIntent.candidateId);
  }

  let entry: PositiveDecimalString;
  let invalidation: PositiveDecimalString;
  let target: PositiveDecimalString;
  let quantity: PositiveDecimalString;
  try {
    entry = positiveDecimalString(tradeIntent.entryReferencePrice);
    invalidation = positiveDecimalString(tradeIntent.invalidationPrice);
    target = positiveDecimalString(tradeIntent.primaryTargetPrice);
    quantity = positiveDecimalString(tradeIntent.quantity);
  } catch {
    return rejected("INVALID_PRICE_DIRECTION", tradeIntent.candidateId, tradeIntent.intentId);
  }

  const validDirection = tradeIntent.direction === "UP"
    ? compareDecimal(invalidation, entry) < 0 && compareDecimal(entry, target) < 0
    : compareDecimal(target, entry) < 0 && compareDecimal(entry, invalidation) < 0;
  if (!validDirection) return rejected("INVALID_PRICE_DIRECTION", tradeIntent.candidateId, tradeIntent.intentId);

  const prices: readonly (readonly [FailedPriceField, PositiveDecimalString])[] = [
    ["ENTRY", entry],
    ["INVALIDATION", invalidation],
    ["TARGET", target],
  ];
  for (const [field, price] of prices) {
    if (!isExactIntegerMultiple(price, priceTick)) {
      return notPreparable("PRICE_NOT_TICK_ALIGNED", tradeIntent.intentId, tradeIntent.candidateId, field);
    }
  }

  if (compareDecimal(quantity, minimumQuantity) < 0) {
    return notPreparable("QUANTITY_BELOW_MINIMUM", tradeIntent.intentId, tradeIntent.candidateId);
  }
  if (compareDecimal(quantity, maximumQuantity) > 0) {
    return notPreparable("QUANTITY_ABOVE_MAXIMUM", tradeIntent.intentId, tradeIntent.candidateId);
  }
  if (!isExactIntegerMultiple(quantity, quantityStep)) {
    return notPreparable("QUANTITY_NOT_STEP_ALIGNED", tradeIntent.intentId, tradeIntent.candidateId);
  }

  if (tradeIntent.direction === "UP") {
    if (compareDecimal(bid, invalidation) <= 0) {
      return notPreparable("MARKET_ALREADY_INVALIDATED", tradeIntent.intentId, tradeIntent.candidateId);
    }
    if (compareDecimal(ask, target) >= 0) {
      return notPreparable("TARGET_ALREADY_REACHED", tradeIntent.intentId, tradeIntent.candidateId);
    }
  } else {
    if (compareDecimal(ask, invalidation) >= 0) {
      return notPreparable("MARKET_ALREADY_INVALIDATED", tradeIntent.intentId, tradeIntent.candidateId);
    }
    if (compareDecimal(bid, target) <= 0) {
      return notPreparable("TARGET_ALREADY_REACHED", tradeIntent.intentId, tradeIntent.candidateId);
    }
  }

  const entrySide = tradeIntent.direction === "UP" ? "BUY" : "SELL";
  const exitSide = tradeIntent.direction === "UP" ? "SELL" : "BUY";
  const currentExecutablePrice = tradeIntent.direction === "UP" ? ask : bid;
  if (deviationExceedsBps(currentExecutablePrice, entry, input.config.maxEntryDeviationBps)) {
    return notPreparable("ENTRY_DEVIATION_EXCEEDED", tradeIntent.intentId, tradeIntent.candidateId);
  }

  const entryInstruction = Object.freeze({
    kind: "ENTRY_LIMIT" as const,
    side: entrySide,
    price: entry,
    quantity,
    positionEffect: "OPEN" as const,
  });
  const protectiveStopInstruction = Object.freeze({
    kind: "PROTECTIVE_STOP_TRIGGER" as const,
    side: exitSide,
    triggerPrice: invalidation,
    quantity,
    positionEffect: "CLOSE" as const,
  });
  const profitTargetInstruction = Object.freeze({
    kind: "PROFIT_TARGET_LIMIT" as const,
    side: exitSide,
    price: target,
    quantity,
    positionEffect: "CLOSE" as const,
  });
  const executionPlanId = createExecutionPlanId({
    tradeIntentId: tradeIntent.intentId,
    executionAsOf,
    marketSnapshotAsOf: input.marketSnapshot.asOf,
    bid,
    ask,
    entrySide,
    quantity,
    entryPrice: entry,
    stopPrice: invalidation,
    targetPrice: target,
  });

  const plan: ReadyExecutionPlan = {
    status: "EXECUTION_PLAN_READY",
    schemaVersion: EXECUTION_PLAN_SCHEMA_VERSION,
    executionPlanId,
    tradeIntentId: tradeIntent.intentId,
    candidateId: tradeIntent.candidateId,
    instrumentId: tradeIntent.instrumentId,
    intentAsOf: tradeIntent.asOf,
    marketSnapshotAsOf: input.marketSnapshot.asOf,
    preparedAsOf: executionAsOf,
    direction: tradeIntent.direction,
    entrySide,
    exitSide,
    quantity,
    quantityUnit: tradeIntent.quantityUnit,
    entryInstruction,
    protectiveStopInstruction,
    profitTargetInstruction,
    priceTick,
    quantityStep,
    bidAtPreparation: bid,
    askAtPreparation: ask,
    intentAgeMs,
    quoteAgeMs,
    entryDeviationBps: deviationBpsFloor(currentExecutablePrice, entry),
    approvedRiskAmount: tradeIntent.approvedRiskAmount,
    actualRiskAmount: tradeIntent.actualRiskAmount,
    netRewardRiskBps: tradeIntent.netRewardRiskBps,
  };
  return Object.freeze(plan);
}
