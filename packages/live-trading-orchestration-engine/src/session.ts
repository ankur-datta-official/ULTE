import { EXECUTION_ATTEMPT_SCHEMA_VERSION, type ExecutionAttempt } from "@ulte/execution-engine";
import { instrumentId } from "@ulte/instrument-model";
import {
  isTradeRiskBasis,
  TRADE_R_MULTIPLE_SNAPSHOT_SCHEMA_VERSION,
  type TradeRiskBasis,
} from "@ulte/trade-r-multiple-engine";
import type { TradeRMultipleProjectedRealtimeResult } from "@ulte/realtime-trade-r-multiple-engine";
import type {
  CreateLiveTradingOrchestrationSessionInput,
  HydrateLiveTradingOrchestrationSessionInput,
  LiveTradingOrchestrationSession,
  LiveTradingOrchestrationSessionHydrationResult,
} from "./types.js";
import {
  LIVE_TRADING_ORCHESTRATION_MODES,
  LIVE_TRADING_ORCHESTRATION_SESSION_SCHEMA_VERSION,
} from "./types.js";

export function createLiveTradingOrchestrationSession(
  input: CreateLiveTradingOrchestrationSessionInput,
): LiveTradingOrchestrationSession {
  if (typeof input.sessionId !== "string" || input.sessionId.length === 0 || input.sessionId.trim() !== input.sessionId) {
    throw new TypeError("sessionId must be non-empty and have no surrounding whitespace");
  }
  if (!(LIVE_TRADING_ORCHESTRATION_MODES as readonly unknown[]).includes(input.mode)) {
    throw new TypeError("mode must be DRY_RUN or SANDBOX");
  }
  return Object.freeze({
    schemaVersion: LIVE_TRADING_ORCHESTRATION_SESSION_SCHEMA_VERSION,
    sessionId: input.sessionId,
    mode: input.mode,
    instrumentId: instrumentId(input.instrumentId),
  });
}

function canonicalId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.trim() === value;
}

function validIdentity(authority: Readonly<{
  executionAttemptId: string;
  executionPlanId: string;
  tradeIntentId: string;
  candidateId: string;
}>): boolean {
  return canonicalId(authority.executionAttemptId)
    && canonicalId(authority.executionPlanId)
    && canonicalId(authority.tradeIntentId)
    && canonicalId(authority.candidateId);
}

function sameIdentity(
  authority: Readonly<{
    executionAttemptId: string;
    executionPlanId: string;
    tradeIntentId: string;
    candidateId: string;
    instrumentId: string;
  }>,
  attempt: ExecutionAttempt,
): boolean {
  return authority.executionAttemptId === attempt.executionAttemptId
    && authority.executionPlanId === attempt.executionPlanId
    && authority.tradeIntentId === attempt.tradeIntentId
    && authority.candidateId === attempt.candidateId
    && authority.instrumentId === attempt.instrumentId;
}

function validAttempt(attempt: ExecutionAttempt, expectedInstrumentId: string): boolean {
  if (attempt.status !== "EXECUTION_ATTEMPT_READY"
      || attempt.schemaVersion !== EXECUTION_ATTEMPT_SCHEMA_VERSION
      || !validIdentity(attempt)
      || attempt.instrumentId !== expectedInstrumentId) return false;
  try {
    instrumentId(attempt.instrumentId);
    return true;
  } catch {
    return false;
  }
}

function validProjectedRMultiple(
  result: TradeRMultipleProjectedRealtimeResult,
  attempt: ExecutionAttempt,
  riskBasis: TradeRiskBasis,
): boolean {
  if (typeof result !== "object" || result === null || result.status !== "TRADE_R_MULTIPLE_PROJECTED") return false;
  const snapshot = result.snapshot;
  if (typeof snapshot !== "object" || snapshot === null
      || snapshot.schemaVersion !== TRADE_R_MULTIPLE_SNAPSHOT_SCHEMA_VERSION
      || !validIdentity(snapshot)
      || !sameIdentity(snapshot, attempt)
      || snapshot.riskBasis !== riskBasis
      || snapshot.riskBasisMethod !== riskBasis.riskBasisMethod
      || snapshot.initialActualRiskAmount !== riskBasis.initialActualRiskAmount
      || snapshot.accountCurrency !== riskBasis.accountCurrency
      || snapshot.riskBasisAsOf !== riskBasis.riskBasisAsOf) return false;
  const projection = result.rMultipleProjection;
  const realtimeNetPerformance = result.realtimeNetPerformance;
  return typeof projection === "object" && projection !== null
    && projection.status === "TRADE_R_MULTIPLE_PROJECTED"
    && projection.snapshot === snapshot
    && typeof realtimeNetPerformance === "object" && realtimeNetPerformance !== null
    && realtimeNetPerformance.status === "NET_TRADE_PERFORMANCE_PROJECTED"
    && realtimeNetPerformance.snapshot === snapshot.netPerformance;
}

function hydrationRejected(
  reason: "HYDRATION_INVALID_SESSION" | "HYDRATION_AUTHORITY_INCOHERENT" |
    "HYDRATION_RISK_BASIS_INCOHERENT" | "HYDRATION_R_MULTIPLE_INCOHERENT",
): LiveTradingOrchestrationSessionHydrationResult {
  return Object.freeze({ status: "ORCHESTRATION_SESSION_HYDRATION_REJECTED", reason });
}

/** Hydrates one graph from already-authoritative objects; it never parses or reconstructs authority. */
export function hydrateLiveTradingOrchestrationSession(
  input: HydrateLiveTradingOrchestrationSessionInput,
): LiveTradingOrchestrationSessionHydrationResult {
  if (typeof input !== "object" || input === null
      || input.schemaVersion !== LIVE_TRADING_ORCHESTRATION_SESSION_SCHEMA_VERSION
      || Object.keys(input).some((key) => ![
        "schemaVersion", "sessionId", "mode", "instrumentId", "latestExecutionAttempt", "riskBasis",
        "latestRealtimeRMultiple",
      ].includes(key))) {
    return hydrationRejected("HYDRATION_INVALID_SESSION");
  }
  let base: LiveTradingOrchestrationSession;
  try {
    base = createLiveTradingOrchestrationSession(input);
  } catch {
    return hydrationRejected("HYDRATION_INVALID_SESSION");
  }
  const attempt = input.latestExecutionAttempt;
  const riskBasis = input.riskBasis;
  const latestR = input.latestRealtimeRMultiple;
  if (attempt !== undefined && !validAttempt(attempt, base.instrumentId)) {
    return hydrationRejected("HYDRATION_AUTHORITY_INCOHERENT");
  }
  if (riskBasis !== undefined) {
    if (attempt === undefined || !isTradeRiskBasis(riskBasis) || !sameIdentity(riskBasis, attempt)) {
      return hydrationRejected("HYDRATION_RISK_BASIS_INCOHERENT");
    }
  }
  if (latestR !== undefined) {
    if (attempt === undefined || riskBasis === undefined || !validProjectedRMultiple(latestR, attempt, riskBasis)) {
      return hydrationRejected("HYDRATION_R_MULTIPLE_INCOHERENT");
    }
  }
  const session = Object.freeze({
    ...base,
    ...(attempt === undefined ? {} : { latestExecutionAttempt: attempt }),
    ...(riskBasis === undefined ? {} : { riskBasis }),
    ...(latestR === undefined ? {} : { latestRealtimeRMultiple: latestR }),
  });
  return Object.freeze({ status: "ORCHESTRATION_SESSION_HYDRATED", session });
}
