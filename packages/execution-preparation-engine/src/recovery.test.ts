import { describe, expect, it } from "vitest";
import { createInstrumentId } from "@ulte/instrument-model";
import {
  PHASE33A_AS_OF,
  PHASE33A_EXECUTION_AS_OF,
  PHASE33A_INSTRUMENT,
  createReadyTradeIntentRecoveryFixture,
  type Phase33aPriceFixture,
} from "../../../tests/integration/phase33a-recovery-fixture.js";
import {
  READY_EXECUTION_PLAN_RECOVERY_DATA_SCHEMA_VERSION,
  createExecutionMarketSnapshot,
  createExecutionPreparationConfig,
  createInstrumentExecutionSpec,
  prepareExecutionPlan,
  restoreReadyExecutionPlan,
  type ReadyExecutionPlan,
  type ReadyExecutionPlanRecoveryDataV1,
  type ReadyExecutionPlanRecoveryDataV2,
  type ReadyExecutionPlanRecoverySelectorV2,
} from "./index.js";

function selector(plan: ReadyExecutionPlan): ReadyExecutionPlanRecoverySelectorV2 {
  const {
    executionPlanId, tradeIntentId, candidateId, instrumentId, intentAsOf, marketSnapshotAsOf,
    preparedAsOf, direction, entrySide, exitSide, quantity, quantityUnit, accountCurrency,
    entryInstruction, protectiveStopInstruction, profitTargetInstruction, priceTick, quantityStep,
    bidAtPreparation, askAtPreparation, intentAgeMs, quoteAgeMs, entryDeviationBps,
    approvedRiskAmount, actualRiskAmount, netRewardRiskBps,
  } = plan;
  return {
    executionPlanId, tradeIntentId, candidateId, instrumentId, intentAsOf, marketSnapshotAsOf,
    preparedAsOf, direction, entrySide, exitSide, quantity, quantityUnit, accountCurrency,
    entryInstruction: { ...entryInstruction },
    protectiveStopInstruction: { ...protectiveStopInstruction },
    profitTargetInstruction: { ...profitTargetInstruction },
    priceTick, quantityStep, bidAtPreparation, askAtPreparation, intentAgeMs, quoteAgeMs,
    entryDeviationBps, approvedRiskAmount, actualRiskAmount, netRewardRiskBps,
  };
}

function createPhase33aRecoveryFixture(prices: Phase33aPriceFixture = {}) {
  const intentFixture = createReadyTradeIntentRecoveryFixture("100", prices);
  const marketSnapshot = {
    instrumentId: PHASE33A_INSTRUMENT, asOf: PHASE33A_AS_OF + 50,
    bid: intentFixture.tradeIntent.entryReferencePrice,
    ask: intentFixture.tradeIntent.entryReferencePrice,
  };
  const instrumentExecutionSpec = {
    instrumentId: PHASE33A_INSTRUMENT, priceTick: "1", quantityStep: "1",
    minimumQuantity: "1", maximumQuantity: "100",
  };
  const config = { maxIntentAgeMs: 100, maxQuoteAgeMs: 50, maxEntryDeviationBps: 100 };
  const normalPlan = prepareExecutionPlan({
    tradeIntent: intentFixture.tradeIntent,
    executionAsOf: PHASE33A_EXECUTION_AS_OF,
    marketSnapshot: createExecutionMarketSnapshot(marketSnapshot),
    instrumentExecutionSpec: createInstrumentExecutionSpec(instrumentExecutionSpec),
    config: createExecutionPreparationConfig(config),
  });
  if (normalPlan.status !== "EXECUTION_PLAN_READY") throw new Error(normalPlan.status);
  const recoveryData: ReadyExecutionPlanRecoveryDataV2 = {
    recoverySchemaVersion: READY_EXECUTION_PLAN_RECOVERY_DATA_SCHEMA_VERSION,
    tradeIntentEvidence: intentFixture.recoveryEvidence,
    marketSnapshot,
    instrumentExecutionSpec,
    config,
    executionAsOf: PHASE33A_EXECUTION_AS_OF,
    expectedPlan: selector(normalPlan),
  };
  return { tradeIntent: intentFixture.tradeIntent, normalPlan, recoveryData };
}

function evidence(): ReadyExecutionPlanRecoveryDataV2 {
  return structuredClone(createPhase33aRecoveryFixture().recoveryData);
}

function restored(source: unknown = evidence()) {
  const result = restoreReadyExecutionPlan(source);
  expect(result.status).toBe("READY_EXECUTION_PLAN_RESTORED");
  if (result.status !== "READY_EXECUTION_PLAN_RESTORED") throw new Error(result.reason);
  return result;
}

function rejectedWith(source: unknown, reason: string) {
  expect(restoreReadyExecutionPlan(source)).toMatchObject({
    status: "READY_EXECUTION_PLAN_RESTORATION_REJECTED",
    reason,
  });
}

describe("authority-equivalent ready execution plan restoration", () => {
  it("restores the normal plan through PRE1 and the normal preparation evaluator", () => {
    const fixture = createPhase33aRecoveryFixture();
    const result = restored(fixture.recoveryData);
    expect(result.tradeIntentRestoration.tradeIntent).toEqual(fixture.tradeIntent);
    expect(result.preparationInput.tradeIntent).toBe(result.tradeIntentRestoration.tradeIntent);
    expect(result.executionPlan).toEqual(fixture.normalPlan);
    expect(result.executionPlan).toEqual(prepareExecutionPlan(result.preparationInput));
    expect(result.executionPlan).toBe(result.preparationResult);
  });

  it("returns the exact evaluator object held by the successful recovery graph", () => {
    const result = restored();
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.preparationInput)).toBe(true);
    expect(Object.isFrozen(result.executionPlan)).toBe(true);
    expect(result.executionPlan.status).toBe("EXECUTION_PLAN_READY");
  });

  it("rejects compensated sparse nested arrays in the plain-JSON guard", () => {
    const source = evidence();
    const proposedRiskGroupIds = new Array<string>(1);
    (proposedRiskGroupIds as any).extra = "compensating-key";
    source.tradeIntentEvidence.portfolioRisk.proposedRiskGroupIds = proposedRiskGroupIds;

    expect(() => restoreReadyExecutionPlan(source)).not.toThrow();
    rejectedWith(source, "INVALID_READY_EXECUTION_PLAN_RECOVERY_DATA");
  });

  it("does not mutate evidence and repeated restoration is deep-equal", () => {
    const source = evidence();
    const before = structuredClone(source);
    const first = restored(source);
    const second = restored(source);
    expect(source).toEqual(before);
    expect(second.executionPlan).toEqual(first.executionPlan);
    expect(second.tradeIntentRestoration.tradeIntent).toEqual(first.tradeIntentRestoration.tradeIntent);
  });

  it("rejects legacy V1 rather than treating plan-shaped data as authority", () => {
    const legacy = {
      recoverySchemaVersion: "READY_EXECUTION_PLAN_RECOVERY_DATA_V1",
    } satisfies Partial<ReadyExecutionPlanRecoveryDataV1>;
    rejectedWith(legacy, "UNSUPPORTED_READY_EXECUTION_PLAN_RECOVERY_SCHEMA");
  });

  it("propagates explicit PRE1 restoration diagnostics", () => {
    const source = evidence();
    source.tradeIntentEvidence.expectedIntent.intentId = "other-intent";
    expect(restoreReadyExecutionPlan(source)).toMatchObject({
      reason: "READY_TRADE_INTENT_RESTORATION_REJECTED",
      upstreamStatus: "READY_TRADE_INTENT_RESTORATION_REJECTED",
      upstreamReason: "EXPECTED_INTENT_IDENTITY_MISMATCH",
    });
  });

  it.each([
    ["below minimum", (source: ReadyExecutionPlanRecoveryDataV2) => {
      source.instrumentExecutionSpec.minimumQuantity = "17";
    }, "QUANTITY_BELOW_MINIMUM"],
    ["above maximum", (source: ReadyExecutionPlanRecoveryDataV2) => {
      source.instrumentExecutionSpec.maximumQuantity = "15";
    }, "QUANTITY_ABOVE_MAXIMUM"],
    ["off quantity step", (source: ReadyExecutionPlanRecoveryDataV2) => {
      source.instrumentExecutionSpec.quantityStep = "3";
      source.instrumentExecutionSpec.minimumQuantity = "3";
      source.instrumentExecutionSpec.maximumQuantity = "99";
    }, "QUANTITY_NOT_STEP_ALIGNED"],
    ["changed price tick", (source: ReadyExecutionPlanRecoveryDataV2) => {
      source.instrumentExecutionSpec.priceTick = "2";
    }, "PRICE_NOT_TICK_ALIGNED"],
    ["stale intent", (source: ReadyExecutionPlanRecoveryDataV2) => {
      source.config.maxIntentAgeMs = 99;
    }, "TRADE_INTENT_STALE"],
    ["stale quote", (source: ReadyExecutionPlanRecoveryDataV2) => {
      source.config.maxQuoteAgeMs = 49;
    }, "MARKET_SNAPSHOT_STALE"],
    ["quote predates intent", (source: ReadyExecutionPlanRecoveryDataV2) => {
      source.marketSnapshot.asOf = PHASE33A_AS_OF - 1;
    }, "QUOTE_PREDATES_TRADE_INTENT"],
    ["market invalidated", (source: ReadyExecutionPlanRecoveryDataV2) => {
      source.marketSnapshot.bid = source.tradeIntentEvidence.expectedIntent.invalidationPrice;
    }, "MARKET_ALREADY_INVALIDATED"],
    ["target reached", (source: ReadyExecutionPlanRecoveryDataV2) => {
      source.marketSnapshot.ask = source.tradeIntentEvidence.expectedIntent.primaryTargetPrice;
    }, "TARGET_ALREADY_REACHED"],
    ["entry deviation exceeded", (source: ReadyExecutionPlanRecoveryDataV2) => {
      source.config.maxEntryDeviationBps = 0;
      source.marketSnapshot.ask = "14";
    }, "ENTRY_DEVIATION_EXCEEDED"],
  ] as const)("uses normal preparation authority to reject %s", (_label, mutate, authorityReason) => {
    const source = evidence();
    mutate(source);
    expect(restoreReadyExecutionPlan(source)).toMatchObject({
      reason: "EXECUTION_PLAN_NOT_READY",
      upstreamStatus: "PLAN_NOT_PREPARABLE",
      upstreamReason: authorityReason,
    });
  });

  it.each([
    ["ENTRY", {}, "2"],
    ["INVALIDATION", { entry: "14", invalidation: "7", target: "50" }, "2"],
    ["TARGET", { entry: "14", invalidation: "7", target: "50" }, "7"],
  ] as const)("rejects an off-tick %s through normal replay", (field, prices, priceTick) => {
    const source = structuredClone(createPhase33aRecoveryFixture(prices).recoveryData);
    source.instrumentExecutionSpec.priceTick = priceTick;
    expect(restoreReadyExecutionPlan(source)).toMatchObject({
      reason: "EXECUTION_PLAN_NOT_READY",
      upstreamReason: "PRICE_NOT_TICK_ALIGNED",
      upstreamFailedPriceField: field,
    });
  });

  it("uses historical config values, so each configured limit can change acceptance", () => {
    const deviation = evidence();
    deviation.marketSnapshot.ask = "14";
    deviation.config.maxEntryDeviationBps = 1_000;
    const baseline = restored();
    const changedPlan = prepareExecutionPlan({
      tradeIntent: baseline.tradeIntentRestoration.tradeIntent,
      executionAsOf: deviation.executionAsOf,
      marketSnapshot: createExecutionMarketSnapshot(deviation.marketSnapshot),
      instrumentExecutionSpec: createInstrumentExecutionSpec(deviation.instrumentExecutionSpec),
      config: createExecutionPreparationConfig(deviation.config),
    });
    expect(changedPlan.status).toBe("EXECUTION_PLAN_READY");
    if (changedPlan.status !== "EXECUTION_PLAN_READY") return;
    deviation.expectedPlan = selector(changedPlan);
    expect(restored(deviation).executionPlan).toEqual(changedPlan);

    const intentAge = evidence();
    intentAge.config.maxIntentAgeMs = 99;
    rejectedWith(intentAge, "EXECUTION_PLAN_NOT_READY");
    const quoteAge = evidence();
    quoteAge.config.maxQuoteAgeMs = 49;
    rejectedWith(quoteAge, "EXECUTION_PLAN_NOT_READY");
  });

  it.each([
    ["quantity step", (source: ReadyExecutionPlanRecoveryDataV2) => {
      source.instrumentExecutionSpec.quantityStep = "3";
      source.instrumentExecutionSpec.minimumQuantity = "3";
      source.instrumentExecutionSpec.maximumQuantity = "99";
    }],
    ["minimum quantity", (source: ReadyExecutionPlanRecoveryDataV2) => {
      source.instrumentExecutionSpec.minimumQuantity = "17";
    }],
    ["maximum quantity", (source: ReadyExecutionPlanRecoveryDataV2) => {
      source.instrumentExecutionSpec.maximumQuantity = "15";
    }],
  ] as const)("does not substitute current %s", (_label, mutate) => {
    const source = evidence();
    mutate(source);
    rejectedWith(source, "EXECUTION_PLAN_NOT_READY");
  });

  it("rejects an instrument mismatch through normal preparation", () => {
    const source = evidence();
    source.instrumentExecutionSpec.instrumentId = createInstrumentId({
      venue: "TEST", venueSymbol: "OTHER", instrumentKind: "SPOT",
    });
    expect(restoreReadyExecutionPlan(source)).toMatchObject({
      reason: "EXECUTION_PLAN_NOT_READY",
      upstreamStatus: "DATA_REJECTED",
      upstreamReason: "INSTRUMENT_MISMATCH",
    });
  });

  it.each([
    ["candidate lineage", "candidateId", "other-candidate"],
    ["instrument lineage", "instrumentId", "TEST:SPOT:OTHER"],
    ["account currency lineage", "accountCurrency", "EUR"],
    ["approved risk lineage", "approvedRiskAmount", "99"],
    ["actual risk lineage", "actualRiskAmount", "99"],
    ["instruction semantics", "entrySide", "SELL"],
  ] as const)("uses the expected selector only to detect %s mutation", (_label, key, value) => {
    const source = evidence();
    Object.assign(source.expectedPlan, { [key]: value });
    rejectedWith(source, "EXPECTED_EXECUTION_PLAN_MISMATCH");
  });

  it("rejects malformed market snapshots through their canonical constructor", () => {
    const source = evidence();
    source.marketSnapshot.bid = "0";
    rejectedWith(source, "INVALID_EXECUTION_MARKET_SNAPSHOT");
  });

  it("rejects malformed execution specs through their canonical constructor", () => {
    const source = evidence();
    source.instrumentExecutionSpec.quantityStep = "0";
    rejectedWith(source, "INVALID_INSTRUMENT_EXECUTION_SPEC");
  });

  it("rejects malformed preparation config through its canonical constructor", () => {
    const source = evidence();
    source.config.maxEntryDeviationBps = 10_001;
    rejectedWith(source, "INVALID_EXECUTION_PREPARATION_CONFIG");
  });

  it.each([null, {}, { recoverySchemaVersion: "READY_EXECUTION_PLAN_RECOVERY_DATA_V2" }])(
    "rejects malformed recovery evidence %#",
    (source) => rejectedWith(source, "INVALID_READY_EXECUTION_PLAN_RECOVERY_DATA"),
  );
});
