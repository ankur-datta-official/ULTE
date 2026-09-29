import { instrumentId } from "@ulte/instrument-model";
import type {
  CreateLiveTradingOrchestrationSessionInput,
  LiveTradingOrchestrationSession,
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
