import {
  instrumentId,
  positiveDecimalString,
  unixMs,
} from "@ulte/instrument-model";
import {
  VALUATION_MARK_SCHEMA_VERSION,
  type ValuationMark,
  type ValuationMarkInput,
} from "./types.js";

/** Canonicalizes an upstream-resolved, policy-neutral valuation mark. */
export function createValuationMark(input: ValuationMarkInput): Readonly<ValuationMark> {
  return Object.freeze({
    schemaVersion: VALUATION_MARK_SCHEMA_VERSION,
    instrumentId: instrumentId(input.instrumentId),
    markPrice: positiveDecimalString(input.markPrice),
    markAsOf: unixMs(input.markAsOf),
  });
}
