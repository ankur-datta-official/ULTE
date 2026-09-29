import { instrumentId } from "@ulte/instrument-model";
import {
  EXECUTION_ATTEMPT_SCHEMA_VERSION,
  type ExecutionAttempt,
} from "@ulte/execution-engine";
import type { InstrumentId } from "@ulte/instrument-model";
import type { RealtimeExecutionExitFillResult } from "@ulte/realtime-execution-exit-fill-engine";
import type { RealtimeExecutionFillResult } from "@ulte/realtime-execution-fill-engine";
import type { RealtimeExecutionProtectionResult } from "@ulte/realtime-execution-protection-engine";
import type { RealtimeExecutionProtectionLifecycleResult } from "@ulte/realtime-execution-protection-lifecycle-engine";
import type {
  LiveTradingOrchestrationCommand,
  LiveTradingOrchestrationInput,
  LiveTradingOrchestrationObservedReference,
  LiveTradingOrchestrationRejectionReason,
  LiveTradingOrchestrationSession,
  LiveTradingOrchestrationStepResult,
} from "./types.js";
import {
  LIVE_TRADING_ORCHESTRATION_MODES,
  LIVE_TRADING_ORCHESTRATION_SESSION_SCHEMA_VERSION,
} from "./types.js";

function noAction(
  session: LiveTradingOrchestrationSession,
  reference?: LiveTradingOrchestrationObservedReference,
): LiveTradingOrchestrationStepResult {
  return Object.freeze({ status: "NO_ACTION", session, ...(reference === undefined ? {} : { reference }) });
}

function needsContext(
  session: LiveTradingOrchestrationSession,
  reference?: LiveTradingOrchestrationObservedReference,
): LiveTradingOrchestrationStepResult {
  return Object.freeze({
    status: "NEEDS_CONTEXT",
    reason: "MISSING_REQUIRED_CONTEXT",
    session,
    ...(reference === undefined ? {} : { reference }),
  });
}

function rejected(
  session: LiveTradingOrchestrationSession,
  reason: LiveTradingOrchestrationRejectionReason,
  reference?: LiveTradingOrchestrationObservedReference,
): LiveTradingOrchestrationStepResult {
  return Object.freeze({
    status: "ORCHESTRATION_REJECTED",
    reason,
    session,
    ...(reference === undefined ? {} : { reference }),
  });
}

function planned(
  session: LiveTradingOrchestrationSession,
  command: LiveTradingOrchestrationCommand,
  reference?: LiveTradingOrchestrationObservedReference,
): LiveTradingOrchestrationStepResult {
  return Object.freeze({
    status: "COMMAND_PLANNED",
    session,
    command: Object.freeze(command),
    ...(reference === undefined ? {} : { reference }),
  });
}

function validSession(session: LiveTradingOrchestrationSession): boolean {
  if (!Object.isFrozen(session)) return false;
  if (session.schemaVersion !== LIVE_TRADING_ORCHESTRATION_SESSION_SCHEMA_VERSION) return false;
  if (typeof session.sessionId !== "string" || session.sessionId.length === 0 || session.sessionId.trim() !== session.sessionId) {
    return false;
  }
  if (!(LIVE_TRADING_ORCHESTRATION_MODES as readonly unknown[]).includes(session.mode)) return false;
  try {
    instrumentId(session.instrumentId);
  } catch {
    return false;
  }
  if (session.latestExecutionAttempt !== undefined) {
    if (session.latestExecutionAttempt.instrumentId !== session.instrumentId) return false;
    if (session.latestExecutionAttempt.schemaVersion !== EXECUTION_ATTEMPT_SCHEMA_VERSION) return false;
    if (!validTradeIdentity(session.latestExecutionAttempt)) return false;
  }
  if (session.riskBasis !== undefined) {
    if (session.riskBasis.instrumentId !== session.instrumentId) return false;
    if (session.riskBasis.schemaVersion !== "TRADE_RISK_BASIS_V1") return false;
    if (session.latestExecutionAttempt !== undefined &&
        !sameTradeIdentity(session.riskBasis, session.latestExecutionAttempt)) return false;
  }
  if (session.latestRealtimeRMultiple !== undefined) {
    if (session.latestRealtimeRMultiple.status !== "TRADE_R_MULTIPLE_PROJECTED") return false;
    if (session.latestExecutionAttempt === undefined || session.riskBasis === undefined) return false;
    if (!sameTradeIdentity(session.latestRealtimeRMultiple.snapshot, session.latestExecutionAttempt)) return false;
    if (session.latestRealtimeRMultiple.snapshot.instrumentId !== session.instrumentId) return false;
    if (session.latestRealtimeRMultiple.snapshot.riskBasis !== session.riskBasis) return false;
  }
  return true;
}

function validAttemptId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.trim() === value;
}

function validTradeIdentity(authority: Readonly<{
  executionAttemptId: string;
  executionPlanId: string;
  tradeIntentId: string;
  candidateId: string;
}>): boolean {
  return validAttemptId(authority.executionAttemptId)
    && validAttemptId(authority.executionPlanId)
    && validAttemptId(authority.tradeIntentId)
    && validAttemptId(authority.candidateId);
}

function sameTradeIdentity(
  authority: Readonly<{
    executionAttemptId: string;
    executionPlanId: string;
    tradeIntentId: string;
    candidateId: string;
    instrumentId: InstrumentId;
  }>,
  attempt: ExecutionAttempt,
): boolean {
  return authority.executionAttemptId === attempt.executionAttemptId
    && authority.executionPlanId === attempt.executionPlanId
    && authority.tradeIntentId === attempt.tradeIntentId
    && authority.candidateId === attempt.candidateId
    && authority.instrumentId === attempt.instrumentId;
}

function attemptCoherence(
  session: LiveTradingOrchestrationSession,
  attempt: ExecutionAttempt,
): LiveTradingOrchestrationRejectionReason | undefined {
  if (attempt.schemaVersion !== EXECUTION_ATTEMPT_SCHEMA_VERSION ||
      !validAttemptId(attempt.executionAttemptId)) {
    return "EXECUTION_ATTEMPT_INCOHERENT";
  }
  if (attempt.instrumentId !== session.instrumentId) return "INSTRUMENT_INCOHERENT";
  if (session.latestExecutionAttempt !== undefined &&
      session.latestExecutionAttempt.executionAttemptId !== attempt.executionAttemptId) {
    return "EXECUTION_ATTEMPT_INCOHERENT";
  }
  return undefined;
}

function projectedAttemptCoherence(
  session: LiveTradingOrchestrationSession,
  executionAttemptId: string,
): LiveTradingOrchestrationRejectionReason | undefined {
  if (session.latestExecutionAttempt !== undefined &&
      executionAttemptId !== session.latestExecutionAttempt.executionAttemptId) {
    return "EXECUTION_ATTEMPT_INCOHERENT";
  }
  return undefined;
}

function adoptAttempt(
  session: LiveTradingOrchestrationSession,
  attempt: ExecutionAttempt,
): LiveTradingOrchestrationSession {
  if (session.latestExecutionAttempt === attempt) return session;
  return Object.freeze({ ...session, latestExecutionAttempt: attempt });
}

function adoptAttemptOrReject(
  session: LiveTradingOrchestrationSession,
  attempt: ExecutionAttempt,
  reference?: LiveTradingOrchestrationObservedReference,
): LiveTradingOrchestrationSession | LiveTradingOrchestrationStepResult {
  const reason = attemptCoherence(session, attempt);
  return reason === undefined ? adoptAttempt(session, attempt) : rejected(session, reason, reference);
}

function isStepResult(
  value: LiveTradingOrchestrationSession | LiveTradingOrchestrationStepResult,
): value is LiveTradingOrchestrationStepResult {
  return "session" in value;
}

function attemptFromEntryResult(result: RealtimeExecutionFillResult): ExecutionAttempt | undefined {
  return result.status === "FILL_APPLIED" || result.status === "DUPLICATE_FILL"
    ? result.executionAttempt
    : undefined;
}

function attemptFromExitResult(result: RealtimeExecutionExitFillResult): ExecutionAttempt | undefined {
  return result.status === "EXIT_FILL_APPLIED" || result.status === "DUPLICATE_EXIT_FILL"
    ? result.executionAttempt
    : undefined;
}

function attemptFromProtectionResult(result: RealtimeExecutionProtectionResult): ExecutionAttempt | undefined {
  return "executionAttempt" in result ? result.executionAttempt : undefined;
}

function attemptFromProtectionLifecycle(
  result: RealtimeExecutionProtectionLifecycleResult,
): ExecutionAttempt | undefined {
  return result.status === "PROTECTION_ACKNOWLEDGEMENT_APPLIED" ? result.executionAttempt : undefined;
}

function lifecycleAttempt(
  input: Extract<LiveTradingOrchestrationInput,
    { readonly kind: "POSITION_EXPOSURE_REQUEST" | "REALIZED_ACCOUNTING_REQUEST" | "VALUATION_REQUEST" | "COST_ACCOUNTING_REQUEST" }
  >["input"],
): ExecutionAttempt | undefined {
  return input.sourceKind === "ENTRY_FILL"
    ? attemptFromEntryResult(input.fillLifecycle)
    : attemptFromExitResult(input.exitFillLifecycle);
}

function isCurrentAttempt(session: LiveTradingOrchestrationSession, attempt: ExecutionAttempt): boolean {
  return session.latestExecutionAttempt === attempt;
}

/** Plans exactly one existing ULTE call and never invokes it. */
export function planLiveTradingStep(
  session: LiveTradingOrchestrationSession,
  input: LiveTradingOrchestrationInput,
): LiveTradingOrchestrationStepResult {
  if (!validSession(session)) return rejected(session, "INVALID_SESSION");

  switch (input.kind) {
    case "OBSERVED_LIVE_TRADE":
      if (input.event.event.instrumentId !== session.instrumentId) {
        return rejected(session, "INSTRUMENT_INCOHERENT");
      }
      return planned(session, {
        operation: "PROCESS_LIVE_INGESTION",
        event: input.event,
        observationTime: input.observationTime,
      });

    case "LIVE_INGESTION_RESULT":
      if (input.result.status !== "ACCEPTED") return noAction(session, input.result);
      return planned(session, { operation: "PROCESS_REALTIME_ANALYSIS", input: input.result }, input.result);

    case "REALTIME_ANALYSIS_RESULT": {
      if (input.result.status !== "ANALYSIS_CYCLES" || input.result.cycles.length === 0) {
        return noAction(session, input.result);
      }
      if (input.decisionInput === undefined) return needsContext(session, input.result);
      const analysis = input.decisionInput.analysis;
      if (!input.result.cycles.some((cycle) => cycle === analysis)) {
        return rejected(session, "INPUT_INCOHERENT", input.result);
      }
      if (analysis.instrumentId !== session.instrumentId) {
        return rejected(session, "INSTRUMENT_INCOHERENT", input.result);
      }
      if (analysis.status === "INSUFFICIENT_HISTORY" || analysis.status === "NO_SETUP") {
        return noAction(session, input.result);
      }
      const confirmedCount = analysis.setup.status === "READY"
        ? analysis.setup.candidates.filter((candidate) => candidate.stage === "CONFIRMED").length
        : 0;
      if (confirmedCount === 1 && input.decisionInput.context === undefined) {
        return needsContext(session, input.result);
      }
      return planned(session, {
        operation: "PROCESS_REALTIME_DECISION",
        input: input.decisionInput,
      }, input.result);
    }

    case "REALTIME_DECISION_RESULT":
      if (input.result.status !== "TRADE_INTENT_CREATED") return noAction(session, input.result);
      if (input.result.tradeIntentResult.instrumentId !== session.instrumentId) {
        return rejected(session, "INSTRUMENT_INCOHERENT", input.result);
      }
      if (input.preparationInput === undefined || input.preparationInput.context === undefined) {
        return needsContext(session, input.result);
      }
      if (input.preparationInput.decision !== input.result) {
        return rejected(session, "INPUT_INCOHERENT", input.result);
      }
      if (input.preparationInput.context.marketSnapshot.instrumentId !== session.instrumentId ||
          input.preparationInput.context.instrumentExecutionSpec.instrumentId !== session.instrumentId) {
        return rejected(session, "INSTRUMENT_INCOHERENT", input.result);
      }
      return planned(session, {
        operation: "PROCESS_REALTIME_EXECUTION_PREPARATION",
        input: input.preparationInput,
      }, input.result);

    case "REALTIME_EXECUTION_PREPARATION_RESULT":
      if (input.result.status !== "EXECUTION_PREPARED") return noAction(session, input.result);
      if (input.result.executionPreparationResult.instrumentId !== session.instrumentId) {
        return rejected(session, "INSTRUMENT_INCOHERENT", input.result);
      }
      if (session.mode === "DRY_RUN") return noAction(session, input.result);
      if (input.submissionInput === undefined || input.submissionInput.context === undefined) {
        return needsContext(session, input.result);
      }
      if (input.submissionInput.preparation !== input.result) {
        return rejected(session, "INPUT_INCOHERENT", input.result);
      }
      if (input.submissionInput.context.executionEnvironment === "LIVE") {
        return rejected(session, "UNSUPPORTED_LIVE_OPERATION", input.result);
      }
      if (input.submissionInput.context.executionEnvironment !== "SANDBOX") {
        return rejected(session, "INPUT_INCOHERENT", input.result);
      }
      return planned(session, {
        operation: "SUBMIT_REALTIME_EXECUTION",
        input: input.submissionInput,
      }, input.result);

    case "REALTIME_EXECUTION_SUBMISSION_RESULT": {
      const result = input.result;
      let nextSession = session;
      if ("executionAttempt" in result) {
        const adopted = adoptAttemptOrReject(session, result.executionAttempt, result);
        if (isStepResult(adopted)) return adopted;
        nextSession = adopted;
      }
      return result.status === "SUBMISSION_CONFIRMED"
        ? planned(nextSession, {
            operation: "INITIALIZE_REALTIME_EXECUTION_FILL_LIFECYCLE",
            input: result,
          }, result)
        : noAction(nextSession, result);
    }

    case "FILL_LIFECYCLE_INITIALIZATION_RESULT": {
      const result = input.result;
      if (result.status !== "FILL_LIFECYCLE_INITIALIZED") return noAction(session, result);
      const adopted = adoptAttemptOrReject(session, result.executionAttempt, result);
      if (isStepResult(adopted)) return adopted;
      if (adopted.riskBasis !== undefined) return noAction(adopted, result);
      return planned(adopted, {
        operation: "CREATE_TRADE_RISK_BASIS",
        executionAttempt: result.executionAttempt,
      }, result);
    }

    case "OBSERVED_ENTRY_FILL": {
      const attempt = input.input.executionAttempt;
      const reason = attemptCoherence(session, attempt);
      if (reason !== undefined) return rejected(session, reason);
      if (input.input.submission.status === "SUBMISSION_CONFIRMED") {
        if (!("executionAttempt" in input.input.submission)) {
          return rejected(session, "INPUT_INCOHERENT");
        }
        const submissionReason = attemptCoherence(session, input.input.submission.executionAttempt);
        if (submissionReason !== undefined) return rejected(session, submissionReason);
      }
      if (!isCurrentAttempt(session, attempt)) return rejected(session, "INPUT_INCOHERENT");
      if (input.input.submission.status !== "SUBMISSION_CONFIRMED") return noAction(session);
      return planned(session, { operation: "APPLY_REALTIME_EXECUTION_FILL", input: input.input });
    }

    case "REALTIME_ENTRY_FILL_RESULT": {
      const result = input.result;
      const attempt = attemptFromEntryResult(result);
      if (attempt === undefined) return noAction(session, result);
      const adopted = adoptAttemptOrReject(session, attempt, result);
      if (isStepResult(adopted)) return adopted;
      if (result.status === "DUPLICATE_FILL" || session.mode === "DRY_RUN") {
        return noAction(adopted, result);
      }
      if (input.protectionInput === undefined || input.protectionInput.context === undefined) {
        return needsContext(adopted, result);
      }
      if (input.protectionInput.fillLifecycle !== result) {
        return rejected(adopted, "INPUT_INCOHERENT", result);
      }
      if (input.protectionInput.context.executionEnvironment === "LIVE") {
        return rejected(adopted, "UNSUPPORTED_LIVE_OPERATION", result);
      }
      if (input.protectionInput.context.executionEnvironment !== "SANDBOX") {
        return rejected(adopted, "INPUT_INCOHERENT", result);
      }
      return planned(adopted, {
        operation: "SUBMIT_REALTIME_EXECUTION_PROTECTION",
        input: input.protectionInput,
      }, result);
    }

    case "REALTIME_EXECUTION_PROTECTION_RESULT": {
      const result = input.result;
      const attempt = attemptFromProtectionResult(result);
      let nextSession = session;
      if (attempt !== undefined) {
        const adopted = adoptAttemptOrReject(session, attempt, result);
        if (isStepResult(adopted)) return adopted;
        nextSession = adopted;
      }
      if (result.status !== "PROTECTION_CONFIRMED") return noAction(nextSession, result);
      if (input.lifecycleInput === undefined ||
          input.lifecycleInput.executionAttempt === undefined ||
          input.lifecycleInput.observationAsOf === undefined) {
        return needsContext(nextSession, result);
      }
      if (input.lifecycleInput.protectionResult !== result ||
          input.lifecycleInput.executionAttempt !== nextSession.latestExecutionAttempt) {
        return rejected(nextSession, "INPUT_INCOHERENT", result);
      }
      return planned(nextSession, {
        operation: "APPLY_REALTIME_EXECUTION_PROTECTION_ACKNOWLEDGEMENT",
        input: input.lifecycleInput,
      }, result);
    }

    case "REALTIME_EXECUTION_PROTECTION_LIFECYCLE_RESULT": {
      const attempt = attemptFromProtectionLifecycle(input.result);
      if (attempt === undefined) return noAction(session, input.result);
      const adopted = adoptAttemptOrReject(session, attempt, input.result);
      return isStepResult(adopted) ? adopted : noAction(adopted, input.result);
    }

    case "OBSERVED_EXIT_FILL": {
      const lifecycleAttemptValue = attemptFromProtectionLifecycle(input.input.protectionLifecycle);
      if (lifecycleAttemptValue === undefined) return noAction(session);
      const current = input.input.executionAttempt;
      if (current === undefined) return needsContext(session);
      const lifecycleReason = attemptCoherence(session, lifecycleAttemptValue);
      if (lifecycleReason !== undefined) return rejected(session, lifecycleReason);
      const reason = attemptCoherence(session, current);
      if (reason !== undefined) return rejected(session, reason);
      if (!isCurrentAttempt(session, current)) return rejected(session, "INPUT_INCOHERENT");
      return planned(session, { operation: "APPLY_REALTIME_EXECUTION_EXIT_FILL", input: input.input });
    }

    case "REALTIME_EXECUTION_EXIT_FILL_RESULT": {
      const attempt = attemptFromExitResult(input.result);
      if (attempt === undefined) return noAction(session, input.result);
      const adopted = adoptAttemptOrReject(session, attempt, input.result);
      return isStepResult(adopted) ? adopted : noAction(adopted, input.result);
    }

    case "TRADE_RISK_BASIS_CREATION_RESULT": {
      const result = input.result;
      if (result.status !== "TRADE_RISK_BASIS_CREATED") return noAction(session, result);
      const basis = result.riskBasis;
      if (basis.instrumentId !== session.instrumentId || session.latestExecutionAttempt === undefined ||
          !sameTradeIdentity(basis, session.latestExecutionAttempt)) {
        return rejected(session, "RISK_BASIS_INCOHERENT", result);
      }
      if (session.riskBasis !== undefined && session.riskBasis !== basis) {
        return rejected(session, "RISK_BASIS_INCOHERENT", result);
      }
      if (session.riskBasis === basis) return noAction(session, result);
      return noAction(Object.freeze({ ...session, riskBasis: basis }), result);
    }

    case "POSITION_EXPOSURE_REQUEST":
    case "REALIZED_ACCOUNTING_REQUEST":
    case "VALUATION_REQUEST":
    case "COST_ACCOUNTING_REQUEST": {
      const attempt = lifecycleAttempt(input.input);
      if (attempt === undefined) return noAction(session);
      const reason = attemptCoherence(session, attempt);
      if (reason !== undefined) return rejected(session, reason);
      if (!isCurrentAttempt(session, attempt)) return rejected(session, "INPUT_INCOHERENT");
      if (input.kind !== "POSITION_EXPOSURE_REQUEST" &&
          input.input.accountingSpec.instrumentId !== session.instrumentId) {
        return rejected(session, "INSTRUMENT_INCOHERENT");
      }
      if (input.kind === "VALUATION_REQUEST" &&
          input.input.markSource.instrumentId !== session.instrumentId) {
        return rejected(session, "INSTRUMENT_INCOHERENT");
      }
      if (input.kind === "COST_ACCOUNTING_REQUEST" && input.input.observedCostEvents.some((event) =>
        event.instrumentId !== session.instrumentId || event.executionAttemptId !== attempt.executionAttemptId)) {
        return rejected(session, "INSTRUMENT_INCOHERENT");
      }
      const operation = input.kind === "POSITION_EXPOSURE_REQUEST"
        ? "PROJECT_REALTIME_POSITION_EXPOSURE" as const
        : input.kind === "REALIZED_ACCOUNTING_REQUEST"
          ? "PROJECT_REALTIME_REALIZED_ACCOUNTING" as const
          : input.kind === "VALUATION_REQUEST"
            ? "PROJECT_REALTIME_VALUATION" as const
            : "PROJECT_REALTIME_COST_ACCOUNTING" as const;
      return planned(session, { operation, input: input.input } as LiveTradingOrchestrationCommand);
    }

    case "POSITION_EXPOSURE_RESULT":
      if (input.result.status === "POSITION_EXPOSURE_PROJECTED") {
        const reason = projectedAttemptCoherence(
          session,
          input.result.positionExposure.executionAttemptId,
        );
        if (reason !== undefined) return rejected(session, reason, input.result);
        if (input.result.positionExposure.instrumentId !== session.instrumentId) {
          return rejected(session, "INSTRUMENT_INCOHERENT", input.result);
        }
      }
      return noAction(session, input.result);

    case "REALIZED_ACCOUNTING_RESULT":
      if (input.result.status === "REALIZED_ACCOUNTING_PROJECTED") {
        const reason = projectedAttemptCoherence(session, input.result.accounting.executionAttemptId);
        if (reason !== undefined) return rejected(session, reason, input.result);
        if (input.result.accounting.instrumentId !== session.instrumentId) {
          return rejected(session, "INSTRUMENT_INCOHERENT", input.result);
        }
      }
      return noAction(session, input.result);

    case "COST_ACCOUNTING_RESULT":
      if (input.result.status === "TRADE_COST_ACCOUNTING_PROJECTED") {
        const reason = projectedAttemptCoherence(session, input.result.accounting.executionAttemptId);
        if (reason !== undefined) return rejected(session, reason, input.result);
        if (input.result.accounting.instrumentId !== session.instrumentId) {
          return rejected(session, "INSTRUMENT_INCOHERENT", input.result);
        }
      }
      return noAction(session, input.result);

    case "VALUATION_RESULT":
      if (input.result.status !== "UNREALIZED_VALUATION_PROJECTED") return noAction(session, input.result);
      {
        const reason = projectedAttemptCoherence(session, input.result.valuation.executionAttemptId);
        if (reason !== undefined) return rejected(session, reason, input.result);
      }
      if (input.result.valuation.instrumentId !== session.instrumentId) {
        return rejected(session, "INSTRUMENT_INCOHERENT", input.result);
      }
      return planned(session, {
        operation: "PROJECT_REALTIME_GROSS_PERFORMANCE",
        input: input.result,
      }, input.result);

    case "NET_PERFORMANCE_AUTHORITIES":
      if (input.grossPerformance.status !== "TRADE_PERFORMANCE_PROJECTED" ||
          input.costAccounting.status !== "TRADE_COST_ACCOUNTING_PROJECTED") {
        return noAction(session);
      }
      if (input.grossPerformance.snapshot.executionAttemptId !==
          input.costAccounting.accounting.executionAttemptId) {
        return rejected(session, "EXECUTION_ATTEMPT_INCOHERENT");
      }
      {
        const grossReason = projectedAttemptCoherence(
          session,
          input.grossPerformance.snapshot.executionAttemptId,
        );
        if (grossReason !== undefined) return rejected(session, grossReason);
        const costReason = projectedAttemptCoherence(
          session,
          input.costAccounting.accounting.executionAttemptId,
        );
        if (costReason !== undefined) return rejected(session, costReason);
      }
      if (input.grossPerformance.snapshot.instrumentId !== session.instrumentId ||
          input.costAccounting.accounting.instrumentId !== session.instrumentId) {
        return rejected(session, "INSTRUMENT_INCOHERENT");
      }
      return planned(session, {
        operation: "PROJECT_REALTIME_NET_PERFORMANCE",
        grossPerformance: input.grossPerformance,
        costAccounting: input.costAccounting,
      });

    case "NET_PERFORMANCE_RESULT":
      if (input.result.status !== "NET_TRADE_PERFORMANCE_PROJECTED") return noAction(session, input.result);
      {
        const reason = projectedAttemptCoherence(session, input.result.snapshot.executionAttemptId);
        if (reason !== undefined) return rejected(session, reason, input.result);
      }
      if (input.result.snapshot.instrumentId !== session.instrumentId) {
        return rejected(session, "INSTRUMENT_INCOHERENT", input.result);
      }
      if (session.riskBasis === undefined) return needsContext(session, input.result);
      return planned(session, {
        operation: "PROJECT_REALTIME_R_MULTIPLE",
        netPerformance: input.result,
        riskBasis: session.riskBasis,
      }, input.result);

    case "R_MULTIPLE_RESULT":
      if (input.result.status !== "TRADE_R_MULTIPLE_PROJECTED") return noAction(session, input.result);
      {
        const reason = projectedAttemptCoherence(session, input.result.snapshot.executionAttemptId);
        if (reason !== undefined) return rejected(session, reason, input.result);
      }
      if (input.result.snapshot.instrumentId !== session.instrumentId ||
          input.result.snapshot.riskBasis !== session.riskBasis) {
        return rejected(session, "RISK_BASIS_INCOHERENT", input.result);
      }
      if (session.latestExecutionAttempt !== undefined &&
          !sameTradeIdentity(input.result.snapshot, session.latestExecutionAttempt)) {
        return rejected(session, "EXECUTION_ATTEMPT_INCOHERENT", input.result);
      }
      if (session.latestRealtimeRMultiple === input.result) return noAction(session, input.result);
      return noAction(Object.freeze({ ...session, latestRealtimeRMultiple: input.result }), input.result);
  }
}

/** Optional stateless wrapper for runners that prefer an engine-shaped API. */
export class LiveTradingOrchestrationEngine {
  plan(
    session: LiveTradingOrchestrationSession,
    input: LiveTradingOrchestrationInput,
  ): LiveTradingOrchestrationStepResult {
    return planLiveTradingStep(session, input);
  }
}
