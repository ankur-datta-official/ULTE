import {
  instrumentId,
  positiveDecimalString,
  unixMs,
} from "@ulte/instrument-model";
import { compareDecimal, isExactIntegerMultiple } from "./internal/decimal.js";
import type {
  ExecutionMarketSnapshot,
  ExecutionMarketSnapshotInput,
  ExecutionPreparationConfig,
  InstrumentExecutionSpec,
  InstrumentExecutionSpecInput,
} from "./types.js";

function nonNegativeSafeInteger(value: unknown, field: string, maximum = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > maximum) {
    throw new RangeError(`${field} must be a non-negative safe integer no greater than ${maximum}`);
  }
  return value;
}

export function createExecutionMarketSnapshot(
  input: ExecutionMarketSnapshotInput,
): Readonly<ExecutionMarketSnapshot> {
  const bid = positiveDecimalString(input.bid);
  const ask = positiveDecimalString(input.ask);
  if (compareDecimal(bid, ask) > 0) throw new RangeError("bid must not exceed ask");
  return Object.freeze({
    instrumentId: instrumentId(input.instrumentId),
    asOf: unixMs(input.asOf),
    bid,
    ask,
  });
}

export function createInstrumentExecutionSpec(
  input: InstrumentExecutionSpecInput,
): Readonly<InstrumentExecutionSpec> {
  const priceTick = positiveDecimalString(input.priceTick);
  const quantityStep = positiveDecimalString(input.quantityStep);
  const minimumQuantity = positiveDecimalString(input.minimumQuantity);
  const maximumQuantity = positiveDecimalString(input.maximumQuantity);
  if (compareDecimal(maximumQuantity, minimumQuantity) < 0) {
    throw new RangeError("maximumQuantity must be at least minimumQuantity");
  }
  if (!isExactIntegerMultiple(minimumQuantity, quantityStep)) {
    throw new RangeError("minimumQuantity must be an exact multiple of quantityStep");
  }
  if (!isExactIntegerMultiple(maximumQuantity, quantityStep)) {
    throw new RangeError("maximumQuantity must be an exact multiple of quantityStep");
  }
  return Object.freeze({
    instrumentId: instrumentId(input.instrumentId),
    priceTick,
    quantityStep,
    minimumQuantity,
    maximumQuantity,
  });
}

export function createExecutionPreparationConfig(
  input: ExecutionPreparationConfig,
): Readonly<ExecutionPreparationConfig> {
  return Object.freeze({
    maxIntentAgeMs: nonNegativeSafeInteger(input.maxIntentAgeMs, "maxIntentAgeMs"),
    maxQuoteAgeMs: nonNegativeSafeInteger(input.maxQuoteAgeMs, "maxQuoteAgeMs"),
    maxEntryDeviationBps: nonNegativeSafeInteger(input.maxEntryDeviationBps, "maxEntryDeviationBps", 10_000),
  });
}
