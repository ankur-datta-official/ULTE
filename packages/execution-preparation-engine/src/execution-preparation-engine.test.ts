import { describe, expect, it } from "vitest";
import {
  createInstrumentId,
  currencyCode,
  parseTimeframe,
  positiveDecimalString,
  unixMs,
} from "@ulte/instrument-model";
import type { ReadyTradeIntent, TradeIntentResult } from "@ulte/trade-intent-engine";
import { encodeLengthPrefixed } from "./internal/canonical-id.js";
import {
  createExecutionMarketSnapshot,
  createExecutionPreparationConfig,
  createInstrumentExecutionSpec,
  prepareExecutionPlan,
  type ExecutionMarketSnapshot,
  type ExecutionPreparationInput,
  type InstrumentExecutionSpec,
  type ReadyExecutionPlan,
} from "./index.js";

const instrument = createInstrumentId({ venue: "TEST", venueSymbol: "ABC", instrumentKind: "CFD" });
const otherInstrument = createInstrumentId({ venue: "TEST", venueSymbol: "XYZ", instrumentKind: "CFD" });

function intent(overrides: Partial<ReadyTradeIntent> = {}): ReadyTradeIntent {
  return Object.freeze({
    status: "INTENT_READY",
    schemaVersion: "TRADE_INTENT_V1",
    intentId: "intent-1",
    candidateId: "candidate-1",
    instrumentId: instrument,
    asOf: unixMs(1_000),
    family: "TREND_PULLBACK_CONTINUATION",
    direction: "UP",
    contextTimeframe: parseTimeframe("1d"),
    setupTimeframe: parseTimeframe("4h"),
    entryReferencePrice: positiveDecimalString("100.00"),
    invalidationPrice: positiveDecimalString("90.00"),
    primaryTargetPrice: positiveDecimalString("130.00"),
    quantityUnit: "contracts",
    quantity: positiveDecimalString("1.00"),
    quantityStep: positiveDecimalString("0.01"),
    accountCurrency: currencyCode("USD"),
    pnlCurrency: currencyCode("USD"),
    conversionRate: positiveDecimalString("1"),
    approvedRiskAmount: positiveDecimalString("25.123"),
    actualRiskAmount: positiveDecimalString("20.246"),
    unusedRiskAmount: "4.877" as ReadyTradeIntent["unusedRiskAmount"],
    riskUtilizationBps: "8058",
    structuralNetRisk: positiveDecimalString("10.123"),
    netRewardRiskBps: "31234",
    minimumRequiredNetRewardRiskBps: 30_000,
    pnlValuePerPriceUnitPerQuantity: positiveDecimalString("2"),
    riskPerQuantityUnitInAccountCurrency: positiveDecimalString("20.246"),
    riskPerQuantityStep: positiveDecimalString("0.20246"),
    cappedByMaximumQuantity: false,
    ...overrides,
  });
}

function snapshot(overrides: Partial<ExecutionMarketSnapshot> = {}): ExecutionMarketSnapshot {
  return createExecutionMarketSnapshot({
    instrumentId: overrides.instrumentId ?? instrument,
    asOf: overrides.asOf ?? 1_050,
    bid: overrides.bid ?? "99.99",
    ask: overrides.ask ?? "100.00",
  });
}

function spec(overrides: Partial<InstrumentExecutionSpec> = {}): InstrumentExecutionSpec {
  return createInstrumentExecutionSpec({
    instrumentId: overrides.instrumentId ?? instrument,
    priceTick: overrides.priceTick ?? "0.01",
    quantityStep: overrides.quantityStep ?? "0.01",
    minimumQuantity: overrides.minimumQuantity ?? "0.01",
    maximumQuantity: overrides.maximumQuantity ?? "10.00",
  });
}

const config = createExecutionPreparationConfig({
  maxIntentAgeMs: 100,
  maxQuoteAgeMs: 50,
  maxEntryDeviationBps: 1_000,
});

function input(overrides: Partial<ExecutionPreparationInput> = {}): ExecutionPreparationInput {
  return {
    tradeIntent: intent(),
    executionAsOf: 1_100,
    marketSnapshot: snapshot(),
    instrumentExecutionSpec: spec(),
    config,
    ...overrides,
  };
}

function ready(overrides: Partial<ExecutionPreparationInput> = {}): ReadyExecutionPlan {
  const result = prepareExecutionPlan(input(overrides));
  expect(result.status).toBe("EXECUTION_PLAN_READY");
  return result as ReadyExecutionPlan;
}

describe("execution preparation contracts", () => {
  it("creates frozen validated contracts", () => {
    expect(Object.isFrozen(snapshot())).toBe(true);
    expect(Object.isFrozen(spec())).toBe(true);
    expect(Object.isFrozen(config)).toBe(true);
  });

  it.each([
    ["zero bid", { bid: "0", ask: "1" }],
    ["zero ask", { bid: "1", ask: "0" }],
    ["crossed quote", { bid: "2", ask: "1" }],
  ])("rejects an invalid market snapshot: %s", (_label, quote) => {
    expect(() => createExecutionMarketSnapshot({ instrumentId: instrument, asOf: 1_000, ...quote })).toThrow();
  });

  it.each([
    ["zero tick", { priceTick: "0" }],
    ["zero step", { quantityStep: "0" }],
    ["maximum below minimum", { minimumQuantity: "2", maximumQuantity: "1" }],
    ["minimum off step", { minimumQuantity: "0.015" }],
    ["maximum off step", { maximumQuantity: "10.005" }],
  ])("rejects an invalid execution spec: %s", (_label, override) => {
    expect(() => createInstrumentExecutionSpec({
      instrumentId: instrument,
      priceTick: "0.01",
      quantityStep: "0.01",
      minimumQuantity: "0.01",
      maximumQuantity: "10",
      ...override,
    })).toThrow();
  });

  it("requires explicit bounded non-negative config values", () => {
    expect(() => createExecutionPreparationConfig({ maxIntentAgeMs: -1, maxQuoteAgeMs: 0, maxEntryDeviationBps: 0 })).toThrow();
    expect(() => createExecutionPreparationConfig({ maxIntentAgeMs: 0, maxQuoteAgeMs: 0, maxEntryDeviationBps: 10_001 })).toThrow();
  });
});

describe("eligibility, clocks, and identity", () => {
  it("creates a plan only from INTENT_READY", () => {
    expect(ready().status).toBe("EXECUTION_PLAN_READY");
    const nonReady: TradeIntentResult = Object.freeze({
      status: "UPSTREAM_NOT_READY",
      blockingLayer: "POSITION_SIZING",
      upstreamStatus: "NOT_SIZEABLE",
      upstreamReason: "RISK_BUDGET_BELOW_MINIMUM_QUANTITY",
      candidateId: "candidate-1",
    });
    expect(prepareExecutionPlan(input({ tradeIntent: nonReady }))).toEqual({
      status: "UPSTREAM_NOT_READY",
      candidateId: "candidate-1",
      tradeIntentStatus: "UPSTREAM_NOT_READY",
      tradeIntentReason: "RISK_BUDGET_BELOW_MINIMUM_QUANTITY",
    });
  });

  it("rejects snapshot and spec instrument mismatches", () => {
    expect(prepareExecutionPlan(input({ marketSnapshot: snapshot({ instrumentId: otherInstrument }) }))).toMatchObject({
      status: "DATA_REJECTED", reason: "INSTRUMENT_MISMATCH",
    });
    expect(prepareExecutionPlan(input({ instrumentExecutionSpec: spec({ instrumentId: otherInstrument }) }))).toMatchObject({
      status: "DATA_REJECTED", reason: "INSTRUMENT_MISMATCH",
    });
  });

  it("rejects execution before intent, quote before intent, and future quote", () => {
    expect(prepareExecutionPlan(input({ executionAsOf: 999 }))).toMatchObject({ reason: "FUTURE_TRADE_INTENT" });
    expect(prepareExecutionPlan(input({ marketSnapshot: snapshot({ asOf: unixMs(999) }) }))).toMatchObject({
      status: "PLAN_NOT_PREPARABLE", reason: "QUOTE_PREDATES_TRADE_INTENT",
    });
    expect(prepareExecutionPlan(input({ marketSnapshot: snapshot({ asOf: unixMs(1_101) }) }))).toMatchObject({
      status: "DATA_REJECTED", reason: "FUTURE_MARKET_SNAPSHOT",
    });
  });

  it("allows exact intent-age boundary and rejects one millisecond beyond", () => {
    expect(prepareExecutionPlan(input({ executionAsOf: 1_100 })).status).toBe("EXECUTION_PLAN_READY");
    expect(prepareExecutionPlan(input({
      executionAsOf: 1_101,
      marketSnapshot: snapshot({ asOf: unixMs(1_051) }),
    }))).toMatchObject({ reason: "TRADE_INTENT_STALE" });
  });

  it("allows exact quote-age boundary and rejects one millisecond beyond", () => {
    expect(prepareExecutionPlan(input({ marketSnapshot: snapshot({ asOf: unixMs(1_050) }) })).status).toBe("EXECUTION_PLAN_READY");
    expect(prepareExecutionPlan(input({ marketSnapshot: snapshot({ asOf: unixMs(1_049) }) }))).toMatchObject({
      reason: "MARKET_SNAPSHOT_STALE",
    });
  });

  it("defensively rejects malformed snapshots, specs, config, and price direction", () => {
    const badQuote = { ...snapshot(), bid: "0" } as ExecutionMarketSnapshot;
    expect(prepareExecutionPlan(input({ marketSnapshot: badQuote }))).toMatchObject({ reason: "INVALID_MARKET_SNAPSHOT" });
    const badSpec = { ...spec(), priceTick: "0" } as InstrumentExecutionSpec;
    expect(prepareExecutionPlan(input({ instrumentExecutionSpec: badSpec }))).toMatchObject({ reason: "INVALID_EXECUTION_SPEC" });
    expect(prepareExecutionPlan(input({ config: { ...config, maxQuoteAgeMs: -1 } }))).toMatchObject({ reason: "INVALID_EXECUTION_CONFIG" });
    expect(prepareExecutionPlan(input({ tradeIntent: intent({ invalidationPrice: positiveDecimalString("110") }) }))).toMatchObject({
      reason: "INVALID_PRICE_DIRECTION",
    });
  });
});

describe("exact representability without normalization", () => {
  it.each([
    ["ENTRY", { entryReferencePrice: positiveDecimalString("100.005") }],
    ["INVALIDATION", { invalidationPrice: positiveDecimalString("90.005") }],
    ["TARGET", { primaryTargetPrice: positiveDecimalString("130.005") }],
  ] as const)("rejects a non-tick-aligned %s price and returns no changed price", (field, override) => {
    const result = prepareExecutionPlan(input({ tradeIntent: intent(override) }));
    expect(result).toMatchObject({
      status: "PLAN_NOT_PREPARABLE", reason: "PRICE_NOT_TICK_ALIGNED", failedPriceField: field,
    });
    expect(result).not.toHaveProperty("entryInstruction");
  });

  it("accepts exact price-tick alignment", () => {
    expect(prepareExecutionPlan(input()).status).toBe("EXECUTION_PLAN_READY");
  });

  it("rejects quantity below, above, and off step without rounding 1.005", () => {
    expect(prepareExecutionPlan(input({ tradeIntent: intent({ quantity: positiveDecimalString("0.001") }) }))).toMatchObject({
      reason: "QUANTITY_BELOW_MINIMUM",
    });
    expect(prepareExecutionPlan(input({ tradeIntent: intent({ quantity: positiveDecimalString("10.01") }) }))).toMatchObject({
      reason: "QUANTITY_ABOVE_MAXIMUM",
    });
    const result = prepareExecutionPlan(input({ tradeIntent: intent({ quantity: positiveDecimalString("1.005") }) }));
    expect(result).toMatchObject({ status: "PLAN_NOT_PREPARABLE", reason: "QUANTITY_NOT_STEP_ALIGNED" });
    expect(result).not.toHaveProperty("quantity");
  });

  it("accepts exact quantity-step alignment", () => {
    expect(prepareExecutionPlan(input({ tradeIntent: intent({ quantity: positiveDecimalString("1.01") }) })).status)
      .toBe("EXECUTION_PLAN_READY");
  });
});

describe("side mapping and broker-neutral instructions", () => {
  it("maps UP to BUY entry and SELL exits and copies exact values", () => {
    const result = ready();
    expect(result).toMatchObject({
      direction: "UP", entrySide: "BUY", exitSide: "SELL", quantity: "1.00",
      entryInstruction: { kind: "ENTRY_LIMIT", side: "BUY", price: "100.00", quantity: "1.00", positionEffect: "OPEN" },
      protectiveStopInstruction: { kind: "PROTECTIVE_STOP_TRIGGER", side: "SELL", triggerPrice: "90.00", quantity: "1.00", positionEffect: "CLOSE" },
      profitTargetInstruction: { kind: "PROFIT_TARGET_LIMIT", side: "SELL", price: "130.00", quantity: "1.00", positionEffect: "CLOSE" },
    });
  });

  it("maps DOWN to SELL entry and BUY exits", () => {
    const down = intent({
      direction: "DOWN",
      invalidationPrice: positiveDecimalString("110.00"),
      primaryTargetPrice: positiveDecimalString("70.00"),
    });
    const result = ready({ tradeIntent: down });
    expect(result).toMatchObject({
      direction: "DOWN", entrySide: "SELL", exitSide: "BUY",
      entryInstruction: { side: "SELL" },
      protectiveStopInstruction: { side: "BUY" },
      profitTargetInstruction: { side: "BUY" },
    });
  });

  it("copies risk traceability metadata exactly without recomputing", () => {
    expect(ready()).toMatchObject({
      approvedRiskAmount: "25.123", actualRiskAmount: "20.246", netRewardRiskBps: "31234",
    });
  });
});

describe("current-market gates", () => {
  it.each(["90", "89.99"])("rejects an UP market with bid %s at/below stop", (bid) => {
    expect(prepareExecutionPlan(input({ marketSnapshot: snapshot({ bid: positiveDecimalString(bid), ask: positiveDecimalString("91") }) })))
      .toMatchObject({ reason: "MARKET_ALREADY_INVALIDATED" });
  });

  it.each(["130", "130.01"])("rejects an UP market with ask %s at/above target", (ask) => {
    expect(prepareExecutionPlan(input({ marketSnapshot: snapshot({ bid: positiveDecimalString("129.99"), ask: positiveDecimalString(ask) }) })))
      .toMatchObject({ reason: "TARGET_ALREADY_REACHED" });
  });

  it("mirrors stop and target gates for DOWN", () => {
    const down = intent({
      direction: "DOWN",
      invalidationPrice: positiveDecimalString("110"),
      primaryTargetPrice: positiveDecimalString("70"),
    });
    expect(prepareExecutionPlan(input({ tradeIntent: down, marketSnapshot: snapshot({ bid: positiveDecimalString("109"), ask: positiveDecimalString("110") }) })))
      .toMatchObject({ reason: "MARKET_ALREADY_INVALIDATED" });
    expect(prepareExecutionPlan(input({ tradeIntent: down, marketSnapshot: snapshot({ bid: positiveDecimalString("70"), ask: positiveDecimalString("71") }) })))
      .toMatchObject({ reason: "TARGET_ALREADY_REACHED" });
  });

  it("uses UP ask and DOWN bid for exact deviation eligibility", () => {
    const narrow = createExecutionPreparationConfig({ maxIntentAgeMs: 100, maxQuoteAgeMs: 50, maxEntryDeviationBps: 1 });
    expect(prepareExecutionPlan(input({ config: narrow, marketSnapshot: snapshot({ bid: positiveDecimalString("90.01"), ask: positiveDecimalString("100.01") }) })).status)
      .toBe("EXECUTION_PLAN_READY");
    const down = intent({ direction: "DOWN", invalidationPrice: positiveDecimalString("110"), primaryTargetPrice: positiveDecimalString("70") });
    expect(prepareExecutionPlan(input({ tradeIntent: down, config: narrow, marketSnapshot: snapshot({ bid: positiveDecimalString("99.99"), ask: positiveDecimalString("109.99") }) })).status)
      .toBe("EXECUTION_PLAN_READY");
  });

  it("allows exact deviation boundary and rejects a microscopic excess", () => {
    const boundary = createExecutionPreparationConfig({ maxIntentAgeMs: 100, maxQuoteAgeMs: 50, maxEntryDeviationBps: 100 });
    expect(prepareExecutionPlan(input({ config: boundary, marketSnapshot: snapshot({ bid: positiveDecimalString("100"), ask: positiveDecimalString("101") }) })).status)
      .toBe("EXECUTION_PLAN_READY");
    expect(prepareExecutionPlan(input({ config: boundary, marketSnapshot: snapshot({ bid: positiveDecimalString("100"), ask: positiveDecimalString("101.0000001") }) })))
      .toMatchObject({ reason: "ENTRY_DEVIATION_EXCEEDED" });
  });

  it("allows resting BUY below ask and SELL above bid within deviation", () => {
    expect(prepareExecutionPlan(input({ marketSnapshot: snapshot({ bid: positiveDecimalString("100.99"), ask: positiveDecimalString("101") }) })).status)
      .toBe("EXECUTION_PLAN_READY");
    const down = intent({ direction: "DOWN", invalidationPrice: positiveDecimalString("110"), primaryTargetPrice: positiveDecimalString("70") });
    expect(prepareExecutionPlan(input({ tradeIntent: down, marketSnapshot: snapshot({ bid: positiveDecimalString("99"), ask: positiveDecimalString("99.01") }) })).status)
      .toBe("EXECUTION_PLAN_READY");
  });
});

describe("determinism and immutability", () => {
  it("has deterministic identity and deeply equivalent repeat evaluation", () => {
    const request = input();
    const first = prepareExecutionPlan(request);
    const second = prepareExecutionPlan(request);
    expect(second).toEqual(first);
    expect((second as ReadyExecutionPlan).executionPlanId).toBe((first as ReadyExecutionPlan).executionPlanId);
  });

  it("changes identity when quote or executionAsOf changes", () => {
    const baseline = ready();
    const changedQuote = ready({ marketSnapshot: snapshot({ ask: positiveDecimalString("100.01") }) });
    const changedTime = ready({ executionAsOf: 1_099 });
    expect(changedQuote.executionPlanId).not.toBe(baseline.executionPlanId);
    expect(changedTime.executionPlanId).not.toBe(baseline.executionPlanId);
  });

  it("uses ambiguity-safe length-prefix encoding", () => {
    expect(encodeLengthPrefixed(["ab", "c"])).not.toBe(encodeLengthPrefixed(["a", "bc"]));
    expect(encodeLengthPrefixed(["ab", "c"])).toBe("2:ab1:c");
  });

  it("does not mutate inputs and freezes the plan and instructions", () => {
    const request = input();
    const before = JSON.stringify(request);
    const result = ready(request);
    expect(JSON.stringify(request)).toBe(before);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.entryInstruction)).toBe(true);
    expect(Object.isFrozen(result.protectiveStopInstruction)).toBe(true);
    expect(Object.isFrozen(result.profitTargetInstruction)).toBe(true);
  });
});
