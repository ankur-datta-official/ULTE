import {
  brokerAdapterId,
  credentialProfileRef,
  isExecutionEnvironment,
} from "@ulte/broker-adapters";
import {
  createExecutionAttempt,
  requestEntrySubmission,
} from "@ulte/execution-engine";
import {
  orchestrateEntrySubmission as defaultOrchestrateEntrySubmission,
  type EntryOrchestrationResult,
} from "@ulte/execution-reconciliation-engine";
import { unixMs } from "@ulte/instrument-model";
import { createRealtimeExecutionSubmissionConfig } from "./config.js";
import type {
  DurableControlSubmissionResult,
  RealtimeExecutionSubmissionConfig,
  RealtimeExecutionSubmissionDependencies,
  RealtimeExecutionSubmissionInput,
  RealtimeExecutionSubmissionResult,
} from "./types.js";

function wrapDurableResult(
  preparationCycleId: RealtimeExecutionSubmissionInput["preparation"]["preparationCycleId"],
  submissionAsOf: ReturnType<typeof unixMs>,
  executionAttempt: DurableControlSubmissionResult["executionAttempt"],
  durableResult: EntryOrchestrationResult,
): RealtimeExecutionSubmissionResult {
  const base = { preparationCycleId, submissionAsOf, executionAttempt, durableResult };
  if (durableResult.status === "CONFIRMED") {
    return Object.freeze({ status: "SUBMISSION_CONFIRMED", ...base, durableResult });
  }
  if (durableResult.status === "REJECTED") {
    return Object.freeze({ status: "SUBMISSION_REJECTED", ...base, durableResult });
  }
  if (durableResult.status === "RECONCILIATION_REQUIRED") {
    return Object.freeze({ status: "RECONCILIATION_REQUIRED", ...base, durableResult });
  }
  return Object.freeze({ status: "DURABLE_SUBMISSION_CONTROL", ...base, durableResult });
}

export class RealtimeExecutionSubmissionEngine {
  readonly #config: RealtimeExecutionSubmissionConfig;
  readonly #dependencies: RealtimeExecutionSubmissionDependencies;

  constructor(
    config: RealtimeExecutionSubmissionConfig,
    dependencies: RealtimeExecutionSubmissionDependencies,
  ) {
    this.#config = createRealtimeExecutionSubmissionConfig(config);
    this.#dependencies = Object.freeze({ ...dependencies });
  }

  async submit(input: RealtimeExecutionSubmissionInput): Promise<RealtimeExecutionSubmissionResult> {
    const preparation = input.preparation;
    if (preparation.status !== "EXECUTION_PREPARED") {
      return Object.freeze({
        status: "NO_SUBMISSION",
        preparationCycleId: preparation.preparationCycleId,
        upstreamStatus: preparation.status,
      });
    }

    if (input.context === undefined) {
      throw new TypeError("Submission context is required for EXECUTION_PREPARED");
    }
    const context = input.context;
    if (!isExecutionEnvironment(context.executionEnvironment)) {
      throw new TypeError("Invalid execution environment");
    }
    const submissionAsOf = unixMs(context.submissionAsOf);
    const adapterId = brokerAdapterId(context.adapterId);
    const profileRef = credentialProfileRef(context.credentialProfileRef);
    if (submissionAsOf < preparation.preparationAsOf) {
      throw new TypeError("submissionAsOf cannot precede preparationAsOf");
    }

    if (context.executionEnvironment === "LIVE") {
      return Object.freeze({
        status: "SUBMISSION_BLOCKED",
        reason: "LIVE_EXECUTION_DEFERRED",
        preparationCycleId: preparation.preparationCycleId,
        submissionAsOf,
      });
    }

    const preparedPlanAgeMs = submissionAsOf - preparation.preparationAsOf;
    if (preparedPlanAgeMs > this.#config.maxPreparedPlanAgeMs) {
      return Object.freeze({
        status: "SUBMISSION_BLOCKED",
        reason: "PREPARED_PLAN_EXPIRED",
        preparationCycleId: preparation.preparationCycleId,
        submissionAsOf,
      });
    }

    const adapter = this.#dependencies.adapterRegistry.get(adapterId);
    if (adapter === undefined) throw new TypeError(`Unknown broker adapter ID: ${adapterId}`);
    if (adapter.descriptor.environment !== context.executionEnvironment) {
      throw new TypeError("Broker adapter does not match the requested execution environment");
    }
    if (adapter.descriptor.credentialProfileRef !== profileRef) {
      throw new TypeError("Broker adapter does not match the requested credential profile");
    }

    const attempt = createExecutionAttempt(preparation.executionPreparationResult);
    if (attempt.status !== "EXECUTION_ATTEMPT_READY") {
      throw new TypeError("Prepared execution plan was rejected by execution policy");
    }
    const policyResult = requestEntrySubmission(attempt, adapter.capabilities);
    if (policyResult.status !== "ENTRY_SUBMISSION_READY") {
      return Object.freeze({
        status: "SUBMISSION_BLOCKED",
        reason: "ADAPTER_EXECUTION_UNSUPPORTED",
        preparationCycleId: preparation.preparationCycleId,
        submissionAsOf,
        executionPolicyResult: policyResult,
      });
    }

    const orchestrate = this.#dependencies.orchestrateEntrySubmission
      ?? defaultOrchestrateEntrySubmission;
    const durableResult = await orchestrate({
      adapter,
      idempotencyRepository: this.#dependencies.idempotencyRepository,
      request: policyResult.request,
      occurredAt: submissionAsOf,
      ...(this.#dependencies.auditSink === undefined
        ? {}
        : { auditSink: this.#dependencies.auditSink }),
    });
    return wrapDurableResult(
      preparation.preparationCycleId,
      submissionAsOf,
      policyResult.attempt,
      durableResult,
    );
  }
}
