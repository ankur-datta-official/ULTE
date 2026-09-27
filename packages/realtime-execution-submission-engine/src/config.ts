import type { RealtimeExecutionSubmissionConfig } from "./types.js";

export function createRealtimeExecutionSubmissionConfig(
  input: RealtimeExecutionSubmissionConfig,
): RealtimeExecutionSubmissionConfig {
  if (!Number.isSafeInteger(input.maxPreparedPlanAgeMs) || input.maxPreparedPlanAgeMs < 0) {
    throw new TypeError("maxPreparedPlanAgeMs must be a non-negative safe integer");
  }
  return Object.freeze({ maxPreparedPlanAgeMs: input.maxPreparedPlanAgeMs });
}
