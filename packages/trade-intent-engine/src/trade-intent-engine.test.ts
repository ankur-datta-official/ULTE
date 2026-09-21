import { describe, expect, it } from "vitest";
import { createInstrumentId, currencyCode, parseTimeframe, unixMs } from "@ulte/instrument-model";
import type { CapitalEligibleResult, PortfolioRiskResult } from "@ulte/portfolio-risk-engine";
import type { PositionSizingResult, SizedPositionResult } from "@ulte/position-sizing-engine";
import type { QualifiedRiskResult, RiskQualificationResult } from "@ulte/risk-engine";
import type { SetupCandidate } from "@ulte/setup-engine";
import { encodeLengthPrefixed } from "./internal/canonical-id.js";
import { createTradeIntent, type TradeIntentInput } from "./index.js";

const instrument = createInstrumentId({ venue: "TEST", venueSymbol: "ABC", instrumentKind: "CFD" });
const otherInstrument = createInstrumentId({ venue: "TEST", venueSymbol: "XYZ", instrumentKind: "CFD" });
const asOf = unixMs(1_000);
const contextTimeframe = parseTimeframe("1d");
const setupTimeframe = parseTimeframe("4h");

function setup(overrides: Partial<SetupCandidate> = {}): SetupCandidate {
  return {
    id: "candidate-1",
    family: "TREND_PULLBACK_CONTINUATION",
    direction: "UP",
    stage: "CONFIRMED",
    instrumentId: instrument,
    contextTimeframe,
    setupTimeframe,
    asOf,
    initiatedAt: unixMs(900),
    confirmedAt: unixMs(950),
    evidence: {} as SetupCandidate["evidence"],
    ...overrides,
  };
}

function structural(overrides: Partial<QualifiedRiskResult> = {}): QualifiedRiskResult {
  return {
    status: "QUALIFIED",
    candidateId: "candidate-1",
    family: "TREND_PULLBACK_CONTINUATION",
    direction: "UP",
    instrumentId: instrument,
    setupTimeframe,
    asOf,
    entryReferencePrice: "100.123400",
    invalidationPrice: "95.00001",
    primaryTargetPrice: "120.500009",
    grossRisk: "5.12339",
    grossReward: "20.376609",
    entryCost: "0.1",
    targetExitCost: "0.1",
    stopExitCost: "0.1",
    netRisk: "5.32339",
    netReward: "20.176609",
    netRewardRiskBps: "37901",
    minimumRequiredNetRewardRiskBps: 30_000,
    targetPath: [],
    ...overrides,
  };
}

function structuralBlocked(status: "NOT_QUALIFIED" | "DATA_REJECTED"): RiskQualificationResult {
  return {
    ...structural(),
    status,
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
    requestedRiskAmount: "100.0000",
    ...overrides,
  } as CapitalEligibleResult;
}

function portfolioBlocked(status: "BLOCKED" | "DATA_REJECTED"): PortfolioRiskResult {
  return {
    ...portfolio(),
    status,
    reason: status === "BLOCKED" ? "PER_TRADE_RISK_LIMIT_EXCEEDED" : "INVALID_REQUESTED_RISK",
  } as PortfolioRiskResult;
}

function sizing(overrides: Partial<SizedPositionResult> = {}): SizedPositionResult {
  return {
    status: "SIZED",
    candidateId: "candidate-1",
    instrumentId: instrument,
    asOf,
    quantityUnit: "contract",
    sizedQuantity: "18.7500",
    quantityStep: "0.001",
    minimumQuantity: "0.001",
    maximumQuantity: "100",
    cappedByMaximumQuantity: false,
    pnlCurrency: currencyCode("USD"),
    accountCurrency: currencyCode("USD"),
    conversionRate: "1",
    approvedRiskAmount: "100",
    structuralNetRisk: "5.3233900",
    pnlValuePerPriceUnitPerQuantity: "1",
    riskPerQuantityUnitInAccountCurrency: "5.32339",
    riskPerQuantityStep: "0.00532339",
    actualRiskAmount: "99.8135625",
    unusedRiskAmount: "0.1864375",
    riskUtilizationBps: "9981",
    ...overrides,
  };
}

function sizingBlocked(status: "NOT_SIZEABLE" | "DATA_REJECTED"): PositionSizingResult {
  return {
    ...sizing(),
    status,
    reason: status === "NOT_SIZEABLE" ? "RISK_BUDGET_BELOW_MINIMUM_QUANTITY" : "INVALID_APPROVED_RISK_BUDGET",
  } as PositionSizingResult;
}

function fixture(overrides: Partial<TradeIntentInput> = {}): TradeIntentInput {
  return {
    setupCandidate: setup(),
    structuralRiskResult: structural(),
    portfolioRiskResult: portfolio(),
    positionSizingResult: sizing(),
    ...overrides,
  };
}

describe("upstream eligibility and deterministic priority", () => {
  it("creates an intent only for a fully eligible chain", () => {
    expect(createTradeIntent(fixture())).toEqual(expect.objectContaining({ status: "INTENT_READY" }));
  });

  it("blocks an ARMED setup", () => {
    expect(createTradeIntent(fixture({ setupCandidate: setup({ stage: "ARMED" }) }))).toEqual({
      status: "UPSTREAM_NOT_READY", blockingLayer: "SETUP", upstreamStatus: "ARMED", candidateId: "candidate-1",
    });
  });

  it.each(["NOT_QUALIFIED", "DATA_REJECTED"] as const)("blocks structural %s and preserves its reason", (status) => {
    const result = createTradeIntent(fixture({ structuralRiskResult: structuralBlocked(status) }));
    expect(result).toEqual(expect.objectContaining({
      status: "UPSTREAM_NOT_READY",
      blockingLayer: "STRUCTURAL_RISK",
      upstreamStatus: status,
      upstreamReason: status === "NOT_QUALIFIED" ? "NET_RR_BELOW_MINIMUM" : "DATA_GAP",
    }));
  });

  it.each(["BLOCKED", "DATA_REJECTED"] as const)("blocks portfolio %s and preserves its reason", (status) => {
    expect(createTradeIntent(fixture({ portfolioRiskResult: portfolioBlocked(status) }))).toEqual(expect.objectContaining({
      status: "UPSTREAM_NOT_READY", blockingLayer: "PORTFOLIO_RISK", upstreamStatus: status,
      upstreamReason: status === "BLOCKED" ? "PER_TRADE_RISK_LIMIT_EXCEEDED" : "INVALID_REQUESTED_RISK",
    }));
  });

  it.each(["NOT_SIZEABLE", "DATA_REJECTED"] as const)("blocks sizing %s and preserves its reason", (status) => {
    expect(createTradeIntent(fixture({ positionSizingResult: sizingBlocked(status) }))).toEqual(expect.objectContaining({
      status: "UPSTREAM_NOT_READY", blockingLayer: "POSITION_SIZING", upstreamStatus: status,
      upstreamReason: status === "NOT_SIZEABLE" ? "RISK_BUDGET_BELOW_MINIMUM_QUANTITY" : "INVALID_APPROVED_RISK_BUDGET",
    }));
  });

  it("uses SETUP, STRUCTURAL_RISK, PORTFOLIO_RISK, POSITION_SIZING priority", () => {
    const all = fixture({
      setupCandidate: setup({ stage: "ARMED" }),
      structuralRiskResult: structuralBlocked("NOT_QUALIFIED"),
      portfolioRiskResult: portfolioBlocked("BLOCKED"),
      positionSizingResult: sizingBlocked("NOT_SIZEABLE"),
    });
    expect(createTradeIntent(all)).toEqual(expect.objectContaining({ blockingLayer: "SETUP" }));
    expect(createTradeIntent({ ...all, setupCandidate: setup() })).toEqual(expect.objectContaining({ blockingLayer: "STRUCTURAL_RISK" }));
    expect(createTradeIntent({ ...all, setupCandidate: setup(), structuralRiskResult: structural() })).toEqual(
      expect.objectContaining({ blockingLayer: "PORTFOLIO_RISK" }),
    );
  });
});

describe("cross-layer identity and semantic consistency", () => {
  it.each([
    ["CANDIDATE_ID_MISMATCH", { structuralRiskResult: structural({ candidateId: "other" }) }],
    ["INSTRUMENT_MISMATCH", { portfolioRiskResult: portfolio({ instrumentId: otherInstrument }) }],
    ["AS_OF_MISMATCH", { positionSizingResult: sizing({ asOf: unixMs(1_001) }) }],
    ["FAMILY_MISMATCH", { structuralRiskResult: structural({ family: "BREAKOUT_RETEST" }) }],
    ["DIRECTION_MISMATCH", { structuralRiskResult: structural({ direction: "DOWN" }) }],
    ["SETUP_TIMEFRAME_MISMATCH", { structuralRiskResult: structural({ setupTimeframe: parseTimeframe("1h") }) }],
  ] as const)("rejects %s", (reason, overrides) => {
    expect(createTradeIntent(fixture(overrides))).toEqual(expect.objectContaining({ status: "DATA_REJECTED", reason }));
  });
});

describe("capital and structural consistency", () => {
  it("mandatorily rejects requested risk 100 versus approved risk 101", () => {
    expect(createTradeIntent(fixture({ positionSizingResult: sizing({ approvedRiskAmount: "101" }) }))).toEqual(
      expect.objectContaining({ status: "DATA_REJECTED", reason: "APPROVED_RISK_MISMATCH" }),
    );
  });

  it("compares approved risk by exact decimal value", () => {
    expect(createTradeIntent(fixture())).toEqual(expect.objectContaining({ status: "INTENT_READY" }));
  });

  it("rejects account currency mismatch", () => {
    expect(createTradeIntent(fixture({ positionSizingResult: sizing({ accountCurrency: currencyCode("EUR") }) }))).toEqual(
      expect.objectContaining({ reason: "ACCOUNT_CURRENCY_MISMATCH" }),
    );
  });

  it("allows actual risk at the approved boundary and rejects a microscopic excess", () => {
    expect(createTradeIntent(fixture({ positionSizingResult: sizing({ actualRiskAmount: "100.00000", unusedRiskAmount: "0" }) }))).toEqual(
      expect.objectContaining({ status: "INTENT_READY" }),
    );
    expect(createTradeIntent(fixture({ positionSizingResult: sizing({ actualRiskAmount: "100.000000000000000001" }) }))).toEqual(
      expect.objectContaining({ status: "DATA_REJECTED", reason: "ACTUAL_RISK_EXCEEDS_APPROVED_RISK" }),
    );
  });

  it("rejects structural net-risk mismatch but accepts equivalent decimal spelling", () => {
    expect(createTradeIntent(fixture({ positionSizingResult: sizing({ structuralNetRisk: "5.3234" }) }))).toEqual(
      expect.objectContaining({ reason: "STRUCTURAL_NET_RISK_MISMATCH" }),
    );
    expect(createTradeIntent(fixture())).toEqual(expect.objectContaining({ status: "INTENT_READY" }));
  });
});

describe("R:R integrity and price-direction sanity", () => {
  it("rejects a qualified result below its own minimum", () => {
    expect(createTradeIntent(fixture({ structuralRiskResult: structural({ netRewardRiskBps: "39999", minimumRequiredNetRewardRiskBps: 40_000 }) }))).toEqual(
      expect.objectContaining({ reason: "INVALID_STRUCTURAL_RISK_RESULT" }),
    );
  });

  it("rejects a minimum below the ULTE 3R floor and preserves the exact boundary", () => {
    expect(createTradeIntent(fixture({ structuralRiskResult: structural({ minimumRequiredNetRewardRiskBps: 29_999 }) }))).toEqual(
      expect.objectContaining({ reason: "INVALID_STRUCTURAL_RISK_RESULT" }),
    );
    const result = createTradeIntent(fixture({ structuralRiskResult: structural({ netRewardRiskBps: "30000" }) }));
    expect(result).toEqual(expect.objectContaining({
      status: "INTENT_READY", netRewardRiskBps: "30000", minimumRequiredNetRewardRiskBps: 30_000,
    }));
  });

  it.each([
    ["UP stop", structural({ invalidationPrice: "100.123400" })],
    ["UP target", structural({ primaryTargetPrice: "100" })],
    ["DOWN stop", structural({ direction: "DOWN", invalidationPrice: "99", primaryTargetPrice: "80" })],
    ["DOWN target", structural({ direction: "DOWN", invalidationPrice: "110", primaryTargetPrice: "101" })],
  ] as const)("rejects invalid %s placement", (_label, risk) => {
    const candidate = risk.direction === "DOWN" ? setup({ direction: "DOWN" }) : setup();
    expect(createTradeIntent(fixture({ setupCandidate: candidate, structuralRiskResult: risk }))).toEqual(
      expect.objectContaining({ status: "DATA_REJECTED", reason: "INVALID_PRICE_DIRECTION" }),
    );
  });
});

describe("authoritative copying and scope", () => {
  it("copies distinctive prices, sizing, and risk values exactly without recomputation", () => {
    const result = createTradeIntent(fixture());
    expect(result).toEqual(expect.objectContaining({
      entryReferencePrice: "100.123400",
      invalidationPrice: "95.00001",
      primaryTargetPrice: "120.500009",
      quantity: "18.7500",
      structuralNetRisk: "5.3233900",
      approvedRiskAmount: "100",
      actualRiskAmount: "99.8135625",
      unusedRiskAmount: "0.1864375",
      direction: "UP",
    }));
  });

  it("contains no order-side or execution fields", () => {
    const result = createTradeIntent(fixture());
    for (const field of ["orderSide", "broker", "venue", "timeInForce", "reduceOnly", "leverage", "marginMode"]) {
      expect(field in result).toBe(false);
    }
    expect(JSON.stringify(result)).not.toMatch(/\b(?:BUY|SELL)\b/);
  });
});

describe("deterministic collision-resistant identity", () => {
  it("repeats the same ID and deeply equivalent intent", () => {
    const first = createTradeIntent(fixture());
    const second = createTradeIntent(fixture());
    expect(first).toEqual(second);
    expect(first.status === "INTENT_READY" && second.status === "INTENT_READY" && first.intentId).toBe(second.status === "INTENT_READY" ? second.intentId : "");
  });

  it.each([
    ["quantity", fixture({ positionSizingResult: sizing({ sizedQuantity: "18.751" }) })],
    ["entry", fixture({ structuralRiskResult: structural({ entryReferencePrice: "100.123401" }) })],
    ["invalidation", fixture({ structuralRiskResult: structural({ invalidationPrice: "95.00002" }) })],
    ["target", fixture({ structuralRiskResult: structural({ primaryTargetPrice: "120.500010" }) })],
    ["asOf", fixture({
      setupCandidate: setup({ asOf: unixMs(2_000) }),
      structuralRiskResult: structural({ asOf: unixMs(2_000) }),
      portfolioRiskResult: portfolio({ asOf: unixMs(2_000) }),
      positionSizingResult: sizing({ asOf: unixMs(2_000) }),
    })],
  ] as const)("changes ID when %s changes", (_field, changed) => {
    const baseline = createTradeIntent(fixture());
    const result = createTradeIntent(changed);
    expect(baseline.status).toBe("INTENT_READY");
    expect(result.status).toBe("INTENT_READY");
    if (baseline.status === "INTENT_READY" && result.status === "INTENT_READY") {
      expect(result.intentId).not.toBe(baseline.intentId);
    }
  });

  it("uses unambiguous length prefixes and deterministic field order", () => {
    expect(encodeLengthPrefixed(["a|b", "c"])).not.toBe(encodeLengthPrefixed(["a", "b|c"]));
    expect(encodeLengthPrefixed(["a|b", "c"])).toBe("3:a|b1:c");
    const result = createTradeIntent(fixture({ setupCandidate: setup({ id: "candidate:|:1" }), structuralRiskResult: structural({ candidateId: "candidate:|:1" }), portfolioRiskResult: portfolio({ candidateId: "candidate:|:1" }), positionSizingResult: sizing({ candidateId: "candidate:|:1" }) }));
    expect(result).toEqual(expect.objectContaining({ status: "INTENT_READY", candidateId: "candidate:|:1" }));
  });
});

describe("immutability and purity", () => {
  it("does not mutate inputs, freezes success and rejection, and has no wall-clock variance", () => {
    const input = fixture();
    const before = JSON.stringify(input);
    const first = createTradeIntent(input);
    const second = createTradeIntent(input);
    const rejection = createTradeIntent(fixture({ structuralRiskResult: structural({ direction: "DOWN" }) }));
    expect(JSON.stringify(input)).toBe(before);
    expect(first).toEqual(second);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(rejection)).toBe(true);
    expect(first.status === "INTENT_READY" && first.asOf).toBe(asOf);
  });
});
