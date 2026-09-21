import { describe, expect, it } from "vitest";
import { createInstrumentId, currencyCode, unixMs } from "@ulte/instrument-model";
import type { CapitalEligibleResult, PortfolioRiskResult } from "@ulte/portfolio-risk-engine";
import type { QualifiedRiskResult, RiskQualificationResult } from "@ulte/risk-engine";
import {
  createFxConversionSnapshot,
  createLinearInstrumentSizingSpec,
  sizePosition,
  type LinearInstrumentSizingSpec,
  type PositionSizingInput,
  type SizedPositionResult,
} from "./index.js";

const instrument = createInstrumentId({ venue: "TEST", venueSymbol: "ABC", instrumentKind: "CFD" });
const otherInstrument = createInstrumentId({ venue: "TEST", venueSymbol: "XYZ", instrumentKind: "CFD" });
const asOf = unixMs(1_000);

function structural(overrides: Partial<QualifiedRiskResult> = {}): QualifiedRiskResult {
  return {
    status: "QUALIFIED",
    candidateId: "candidate-1",
    instrumentId: instrument,
    asOf,
    grossRisk: "1",
    netRisk: "2",
    ...overrides,
  } as QualifiedRiskResult;
}

function ineligibleStructural(status: "NOT_QUALIFIED" | "DATA_REJECTED"): RiskQualificationResult {
  return {
    status,
    candidateId: "candidate-1",
    instrumentId: instrument,
    asOf,
    reason: status === "NOT_QUALIFIED" ? "NET_RR_BELOW_MINIMUM" : "DATA_GAP",
  } as RiskQualificationResult;
}

function portfolio(overrides: Partial<CapitalEligibleResult> = {}): CapitalEligibleResult {
  return {
    status: "CAPITAL_ELIGIBLE",
    candidateId: "candidate-1",
    instrumentId: instrument,
    asOf,
    baseCurrency: currencyCode("USD"),
    requestedRiskAmount: "100",
    maximumAdditionalRiskAmount: "999999",
    ...overrides,
  } as CapitalEligibleResult;
}

function ineligiblePortfolio(status: "BLOCKED" | "DATA_REJECTED" | "UPSTREAM_NOT_QUALIFIED"): PortfolioRiskResult {
  if (status === "UPSTREAM_NOT_QUALIFIED") {
    return {
      status,
      candidateId: "candidate-1",
      instrumentId: instrument,
      asOf,
      upstreamStatus: "NOT_QUALIFIED",
      upstreamReason: "NET_RR_BELOW_MINIMUM",
    } as PortfolioRiskResult;
  }
  return {
    status,
    candidateId: "candidate-1",
    instrumentId: instrument,
    asOf,
    reason: status === "BLOCKED" ? "PER_TRADE_RISK_LIMIT_EXCEEDED" : "INVALID_REQUESTED_RISK",
  } as PortfolioRiskResult;
}

function spec(overrides: Partial<LinearInstrumentSizingSpec> = {}): LinearInstrumentSizingSpec {
  return createLinearInstrumentSizingSpec({
    valuationModel: "LINEAR_PRICE_PNL",
    instrumentId: instrument,
    pnlCurrency: "USD",
    quantityUnit: "contract",
    quantityStep: "0.001",
    minimumQuantity: "0.001",
    maximumQuantity: "100",
    pnlValuePerPriceUnitPerQuantity: "10",
    ...overrides,
  });
}

function fixture(overrides: Partial<PositionSizingInput> = {}): PositionSizingInput {
  return {
    structuralRiskResult: structural(),
    portfolioRiskResult: portfolio(),
    instrumentSpec: spec(),
    ...overrides,
  };
}

function sized(overrides: Partial<PositionSizingInput> = {}): SizedPositionResult {
  const result = sizePosition(fixture(overrides));
  expect(result.status).toBe("SIZED");
  return result as SizedPositionResult;
}

describe("upstream eligibility and identity", () => {
  it.each(["NOT_QUALIFIED", "DATA_REJECTED"] as const)("does not size structural %s", (status) => {
    expect(sizePosition(fixture({ structuralRiskResult: ineligibleStructural(status) }))).toEqual(expect.objectContaining({
      status: "UPSTREAM_NOT_ELIGIBLE",
      structuralStatus: status,
      structuralReason: status === "NOT_QUALIFIED" ? "NET_RR_BELOW_MINIMUM" : "DATA_GAP",
    }));
  });

  it.each(["BLOCKED", "DATA_REJECTED", "UPSTREAM_NOT_QUALIFIED"] as const)(
    "does not size portfolio %s",
    (status) => {
      expect(sizePosition(fixture({ portfolioRiskResult: ineligiblePortfolio(status) }))).toEqual(expect.objectContaining({
        status: "UPSTREAM_NOT_ELIGIBLE",
        portfolioStatus: status,
        portfolioReason: status === "UPSTREAM_NOT_QUALIFIED"
          ? "NET_RR_BELOW_MINIMUM"
          : status === "BLOCKED"
            ? "PER_TRADE_RISK_LIMIT_EXCEEDED"
            : "INVALID_REQUESTED_RISK",
      }));
    },
  );

  it("rejects candidate, instrument, and timestamp inconsistencies with focused reasons", () => {
    expect(sizePosition(fixture({ portfolioRiskResult: portfolio({ candidateId: "other" }) }))).toEqual(
      expect.objectContaining({ status: "DATA_REJECTED", reason: "UPSTREAM_IDENTITY_MISMATCH" }),
    );
    expect(sizePosition(fixture({ portfolioRiskResult: portfolio({ instrumentId: otherInstrument }) }))).toEqual(
      expect.objectContaining({ reason: "UPSTREAM_IDENTITY_MISMATCH" }),
    );
    expect(sizePosition(fixture({ portfolioRiskResult: portfolio({ asOf: unixMs(999) }) }))).toEqual(
      expect.objectContaining({ reason: "AS_OF_MISMATCH" }),
    );
    expect(sizePosition(fixture({ instrumentSpec: spec({ instrumentId: otherInstrument }) }))).toEqual(
      expect.objectContaining({ reason: "INSTRUMENT_SPEC_MISMATCH" }),
    );
  });
});

describe("instrument sizing specification", () => {
  it("constructs an immutable explicit linear spec", () => {
    const sizingSpec = spec();
    expect(sizingSpec).toEqual(expect.objectContaining({
      valuationModel: "LINEAR_PRICE_PNL",
      quantityUnit: "contract",
      pnlValuePerPriceUnitPerQuantity: "10",
    }));
    expect(Object.isFrozen(sizingSpec)).toBe(true);
    expect("leverage" in sizingSpec).toBe(false);
  });

  it("rejects unsupported valuation models distinctly at evaluation", () => {
    const unsupported = { ...spec(), valuationModel: "INVERSE_PNL" } as unknown as LinearInstrumentSizingSpec;
    expect(sizePosition(fixture({ instrumentSpec: unsupported }))).toEqual(
      expect.objectContaining({ status: "DATA_REJECTED", reason: "UNSUPPORTED_VALUATION_MODEL" }),
    );
  });

  it.each([
    ["quantityStep", "0"],
    ["quantityStep", "-0.01"],
    ["minimumQuantity", "0"],
    ["pnlValuePerPriceUnitPerQuantity", "0"],
  ] as const)("rejects invalid %s %s", (field, value) => {
    expect(() => createLinearInstrumentSizingSpec({ ...spec(), [field]: value })).toThrow();
  });

  it("rejects malformed units, reversed ranges, and non-step-aligned boundaries", () => {
    expect(() => createLinearInstrumentSizingSpec({ ...spec(), quantityUnit: " lot" })).toThrow();
    expect(() => createLinearInstrumentSizingSpec({ ...spec(), minimumQuantity: "2", maximumQuantity: "1" })).toThrow();
    expect(() => createLinearInstrumentSizingSpec({ ...spec(), quantityStep: "0.3", minimumQuantity: "1" })).toThrow();
    expect(() => createLinearInstrumentSizingSpec({ ...spec(), quantityStep: "0.3", minimumQuantity: "0.3", maximumQuantity: "1" })).toThrow();
  });

  it("returns INVALID_INSTRUMENT_SPEC for a forged malformed public input", () => {
    const malformed = { ...spec(), quantityStep: "0" } as LinearInstrumentSizingSpec;
    expect(sizePosition(fixture({ instrumentSpec: malformed }))).toEqual(
      expect.objectContaining({ status: "DATA_REJECTED", reason: "INVALID_INSTRUMENT_SPEC" }),
    );
  });
});

describe("currency conversion", () => {
  it("uses conversion rate exactly 1 for matching currencies", () => {
    expect(sized().conversionRate).toBe("1");
  });

  it("requires an explicit exact timestamped conversion and applies it without inversion", () => {
    const eurSpec = spec({ pnlCurrency: currencyCode("EUR"), quantityStep: "0.1", minimumQuantity: "0.1" });
    expect(sizePosition(fixture({ instrumentSpec: eurSpec }))).toEqual(
      expect.objectContaining({ status: "DATA_REJECTED", reason: "FX_CONVERSION_REQUIRED" }),
    );
    const fxConversion = createFxConversionSnapshot({
      asOf,
      fromCurrency: "EUR",
      toCurrency: "USD",
      rate: "1.5",
    });
    const result = sized({
      instrumentSpec: eurSpec,
      portfolioRiskResult: portfolio({ requestedRiskAmount: "10" }),
      fxConversion,
    });
    expect(result).toEqual(expect.objectContaining({
      conversionRate: "1.5",
      riskPerQuantityUnitInAccountCurrency: "30",
      riskPerQuantityStep: "3",
      sizedQuantity: "0.3",
      actualRiskAmount: "9",
    }));
    expect(Object.isFrozen(fxConversion)).toBe(true);
  });

  it.each([
    { fromCurrency: "GBP", toCurrency: "USD", asOf, rate: "1.5" },
    { fromCurrency: "EUR", toCurrency: "GBP", asOf, rate: "1.5" },
    { fromCurrency: "EUR", toCurrency: "USD", asOf: unixMs(999), rate: "1.5" },
    { fromCurrency: "EUR", toCurrency: "USD", asOf, rate: "0" },
    { fromCurrency: "EUR", toCurrency: "USD", asOf, rate: "-1" },
  ])("rejects a mismatched or non-positive FX snapshot", (fxConversion) => {
    const eurSpec = spec({ pnlCurrency: currencyCode("EUR") });
    expect(sizePosition(fixture({
      instrumentSpec: eurSpec,
      fxConversion: fxConversion as PositionSizingInput["fxConversion"],
    }))).toEqual(expect.objectContaining({ status: "DATA_REJECTED", reason: "FX_CONVERSION_MISMATCH" }));
  });
});

describe("exact conservative quantity sizing", () => {
  it("calculates exact per-unit and per-step risk from structural netRisk", () => {
    expect(sized()).toEqual(expect.objectContaining({
      structuralNetRisk: "2",
      pnlValuePerPriceUnitPerQuantity: "10",
      riskPerQuantityUnitInAccountCurrency: "20",
      riskPerQuantityStep: "0.02",
    }));
  });

  it("rejects invalid forged approved risk and structural net risk", () => {
    expect(sizePosition(fixture({ portfolioRiskResult: portfolio({ requestedRiskAmount: "0" }) }))).toEqual(
      expect.objectContaining({ status: "DATA_REJECTED", reason: "INVALID_APPROVED_RISK_BUDGET" }),
    );
    expect(sizePosition(fixture({ structuralRiskResult: structural({ netRisk: "0" }) }))).toEqual(
      expect.objectContaining({ status: "DATA_REJECTED", reason: "INVALID_RISK_PER_QUANTITY" }),
    );
  });

  it("uses approved requested risk rather than informational maximum additional capacity", () => {
    const result = sized({
      portfolioRiskResult: portfolio({ requestedRiskAmount: "20", maximumAdditionalRiskAmount: "1" }),
      instrumentSpec: spec({ quantityStep: "1", minimumQuantity: "1", maximumQuantity: "100" }),
    });
    expect(result).toEqual(expect.objectContaining({
      approvedRiskAmount: "20",
      sizedQuantity: "1",
      actualRiskAmount: "20",
    }));
  });

  it("supports integer steps", () => {
    const result = sized({
      structuralRiskResult: structural({ netRisk: "2" }),
      portfolioRiskResult: portfolio({ requestedRiskAmount: "45" }),
      instrumentSpec: spec({ quantityStep: "1", minimumQuantity: "1", maximumQuantity: "100" }),
    });
    expect(result.sizedQuantity).toBe("2");
    expect(result.actualRiskAmount).toBe("40");
  });

  it("mandatorily floors a 0.0069 safe quantity to 0.006 and never 0.007", () => {
    const result = sized({
      structuralRiskResult: structural({ netRisk: "1" }),
      portfolioRiskResult: portfolio({ requestedRiskAmount: "0.0069" }),
      instrumentSpec: spec({ pnlValuePerPriceUnitPerQuantity: "1" }),
    });
    expect(result.sizedQuantity).toBe("0.006");
    expect(result.sizedQuantity).not.toBe("0.007");
    expect(result.actualRiskAmount).toBe("0.006");
    expect(result.actualRiskAmount.localeCompare(result.approvedRiskAmount)).not.toBe(1);
  });

  it("floors a 0.01 step at 1.99 for a 1.999 raw safe quantity", () => {
    const result = sized({
      structuralRiskResult: structural({ netRisk: "1" }),
      portfolioRiskResult: portfolio({ requestedRiskAmount: "1.999" }),
      instrumentSpec: spec({
        quantityStep: "0.01",
        minimumQuantity: "0.01",
        maximumQuantity: "100",
        pnlValuePerPriceUnitPerQuantity: "1",
      }),
    });
    expect(result.sizedQuantity).toBe("1.99");
    expect(result.actualRiskAmount).toBe("1.99");
  });

  it("drops exactly one step after a microscopic budget reduction", () => {
    const exact = sized({ portfolioRiskResult: portfolio({ requestedRiskAmount: "0.1" }) });
    const below = sized({ portfolioRiskResult: portfolio({ requestedRiskAmount: "0.099999999999999999" }) });
    expect(exact.sizedQuantity).toBe("0.005");
    expect(below.sizedQuantity).toBe("0.004");
  });

  it("returns NOT_SIZEABLE instead of rounding up to a risk-unsafe minimum", () => {
    const result = sizePosition(fixture({
      structuralRiskResult: structural({ netRisk: "1" }),
      portfolioRiskResult: portfolio({ requestedRiskAmount: "1.9" }),
      instrumentSpec: spec({
        quantityStep: "1",
        minimumQuantity: "2",
        maximumQuantity: "10",
        pnlValuePerPriceUnitPerQuantity: "1",
      }),
    }));
    expect(result).toEqual(expect.objectContaining({
      status: "NOT_SIZEABLE",
      reason: "RISK_BUDGET_BELOW_MINIMUM_QUANTITY",
      minimumQuantity: "2",
    }));
  });

  it("caps at maximum quantity conservatively", () => {
    const result = sized({
      structuralRiskResult: structural({ netRisk: "1" }),
      instrumentSpec: spec({ quantityStep: "1", minimumQuantity: "1", maximumQuantity: "5" }),
    });
    expect(result).toEqual(expect.objectContaining({
      sizedQuantity: "5",
      cappedByMaximumQuantity: true,
      actualRiskAmount: "50",
      unusedRiskAmount: "50",
    }));
  });

  it("reports no cap, exact unused risk, full utilization, and deterministic floored partial utilization", () => {
    const full = sized();
    expect(full).toEqual(expect.objectContaining({
      cappedByMaximumQuantity: false,
      actualRiskAmount: "100",
      unusedRiskAmount: "0",
      riskUtilizationBps: "10000",
    }));
    const partial = sized({ portfolioRiskResult: portfolio({ requestedRiskAmount: "0.138" }) });
    expect(partial).toEqual(expect.objectContaining({
      actualRiskAmount: "0.12",
      unusedRiskAmount: "0.018",
      riskUtilizationBps: "8695",
    }));
  });

  it("uses netRisk rather than grossRisk and does not recompute upstream costs", () => {
    const result = sized({
      structuralRiskResult: structural({ grossRisk: "100", netRisk: "2", entryCost: "999" }),
      portfolioRiskResult: portfolio({ requestedRiskAmount: "20" }),
      instrumentSpec: spec({ quantityStep: "1", minimumQuantity: "1", maximumQuantity: "100" }),
    });
    expect(result).toEqual(expect.objectContaining({
      structuralNetRisk: "2",
      riskPerQuantityUnitInAccountCurrency: "20",
      sizedQuantity: "1",
    }));
  });
});

describe("decimal extremes and determinism", () => {
  it("keeps 0.1 by 0.2 arithmetic exact", () => {
    const result = sized({
      structuralRiskResult: structural({ netRisk: "0.1" }),
      portfolioRiskResult: portfolio({ requestedRiskAmount: "0.006" }),
      instrumentSpec: spec({
        quantityStep: "0.1",
        minimumQuantity: "0.1",
        maximumQuantity: "1",
        pnlValuePerPriceUnitPerQuantity: "0.2",
      }),
    });
    expect(result).toEqual(expect.objectContaining({
      riskPerQuantityUnitInAccountCurrency: "0.02",
      riskPerQuantityStep: "0.002",
      sizedQuantity: "0.3",
      actualRiskAmount: "0.006",
    }));
  });

  it("supports very small and very large exact decimals without exponent output", () => {
    const tiny = sized({
      structuralRiskResult: structural({ netRisk: "0.000000000000000001" }),
      portfolioRiskResult: portfolio({ requestedRiskAmount: "0.000000000000000001" }),
      instrumentSpec: spec({
        quantityStep: "0.000000001",
        minimumQuantity: "0.000000001",
        maximumQuantity: "1",
        pnlValuePerPriceUnitPerQuantity: "1000000000",
      }),
    });
    expect(tiny.actualRiskAmount).toBe("0.000000000000000001");
    const huge = sized({
      structuralRiskResult: structural({ netRisk: "100000000000000000000" }),
      portfolioRiskResult: portfolio({ requestedRiskAmount: "1000000000000000000000000000000" }),
      instrumentSpec: spec({
        quantityStep: "1",
        minimumQuantity: "1",
        maximumQuantity: "10000000000",
        pnlValuePerPriceUnitPerQuantity: "1",
      }),
    });
    expect(huge.sizedQuantity).toBe("10000000000");
    for (const value of [tiny.actualRiskAmount, huge.actualRiskAmount, huge.sizedQuantity]) {
      expect(value).not.toMatch(/[eE]/);
    }
  });

  it("does not mutate callers and returns frozen, deeply equivalent deterministic results", () => {
    const input = fixture();
    const before = JSON.stringify(input);
    const first = sizePosition(input);
    const second = sizePosition(input);
    expect(JSON.stringify(input)).toBe(before);
    expect(first).toEqual(second);
    expect(Object.isFrozen(first)).toBe(true);
  });
});
