import {
  TRADE_COST_EVENT_SCHEMA_VERSION,
  createTradeCostEvent,
  type TradeCostEvent,
} from "@ulte/trade-cost-accounting-engine";

export type CostEventDeliveryNormalizationResult =
  | {
      readonly status: "NORMALIZED";
      readonly uniqueCostEvents: readonly TradeCostEvent[];
      readonly observedDeliveryCount: number;
      readonly duplicateDeliveryCount: number;
    }
  | { readonly status: "INVALID" }
  | { readonly status: "CONFLICTING_DUPLICATE" };

function canonicalPayloadEqual(left: TradeCostEvent, right: TradeCostEvent): boolean {
  return left.schemaVersion === right.schemaVersion
    && left.costEventId === right.costEventId
    && left.executionAttemptId === right.executionAttemptId
    && left.instrumentId === right.instrumentId
    && left.costType === right.costType
    && left.effect === right.effect
    && left.amount === right.amount
    && left.currency === right.currency
    && left.effectiveAt === right.effectiveAt
    && left.source === right.source;
}

/** Canonicalizes one caller-supplied checkpoint without retaining state across calls. */
export function normalizeCostEventDeliveries(
  observedCostEvents: readonly TradeCostEvent[],
): CostEventDeliveryNormalizationResult {
  if (!Array.isArray(observedCostEvents)) return Object.freeze({ status: "INVALID" });

  const uniqueById = new Map<string, TradeCostEvent>();
  try {
    for (const delivery of observedCostEvents) {
      if (
        (delivery as { readonly schemaVersion?: unknown } | null)?.schemaVersion
        !== TRADE_COST_EVENT_SCHEMA_VERSION
      ) {
        return Object.freeze({ status: "INVALID" });
      }
      const canonical = createTradeCostEvent(delivery);
      const existing = uniqueById.get(canonical.costEventId);
      if (existing === undefined) {
        uniqueById.set(canonical.costEventId, canonical);
      } else if (!canonicalPayloadEqual(existing, canonical)) {
        return Object.freeze({ status: "CONFLICTING_DUPLICATE" });
      }
    }
  } catch {
    return Object.freeze({ status: "INVALID" });
  }

  const uniqueCostEvents = Object.freeze([...uniqueById.values()]);
  return Object.freeze({
    status: "NORMALIZED",
    uniqueCostEvents,
    observedDeliveryCount: observedCostEvents.length,
    duplicateDeliveryCount: observedCostEvents.length - uniqueCostEvents.length,
  });
}
