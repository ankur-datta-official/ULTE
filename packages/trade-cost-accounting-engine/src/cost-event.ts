import {
  currencyCode,
  instrumentId,
  positiveDecimalString,
  unixMs,
} from "@ulte/instrument-model";
import {
  TRADE_COST_EFFECTS,
  TRADE_COST_EVENT_SCHEMA_VERSION,
  TRADE_COST_TYPES,
  type TradeCostEvent,
  type TradeCostEventInput,
} from "./types.js";

function canonicalString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) {
    throw new TypeError(`${field} must be non-empty and have no surrounding whitespace`);
  }
  return value;
}

/** Creates one canonical, positive monetary cost event. */
export function createTradeCostEvent(input: TradeCostEventInput): TradeCostEvent {
  if (
    input.schemaVersion !== undefined
    && input.schemaVersion !== TRADE_COST_EVENT_SCHEMA_VERSION
  ) {
    throw new TypeError("Unsupported trade cost event schema version");
  }
  if (!(TRADE_COST_TYPES as readonly unknown[]).includes(input.costType)) {
    throw new TypeError("Unsupported trade cost type");
  }
  if (!(TRADE_COST_EFFECTS as readonly unknown[]).includes(input.effect)) {
    throw new TypeError("Unsupported trade cost effect");
  }
  return Object.freeze({
    schemaVersion: TRADE_COST_EVENT_SCHEMA_VERSION,
    costEventId: canonicalString(input.costEventId, "costEventId"),
    executionAttemptId: canonicalString(input.executionAttemptId, "executionAttemptId"),
    instrumentId: instrumentId(input.instrumentId),
    costType: input.costType,
    effect: input.effect,
    amount: positiveDecimalString(input.amount),
    currency: currencyCode(input.currency),
    effectiveAt: unixMs(input.effectiveAt),
    source: canonicalString(input.source, "source"),
  });
}
