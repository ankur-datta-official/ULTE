import { describe, expect, it } from "vitest";
import {
  createExecutionAttempt,
  restoreExecutionAttemptFromEvidence,
  type ExecutionAttempt,
  type ExecutionAttemptRecoveryEvidenceV1,
} from "@ulte/execution-engine";
import {
  createInstrumentId,
} from "@ulte/instrument-model";
import {
  READY_EXECUTION_PLAN_RECOVERY_DATA_SCHEMA_VERSION,
  createExecutionMarketSnapshot,
  createExecutionPreparationConfig,
  createInstrumentExecutionSpec,
  prepareExecutionPlan,
  type ReadyExecutionPlan,
  type ReadyExecutionPlanRecoverySelectorV2,
} from "../../execution-preparation-engine/src/index.js";
import {
  PHASE33A_AS_OF,
  PHASE33A_EXECUTION_AS_OF,
  PHASE33A_INSTRUMENT,
  createReadyTradeIntentRecoveryFixture,
} from "../../../tests/integration/phase33a-recovery-fixture.js";
import type { TradeRMultipleProjectedRealtimeResult } from "@ulte/realtime-trade-r-multiple-engine";
import {
  createTradeRiskBasisFromExecutionAttempt,
  type TradeRiskBasis,
} from "@ulte/trade-r-multiple-engine";
import {
  createLiveTradingOrchestrationSession,
  hydrateLiveTradingOrchestrationSession,
  planLiveTradingStep,
  type HydrateLiveTradingOrchestrationSessionInput,
} from "./index.js";

const instrument = PHASE33A_INSTRUMENT;
const otherInstrument = createInstrumentId({ venue: "TEST", venueSymbol: "XYZ", instrumentKind: "SPOT" });

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
    entryInstruction: { ...entryInstruction }, protectiveStopInstruction: { ...protectiveStopInstruction },
    profitTargetInstruction: { ...profitTargetInstruction }, priceTick, quantityStep,
    bidAtPreparation, askAtPreparation, intentAgeMs, quoteAgeMs, entryDeviationBps,
    approvedRiskAmount, actualRiskAmount, netRewardRiskBps,
  };
}

function authority(): ExecutionAttempt {
  const intentFixture = createReadyTradeIntentRecoveryFixture("6");
  const marketSnapshot = {
    instrumentId: instrument, asOf: PHASE33A_AS_OF + 50,
    bid: intentFixture.tradeIntent.entryReferencePrice,
    ask: intentFixture.tradeIntent.entryReferencePrice,
  };
  const instrumentExecutionSpec = {
    instrumentId: instrument, priceTick: "1", quantityStep: "1",
    minimumQuantity: "1", maximumQuantity: "100",
  };
  const config = { maxIntentAgeMs: 100, maxQuoteAgeMs: 50, maxEntryDeviationBps: 100 };
  const sourcePlan = prepareExecutionPlan({
    tradeIntent: intentFixture.tradeIntent, executionAsOf: PHASE33A_EXECUTION_AS_OF,
    marketSnapshot: createExecutionMarketSnapshot(marketSnapshot),
    instrumentExecutionSpec: createInstrumentExecutionSpec(instrumentExecutionSpec),
    config: createExecutionPreparationConfig(config),
  });
  if (sourcePlan.status !== "EXECUTION_PLAN_READY") throw new Error("fixture plan rejected");
  const initial = createExecutionAttempt(sourcePlan);
  if (initial.status !== "EXECUTION_ATTEMPT_READY") throw new Error("fixture plan rejected");
  const evidence: ExecutionAttemptRecoveryEvidenceV1 = {
    schemaVersion: "EXECUTION_ATTEMPT_RECOVERY_EVIDENCE_V1",
    identity: {
      executionAttemptId: initial.executionAttemptId,
      executionPlanId: initial.executionPlanId,
      tradeIntentId: initial.tradeIntentId,
      candidateId: initial.candidateId,
      instrumentId: initial.instrumentId,
    },
    initialization: {
      executionPlanRecoveryData: {
        recoverySchemaVersion: READY_EXECUTION_PLAN_RECOVERY_DATA_SCHEMA_VERSION,
        tradeIntentEvidence: intentFixture.recoveryEvidence,
        marketSnapshot,
        instrumentExecutionSpec,
        config,
        executionAsOf: PHASE33A_EXECUTION_AS_OF,
        expectedPlan: selector(sourcePlan),
      },
    },
    transitions: [],
  };
  const restored = restoreExecutionAttemptFromEvidence(evidence);
  if (restored.status !== "EXECUTION_ATTEMPT_RESTORED") throw new Error("fixture recovery rejected");
  return restored.executionAttempt;
}

function riskBasis(attempt: ExecutionAttempt): TradeRiskBasis {
  const result = createTradeRiskBasisFromExecutionAttempt(attempt);
  if (result.status !== "TRADE_RISK_BASIS_CREATED") throw new Error("fixture basis rejected");
  return result.riskBasis;
}

function input(
  overrides: Partial<HydrateLiveTradingOrchestrationSessionInput> = {},
): HydrateLiveTradingOrchestrationSessionInput {
  return {
    schemaVersion: "LIVE_TRADING_ORCHESTRATION_SESSION_V1",
    sessionId: "session-1",
    mode: "DRY_RUN",
    instrumentId: instrument,
    ...overrides,
  };
}

function projectedR(
  attempt: ExecutionAttempt,
  basis: TradeRiskBasis,
): TradeRMultipleProjectedRealtimeResult {
  const netSnapshot = Object.freeze({
    executionAttemptId: attempt.executionAttemptId,
    executionPlanId: attempt.executionPlanId,
    tradeIntentId: attempt.tradeIntentId,
    candidateId: attempt.candidateId,
    instrumentId: attempt.instrumentId,
  });
  const snapshot = Object.freeze({
    schemaVersion: "TRADE_R_MULTIPLE_SNAPSHOT_V1",
    executionAttemptId: attempt.executionAttemptId,
    executionPlanId: attempt.executionPlanId,
    tradeIntentId: attempt.tradeIntentId,
    candidateId: attempt.candidateId,
    instrumentId: attempt.instrumentId,
    riskBasisMethod: basis.riskBasisMethod,
    initialActualRiskAmount: basis.initialActualRiskAmount,
    accountCurrency: basis.accountCurrency,
    riskBasisAsOf: basis.riskBasisAsOf,
    riskBasis: basis,
    netPerformance: netSnapshot,
  });
  const realtimeNetPerformance = Object.freeze({
    status: "NET_TRADE_PERFORMANCE_PROJECTED",
    snapshot: netSnapshot,
  });
  const rMultipleProjection = Object.freeze({ status: "TRADE_R_MULTIPLE_PROJECTED", snapshot });
  return Object.freeze({
    status: "TRADE_R_MULTIPLE_PROJECTED",
    snapshot,
    realtimeNetPerformance,
    rMultipleProjection,
  }) as unknown as TradeRMultipleProjectedRealtimeResult;
}

describe("live orchestration session hydration", () => {
  it.each(["DRY_RUN", "SANDBOX"] as const)("hydrates an empty frozen %s session", (mode) => {
    const result = hydrateLiveTradingOrchestrationSession(input({ mode }));
    expect(result).toMatchObject({
      status: "ORCHESTRATION_SESSION_HYDRATED",
      session: { mode, instrumentId: instrument },
    });
    expect(Object.isFrozen(result)).toBe(true);
    if (result.status === "ORCHESTRATION_SESSION_HYDRATED") expect(Object.isFrozen(result.session)).toBe(true);
  });

  it("rejects LIVE and legacy session schema runtime values", () => {
    expect(hydrateLiveTradingOrchestrationSession(input({ mode: "LIVE" as "SANDBOX" }))).toMatchObject({
      status: "ORCHESTRATION_SESSION_HYDRATION_REJECTED",
      reason: "HYDRATION_INVALID_SESSION",
    });
    expect(hydrateLiveTradingOrchestrationSession({
      ...input(), schemaVersion: "SESSION_V0",
    } as unknown as HydrateLiveTradingOrchestrationSessionInput)).toMatchObject({
      reason: "HYDRATION_INVALID_SESSION",
    });
  });

  it("preserves the exact restored execution-attempt reference", () => {
    const attempt = authority();
    const result = hydrateLiveTradingOrchestrationSession(input({ latestExecutionAttempt: attempt }));
    expect(result.status).toBe("ORCHESTRATION_SESSION_HYDRATED");
    if (result.status === "ORCHESTRATION_SESSION_HYDRATED") {
      expect(result.session.latestExecutionAttempt).toBe(attempt);
    }
  });

  it("rejects attempt instrument, legacy-schema, and malformed identity values", () => {
    const attempt = authority();
    for (const invalid of [
      { ...attempt, instrumentId: otherInstrument },
      { ...attempt, schemaVersion: "EXECUTION_ATTEMPT_V2" },
      { ...attempt, executionAttemptId: " bad " },
    ]) {
      expect(hydrateLiveTradingOrchestrationSession(input({
        latestExecutionAttempt: invalid as ExecutionAttempt,
      }))).toMatchObject({
        status: "ORCHESTRATION_SESSION_HYDRATION_REJECTED",
        reason: "HYDRATION_AUTHORITY_INCOHERENT",
      });
    }
  });

  it("accepts the safely recreated risk basis by exact reference", () => {
    const attempt = authority();
    const basis = riskBasis(attempt);
    const result = hydrateLiveTradingOrchestrationSession(input({ latestExecutionAttempt: attempt, riskBasis: basis }));
    expect(result.status).toBe("ORCHESTRATION_SESSION_HYDRATED");
    if (result.status === "ORCHESTRATION_SESSION_HYDRATED") {
      expect(result.session.latestExecutionAttempt).toBe(attempt);
      expect(result.session.riskBasis).toBe(basis);
    }
  });

  it.each([
    ["executionAttemptId", "other-attempt"],
    ["executionPlanId", "other-plan"],
    ["tradeIntentId", "other-intent"],
    ["candidateId", "other-candidate"],
    ["instrumentId", otherInstrument],
  ] as const)("rejects risk-basis %s mismatch", (field, value) => {
    const attempt = authority();
    const basis = { ...riskBasis(attempt), [field]: value } as TradeRiskBasis;
    expect(hydrateLiveTradingOrchestrationSession(input({ latestExecutionAttempt: attempt, riskBasis: basis })))
      .toMatchObject({ reason: "HYDRATION_RISK_BASIS_INCOHERENT" });
  });

  it("rejects a risk basis without an attempt", () => {
    const attempt = authority();
    expect(hydrateLiveTradingOrchestrationSession(input({ riskBasis: riskBasis(attempt) })))
      .toMatchObject({ reason: "HYDRATION_RISK_BASIS_INCOHERENT" });
  });

  it("rejects latest R without a risk basis or from another attempt", () => {
    const attempt = authority();
    const basis = riskBasis(attempt);
    const r = projectedR(attempt, basis);
    expect(hydrateLiveTradingOrchestrationSession(input({ latestExecutionAttempt: attempt, latestRealtimeRMultiple: r })))
      .toMatchObject({ reason: "HYDRATION_R_MULTIPLE_INCOHERENT" });
    const other = {
      ...r,
      snapshot: { ...r.snapshot, executionAttemptId: "other-attempt" },
    } as TradeRMultipleProjectedRealtimeResult;
    expect(hydrateLiveTradingOrchestrationSession(input({
      latestExecutionAttempt: attempt, riskBasis: basis, latestRealtimeRMultiple: other,
    }))).toMatchObject({ reason: "HYDRATION_R_MULTIPLE_INCOHERENT" });
  });

  it("rejects an equal-value but different risk-basis reference in latest R", () => {
    const attempt = authority();
    const basisA = riskBasis(attempt);
    const basisB = riskBasis(attempt);
    expect(basisA).toEqual(basisB);
    expect(basisA).not.toBe(basisB);
    expect(hydrateLiveTradingOrchestrationSession(input({
      latestExecutionAttempt: attempt,
      riskBasis: basisB,
      latestRealtimeRMultiple: projectedR(attempt, basisA),
    }))).toMatchObject({ reason: "HYDRATION_R_MULTIPLE_INCOHERENT" });
  });

  it("retains a coherent latest R exact reference without recomputation", () => {
    const attempt = authority();
    const basis = riskBasis(attempt);
    const r = projectedR(attempt, basis);
    const result = hydrateLiveTradingOrchestrationSession(input({
      latestExecutionAttempt: attempt, riskBasis: basis, latestRealtimeRMultiple: r,
    }));
    expect(result.status).toBe("ORCHESTRATION_SESSION_HYDRATED");
    if (result.status === "ORCHESTRATION_SESSION_HYDRATED") {
      expect(result.session.riskBasis).toBe(basis);
      expect(result.session.latestRealtimeRMultiple).toBe(r);
      expect(result.session.latestRealtimeRMultiple?.snapshot.riskBasis).toBe(basis);
    }
  });

  it("restores the graph and matches equivalent fresh-session planner behavior", () => {
    const attempt = authority();
    const basisCreation = createTradeRiskBasisFromExecutionAttempt(attempt);
    if (basisCreation.status !== "TRADE_RISK_BASIS_CREATED") throw new Error("basis fixture rejected");
    const hydrated = hydrateLiveTradingOrchestrationSession(input({
      latestExecutionAttempt: attempt,
      riskBasis: basisCreation.riskBasis,
    }));
    if (hydrated.status !== "ORCHESTRATION_SESSION_HYDRATED") throw new Error("hydration rejected");

    const fresh = createLiveTradingOrchestrationSession({
      sessionId: "session-1", mode: "DRY_RUN", instrumentId: instrument,
    });
    const adopted = planLiveTradingStep(fresh, {
      kind: "REALTIME_EXECUTION_SUBMISSION_RESULT",
      result: Object.freeze({ status: "SUBMISSION_CONFIRMED", executionAttempt: attempt }) as never,
    });
    const established = planLiveTradingStep(adopted.session, {
      kind: "TRADE_RISK_BASIS_CREATION_RESULT",
      result: basisCreation,
    });
    const next = { kind: "TRADE_RISK_BASIS_CREATION_RESULT", result: basisCreation } as const;
    const fromHydrated = planLiveTradingStep(hydrated.session, next);
    const fromFresh = planLiveTradingStep(established.session, next);

    expect(hydrated.session.latestExecutionAttempt).toBe(attempt);
    expect(hydrated.session.riskBasis).toBe(basisCreation.riskBasis);
    expect(fromHydrated.status).toBe("NO_ACTION");
    expect(fromHydrated).toEqual(fromFresh);
  });
});
