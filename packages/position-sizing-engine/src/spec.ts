import {
  currencyCode,
  instrumentId,
  positiveDecimalString,
  unixMs,
} from "@ulte/instrument-model";
import { compare, exactIntegerRatio } from "./internal/decimal.js";
import type {
  FxConversionSnapshot,
  FxConversionSnapshotInput,
  LinearInstrumentSizingSpec,
  LinearInstrumentSizingSpecInput,
} from "./types.js";

function quantityUnit(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) {
    throw new TypeError("quantityUnit must be non-empty and have no surrounding whitespace");
  }
  return value;
}

export function createLinearInstrumentSizingSpec(
  input: LinearInstrumentSizingSpecInput,
): Readonly<LinearInstrumentSizingSpec> {
  if (input.valuationModel !== "LINEAR_PRICE_PNL") {
    throw new TypeError(`Unsupported valuation model: ${input.valuationModel}`);
  }
  const quantityStep = positiveDecimalString(input.quantityStep);
  const minimumQuantity = positiveDecimalString(input.minimumQuantity);
  const maximumQuantity = positiveDecimalString(input.maximumQuantity);
  if (compare(maximumQuantity, minimumQuantity) < 0) {
    throw new RangeError("maximumQuantity must be at least minimumQuantity");
  }
  if (exactIntegerRatio(minimumQuantity, quantityStep) === undefined) {
    throw new RangeError("minimumQuantity must be an exact multiple of quantityStep");
  }
  if (exactIntegerRatio(maximumQuantity, quantityStep) === undefined) {
    throw new RangeError("maximumQuantity must be an exact multiple of quantityStep");
  }
  return Object.freeze({
    valuationModel: "LINEAR_PRICE_PNL",
    instrumentId: instrumentId(input.instrumentId),
    pnlCurrency: currencyCode(input.pnlCurrency),
    quantityUnit: quantityUnit(input.quantityUnit),
    quantityStep,
    minimumQuantity,
    maximumQuantity,
    pnlValuePerPriceUnitPerQuantity: positiveDecimalString(input.pnlValuePerPriceUnitPerQuantity),
  });
}

export function createFxConversionSnapshot(input: FxConversionSnapshotInput): Readonly<FxConversionSnapshot> {
  return Object.freeze({
    asOf: unixMs(input.asOf),
    fromCurrency: currencyCode(input.fromCurrency),
    toCurrency: currencyCode(input.toCurrency),
    rate: positiveDecimalString(input.rate),
  });
}
