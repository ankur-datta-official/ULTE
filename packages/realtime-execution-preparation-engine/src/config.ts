import type { RealtimeExecutionPreparationConfig } from "./types.js";

export function createRealtimeExecutionPreparationConfig(
  input: RealtimeExecutionPreparationConfig,
): Readonly<RealtimeExecutionPreparationConfig> {
  if (typeof input.profileVersion !== "string" || input.profileVersion.length === 0 ||
      input.profileVersion.trim() !== input.profileVersion) {
    throw new TypeError("profileVersion must be non-empty and have no surrounding whitespace");
  }
  if (!Number.isSafeInteger(input.recentPreparationWindowSize) ||
      input.recentPreparationWindowSize <= 0) {
    throw new RangeError("recentPreparationWindowSize must be a positive safe integer");
  }
  return Object.freeze({
    profileVersion: input.profileVersion,
    recentPreparationWindowSize: input.recentPreparationWindowSize,
  });
}
