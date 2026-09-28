import {
  projectPositionExposure,
  type PositionExposureProjectionResult,
} from "@ulte/position-engine";
import type {
  RealtimePositionExposureInput,
  RealtimePositionExposureResult,
  RealtimePositionExposureSourceKind,
  RealtimePositionExposureUpstreamStatus,
} from "./types.js";

function noProjection(
  sourceKind: RealtimePositionExposureSourceKind,
  upstreamStatus: RealtimePositionExposureUpstreamStatus,
): RealtimePositionExposureResult {
  return Object.freeze({ status: "NO_POSITION_PROJECTION", sourceKind, upstreamStatus });
}

function wrapProjection(
  sourceKind: RealtimePositionExposureSourceKind,
  upstreamStatus: RealtimePositionExposureUpstreamStatus,
  positionProjection: PositionExposureProjectionResult,
): RealtimePositionExposureResult {
  if (positionProjection.status === "POSITION_EXPOSURE_REJECTED") {
    return Object.freeze({
      status: "POSITION_EXPOSURE_REJECTED",
      sourceKind,
      upstreamStatus,
      reason: positionProjection.reason,
      positionProjection,
    });
  }
  return Object.freeze({
    status: "POSITION_EXPOSURE_PROJECTED",
    sourceKind,
    upstreamStatus,
    positionExposure: positionProjection.positionExposure,
    positionProjection,
  });
}

/** Projects only the authoritative attempt exposed by an actionable realtime fill result. */
export function projectRealtimePositionExposure(
  input: RealtimePositionExposureInput,
): RealtimePositionExposureResult {
  if (input.sourceKind === "ENTRY_FILL") {
    const upstream = input.fillLifecycle;
    if (upstream.status !== "FILL_APPLIED" && upstream.status !== "DUPLICATE_FILL") {
      return noProjection(input.sourceKind, upstream.status);
    }
    if (upstream.executionAttempt === undefined) return noProjection(input.sourceKind, upstream.status);
    return wrapProjection(
      input.sourceKind,
      upstream.status,
      projectPositionExposure(upstream.executionAttempt),
    );
  }

  const upstream = input.exitFillLifecycle;
  if (upstream.status !== "EXIT_FILL_APPLIED" && upstream.status !== "DUPLICATE_EXIT_FILL") {
    return noProjection(input.sourceKind, upstream.status);
  }
  if (upstream.executionAttempt === undefined) return noProjection(input.sourceKind, upstream.status);
  return wrapProjection(
    input.sourceKind,
    upstream.status,
    projectPositionExposure(upstream.executionAttempt),
  );
}

export class RealtimePositionExposureEngine {
  project(input: RealtimePositionExposureInput): RealtimePositionExposureResult {
    return projectRealtimePositionExposure(input);
  }
}
