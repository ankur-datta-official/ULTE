import { positiveDecimalString } from "@ulte/instrument-model";
import {
  compare,
  exactIntegerRatio,
  floorRatio,
  multiply,
  multiplyByInteger,
  ratioBpsFloor,
  subtractNonNegative,
} from "./internal/decimal.js";
import { createFxConversionSnapshot, createLinearInstrumentSizingSpec } from "./spec.js";
import type {
  FxConversionSnapshot,
  LinearInstrumentSizingSpec,
  PositionSizingDataRejectionReason,
  PositionSizingInput,
  PositionSizingResult,
} from "./types.js";

type Identity = Pick<PositionSizingResult, "candidateId" | "instrumentId" | "asOf">;

function identity(input: PositionSizingInput): Identity {
  const upstream = input.structuralRiskResult;
  return { candidateId: upstream.candidateId, instrumentId: upstream.instrumentId, asOf: upstream.asOf };
}

function reason(result: object): string | null {
  if ("reason" in result && typeof result.reason === "string") return result.reason;
  if ("upstreamReason" in result && typeof result.upstreamReason === "string") return result.upstreamReason;
  return null;
}

function rejected(input: PositionSizingInput, rejectionReason: PositionSizingDataRejectionReason): PositionSizingResult {
  return Object.freeze({ status: "DATA_REJECTED", ...identity(input), reason: rejectionReason });
}

function validateSpec(input: PositionSizingInput): LinearInstrumentSizingSpec | PositionSizingResult {
  if ((input.instrumentSpec as { readonly valuationModel?: unknown }).valuationModel !== "LINEAR_PRICE_PNL") {
    return rejected(input, "UNSUPPORTED_VALUATION_MODEL");
  }
  try {
    return createLinearInstrumentSizingSpec(input.instrumentSpec);
  } catch {
    return rejected(input, "INVALID_INSTRUMENT_SPEC");
  }
}

function validateConversion(input: PositionSizingInput, spec: LinearInstrumentSizingSpec): FxConversionSnapshot | PositionSizingResult {
  const portfolio = input.portfolioRiskResult;
  if (portfolio.status !== "CAPITAL_ELIGIBLE") throw new Error("Internal upstream gate invariant failed");
  if (spec.pnlCurrency === portfolio.baseCurrency) {
    return Object.freeze({
      asOf: portfolio.asOf,
      fromCurrency: spec.pnlCurrency,
      toCurrency: portfolio.baseCurrency,
      rate: positiveDecimalString("1"),
    });
  }
  if (input.fxConversion === undefined) return rejected(input, "FX_CONVERSION_REQUIRED");
  let conversion: FxConversionSnapshot;
  try {
    conversion = createFxConversionSnapshot(input.fxConversion);
  } catch {
    return rejected(input, "FX_CONVERSION_MISMATCH");
  }
  if (
    conversion.fromCurrency !== spec.pnlCurrency
    || conversion.toCurrency !== portfolio.baseCurrency
    || conversion.asOf !== portfolio.asOf
  ) {
    return rejected(input, "FX_CONVERSION_MISMATCH");
  }
  return conversion;
}

export function sizePosition(input: PositionSizingInput): PositionSizingResult {
  const structural = input.structuralRiskResult;
  const portfolio = input.portfolioRiskResult;
  if (structural.status !== "QUALIFIED" || portfolio.status !== "CAPITAL_ELIGIBLE") {
    return Object.freeze({
      status: "UPSTREAM_NOT_ELIGIBLE",
      ...identity(input),
      structuralStatus: structural.status,
      structuralReason: reason(structural),
      portfolioStatus: portfolio.status,
      portfolioReason: reason(portfolio),
    });
  }
  if (structural.candidateId !== portfolio.candidateId || structural.instrumentId !== portfolio.instrumentId) {
    return rejected(input, "UPSTREAM_IDENTITY_MISMATCH");
  }
  if (structural.asOf !== portfolio.asOf) return rejected(input, "AS_OF_MISMATCH");

  let approvedRiskAmount;
  try {
    approvedRiskAmount = positiveDecimalString(portfolio.requestedRiskAmount);
  } catch {
    return rejected(input, "INVALID_APPROVED_RISK_BUDGET");
  }

  const validatedSpec = validateSpec(input);
  if ("status" in validatedSpec) return validatedSpec;
  if (validatedSpec.instrumentId !== structural.instrumentId) return rejected(input, "INSTRUMENT_SPEC_MISMATCH");

  const validatedConversion = validateConversion(input, validatedSpec);
  if ("status" in validatedConversion) return validatedConversion;

  let structuralNetRisk;
  let riskPerQuantityUnitInAccountCurrency;
  let riskPerQuantityStep;
  try {
    structuralNetRisk = positiveDecimalString(structural.netRisk);
    const riskPerQuantityUnitInPnlCurrency = multiply(
      structuralNetRisk,
      validatedSpec.pnlValuePerPriceUnitPerQuantity,
    );
    riskPerQuantityUnitInAccountCurrency = multiply(riskPerQuantityUnitInPnlCurrency, validatedConversion.rate);
    riskPerQuantityStep = multiply(riskPerQuantityUnitInAccountCurrency, validatedSpec.quantityStep);
  } catch {
    return rejected(input, "INVALID_RISK_PER_QUANTITY");
  }

  const riskBudgetStepCount = floorRatio(approvedRiskAmount, riskPerQuantityStep);
  const minimumQuantityStepCount = exactIntegerRatio(validatedSpec.minimumQuantity, validatedSpec.quantityStep)!;
  if (riskBudgetStepCount < minimumQuantityStepCount) {
    return Object.freeze({
      status: "NOT_SIZEABLE",
      ...identity(input),
      reason: "RISK_BUDGET_BELOW_MINIMUM_QUANTITY",
      approvedRiskAmount,
      minimumQuantity: validatedSpec.minimumQuantity,
      riskPerQuantityStep,
    });
  }

  const maximumQuantityStepCount = exactIntegerRatio(validatedSpec.maximumQuantity, validatedSpec.quantityStep)!;
  const cappedByMaximumQuantity = riskBudgetStepCount > maximumQuantityStepCount;
  const actualStepCount = cappedByMaximumQuantity ? maximumQuantityStepCount : riskBudgetStepCount;
  const sizedQuantity = multiplyByInteger(validatedSpec.quantityStep, actualStepCount);
  const actualRiskAmount = multiply(riskPerQuantityUnitInAccountCurrency, sizedQuantity);
  if (compare(actualRiskAmount, approvedRiskAmount) > 0) {
    throw new Error("Position sizing invariant violated: actual risk exceeds approved risk");
  }
  const unusedRiskAmount = subtractNonNegative(approvedRiskAmount, actualRiskAmount);

  return Object.freeze({
    status: "SIZED",
    ...identity(input),
    quantityUnit: validatedSpec.quantityUnit,
    sizedQuantity,
    quantityStep: validatedSpec.quantityStep,
    minimumQuantity: validatedSpec.minimumQuantity,
    maximumQuantity: validatedSpec.maximumQuantity,
    cappedByMaximumQuantity,
    pnlCurrency: validatedSpec.pnlCurrency,
    accountCurrency: portfolio.baseCurrency,
    conversionRate: validatedConversion.rate,
    approvedRiskAmount,
    structuralNetRisk,
    pnlValuePerPriceUnitPerQuantity: validatedSpec.pnlValuePerPriceUnitPerQuantity,
    riskPerQuantityUnitInAccountCurrency,
    riskPerQuantityStep,
    actualRiskAmount,
    unusedRiskAmount,
    riskUtilizationBps: ratioBpsFloor(actualRiskAmount, approvedRiskAmount),
  });
}
