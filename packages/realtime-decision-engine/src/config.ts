import type { RealtimeDecisionConfig } from "./types.js";

export function createRealtimeDecisionConfig(
  input: RealtimeDecisionConfig,
): Readonly<RealtimeDecisionConfig> {
  if (typeof input.profileVersion !== "string" || input.profileVersion.length === 0 ||
      input.profileVersion.trim() !== input.profileVersion) {
    throw new TypeError("profileVersion must be non-empty and have no surrounding whitespace");
  }
  if (!Number.isSafeInteger(input.recentDecisionWindowSize) || input.recentDecisionWindowSize <= 0) {
    throw new RangeError("recentDecisionWindowSize must be a positive safe integer");
  }
  return Object.freeze({
    profileVersion: input.profileVersion,
    recentDecisionWindowSize: input.recentDecisionWindowSize,
  });
}
