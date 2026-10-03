import {
  READY_EXECUTION_PLAN_RECOVERY_DATA_SCHEMA_VERSION,
  createExecutionMarketSnapshot,
  createExecutionPreparationConfig,
  createInstrumentExecutionSpec,
  prepareExecutionPlan,
  type ReadyExecutionPlan,
  type ReadyExecutionPlanRecoverySelectorV2,
} from "../../packages/execution-preparation-engine/src/index.js";
import { createExecutionAttempt, type ExecutionAttemptRecoveryEvidenceV1,
  type ExecutionAttemptRecoveryTransition } from "../../packages/execution-engine/src/index.js";
import { PHASE33A_AS_OF, PHASE33A_EXECUTION_AS_OF, PHASE33A_INSTRUMENT,
  createReadyTradeIntentRecoveryFixture } from "./phase33a-recovery-fixture.js";

function selector(plan: ReadyExecutionPlan): ReadyExecutionPlanRecoverySelectorV2 {
  const { executionPlanId, tradeIntentId, candidateId, instrumentId, intentAsOf, marketSnapshotAsOf,
    preparedAsOf, direction, entrySide, exitSide, quantity, quantityUnit, accountCurrency,
    entryInstruction, protectiveStopInstruction, profitTargetInstruction, priceTick, quantityStep,
    bidAtPreparation, askAtPreparation, intentAgeMs, quoteAgeMs, entryDeviationBps,
    approvedRiskAmount, actualRiskAmount, netRewardRiskBps } = plan;
  return { executionPlanId, tradeIntentId, candidateId, instrumentId, intentAsOf, marketSnapshotAsOf,
    preparedAsOf, direction, entrySide, exitSide, quantity, quantityUnit, accountCurrency,
    entryInstruction: { ...entryInstruction }, protectiveStopInstruction: { ...protectiveStopInstruction },
    profitTargetInstruction: { ...profitTargetInstruction }, priceTick, quantityStep,
    bidAtPreparation, askAtPreparation, intentAgeMs, quoteAgeMs, entryDeviationBps,
    approvedRiskAmount, actualRiskAmount, netRewardRiskBps };
}

export function checkpointEvidence(
  transitions: readonly ExecutionAttemptRecoveryTransition[] = [],
  quantity = "12",
): ExecutionAttemptRecoveryEvidenceV1 {
  const intent = createReadyTradeIntentRecoveryFixture(quantity);
  const marketSnapshot = { instrumentId: PHASE33A_INSTRUMENT, asOf: PHASE33A_AS_OF + 50,
    bid: intent.tradeIntent.entryReferencePrice, ask: intent.tradeIntent.entryReferencePrice };
  const instrumentExecutionSpec = { instrumentId: PHASE33A_INSTRUMENT, priceTick: "1", quantityStep: "1",
    minimumQuantity: "1", maximumQuantity: "100" };
  const config = { maxIntentAgeMs: 100, maxQuoteAgeMs: 50, maxEntryDeviationBps: 100 };
  const prepared = prepareExecutionPlan({ tradeIntent: intent.tradeIntent,
    executionAsOf: PHASE33A_EXECUTION_AS_OF,
    marketSnapshot: createExecutionMarketSnapshot(marketSnapshot),
    instrumentExecutionSpec: createInstrumentExecutionSpec(instrumentExecutionSpec),
    config: createExecutionPreparationConfig(config) });
  if (prepared.status !== "EXECUTION_PLAN_READY") throw new Error("Checkpoint fixture plan rejected");
  const attempt = createExecutionAttempt(prepared);
  if (attempt.status !== "EXECUTION_ATTEMPT_READY") throw new Error("Checkpoint fixture attempt rejected");
  return {
    schemaVersion: "EXECUTION_ATTEMPT_RECOVERY_EVIDENCE_V1",
    identity: { executionAttemptId: attempt.executionAttemptId, executionPlanId: prepared.executionPlanId,
      tradeIntentId: prepared.tradeIntentId, candidateId: prepared.candidateId, instrumentId: prepared.instrumentId },
    initialization: { executionPlanRecoveryData: {
      recoverySchemaVersion: READY_EXECUTION_PLAN_RECOVERY_DATA_SCHEMA_VERSION,
      tradeIntentEvidence: intent.recoveryEvidence,
      marketSnapshot, instrumentExecutionSpec, config,
      executionAsOf: PHASE33A_EXECUTION_AS_OF, expectedPlan: selector(prepared),
    } },
    transitions,
  };
}
