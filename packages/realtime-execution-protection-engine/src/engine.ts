import {
  brokerAdapterId,
  credentialProfileRef,
  isExecutionEnvironment,
} from "@ulte/broker-adapters";
import {
  requestProtection,
  type AdapterCapabilities,
  type ProtectionRequestTransitionResult,
} from "@ulte/execution-engine";
import {
  orchestrateProtectionSubmission as defaultOrchestrateProtectionSubmission,
  type ProtectionOrchestrationResult,
} from "@ulte/execution-reconciliation-engine";
import { unixMs } from "@ulte/instrument-model";
import type {
  DurableProtectionControlResult,
  RealtimeExecutionProtectionDependencies,
  RealtimeExecutionProtectionInput,
  RealtimeExecutionProtectionResult,
} from "./types.js";

function sameCapabilities(left: AdapterCapabilities, right: AdapterCapabilities): boolean {
  return left.supportsClientIdempotency === right.supportsClientIdempotency
    && left.supportsCloseOnlyExit === right.supportsCloseOnlyExit
    && left.supportsNativeBracketProtection === right.supportsNativeBracketProtection
    && left.supportsProtectionModification === right.supportsProtectionModification
    && left.supportsOrderCancellation === right.supportsOrderCancellation
    && left.supportsPartialFillReporting === right.supportsPartialFillReporting;
}

function noAction(
  input: RealtimeExecutionProtectionInput,
  reason: "UPSTREAM_NOT_ACTIONABLE" | "DUPLICATE_FILL_NO_ACTION",
): RealtimeExecutionProtectionResult {
  const lifecycle = input.fillLifecycle;
  return Object.freeze({
    status: "NO_PROTECTION_ACTION",
    reason,
    preparationCycleId: lifecycle.preparationCycleId,
    upstreamStatus: lifecycle.status,
    ...("executionAttempt" in lifecycle ? { executionAttempt: lifecycle.executionAttempt } : {}),
  });
}

function wrapDurableResult(
  preparationCycleId: RealtimeExecutionProtectionInput["fillLifecycle"]["preparationCycleId"],
  protectionAsOf: ReturnType<typeof unixMs>,
  policyResult: Extract<
    ProtectionRequestTransitionResult,
    { readonly status: "PROTECTION_REQUEST_READY" }
  >,
  durableResult: ProtectionOrchestrationResult,
): RealtimeExecutionProtectionResult {
  const base = {
    preparationCycleId,
    protectionAsOf,
    executionAttempt: policyResult.attempt,
    protectionRequest: policyResult.request,
    executionPolicyResult: policyResult,
    durableResult,
  };
  if (durableResult.status === "CONFIRMED") {
    return Object.freeze({ status: "PROTECTION_CONFIRMED", ...base, durableResult });
  }
  if (durableResult.status === "REJECTED") {
    return Object.freeze({ status: "PROTECTION_REJECTED", ...base, durableResult });
  }
  if (durableResult.status === "RECONCILIATION_REQUIRED") {
    return Object.freeze({ status: "RECONCILIATION_REQUIRED", ...base, durableResult });
  }
  return Object.freeze({ status: "DURABLE_PROTECTION_CONTROL", ...base, durableResult });
}

export class RealtimeExecutionProtectionEngine {
  readonly #dependencies: RealtimeExecutionProtectionDependencies;

  constructor(dependencies: RealtimeExecutionProtectionDependencies) {
    this.#dependencies = Object.freeze({ ...dependencies });
  }

  async submit(input: RealtimeExecutionProtectionInput): Promise<RealtimeExecutionProtectionResult> {
    const lifecycle = input.fillLifecycle;
    if (lifecycle.status === "DUPLICATE_FILL") {
      return noAction(input, "DUPLICATE_FILL_NO_ACTION");
    }
    if (lifecycle.status !== "FILL_APPLIED") {
      return noAction(input, "UPSTREAM_NOT_ACTIONABLE");
    }

    const policyResult = requestProtection(lifecycle.executionAttempt);
    if (policyResult.status !== "PROTECTION_REQUEST_READY") {
      return Object.freeze({
        status: "NO_PROTECTION_ACTION",
        reason: "PROTECTION_POLICY_NOT_ACTIONABLE",
        preparationCycleId: lifecycle.preparationCycleId,
        upstreamStatus: lifecycle.status,
        executionAttempt: lifecycle.executionAttempt,
        executionPolicyResult: policyResult,
      });
    }

    if (input.context === undefined) {
      throw new TypeError("Protection context is required for an actionable fill");
    }
    const context = input.context;
    if (!isExecutionEnvironment(context.executionEnvironment)) {
      throw new TypeError("Invalid execution environment");
    }
    const protectionAsOf = unixMs(context.protectionAsOf);
    const adapterId = brokerAdapterId(context.adapterId);
    const profileRef = credentialProfileRef(context.credentialProfileRef);
    const lastExecutionEventAt = lifecycle.executionAttempt.lastExecutionEventAt;
    if (lastExecutionEventAt === undefined) {
      throw new TypeError("Actionable execution attempt lacks lastExecutionEventAt");
    }
    if (protectionAsOf < lastExecutionEventAt) {
      throw new TypeError("protectionAsOf cannot precede lastExecutionEventAt");
    }

    if (context.executionEnvironment === "LIVE") {
      return Object.freeze({
        status: "PROTECTION_SUBMISSION_BLOCKED",
        reason: "LIVE_EXECUTION_DEFERRED",
        preparationCycleId: lifecycle.preparationCycleId,
        protectionAsOf,
        executionAttempt: policyResult.attempt,
        executionPolicyResult: policyResult,
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
    const attemptCapabilities = lifecycle.executionAttempt.adapterCapabilities;
    if (
      attemptCapabilities === undefined
      || !sameCapabilities(attemptCapabilities, adapter.capabilities)
    ) {
      return Object.freeze({
        status: "PROTECTION_SUBMISSION_BLOCKED",
        reason: "ADAPTER_PROTECTION_UNSUPPORTED",
        preparationCycleId: lifecycle.preparationCycleId,
        protectionAsOf,
        executionAttempt: policyResult.attempt,
        executionPolicyResult: policyResult,
      });
    }

    const orchestrate = this.#dependencies.orchestrateProtectionSubmission
      ?? defaultOrchestrateProtectionSubmission;
    const durableResult = await orchestrate({
      adapter,
      idempotencyRepository: this.#dependencies.idempotencyRepository,
      request: policyResult.request,
      occurredAt: protectionAsOf,
      ...(this.#dependencies.auditSink === undefined
        ? {}
        : { auditSink: this.#dependencies.auditSink }),
    });
    return wrapDurableResult(
      lifecycle.preparationCycleId,
      protectionAsOf,
      policyResult,
      durableResult,
    );
  }
}
