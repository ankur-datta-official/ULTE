import type {
  PositionExposure,
  PositionExposureProjectedResult,
  PositionExposureRejectedResult,
  PositionExposureRejectionReason,
} from "@ulte/position-engine";
import type { RealtimeExecutionExitFillResult } from "@ulte/realtime-execution-exit-fill-engine";
import type { RealtimeExecutionFillResult } from "@ulte/realtime-execution-fill-engine";

export type RealtimePositionExposureSourceKind = "ENTRY_FILL" | "EXIT_FILL";

export interface EntryFillPositionExposureInput {
  readonly sourceKind: "ENTRY_FILL";
  readonly fillLifecycle: RealtimeExecutionFillResult;
}

export interface ExitFillPositionExposureInput {
  readonly sourceKind: "EXIT_FILL";
  readonly exitFillLifecycle: RealtimeExecutionExitFillResult;
}

export type RealtimePositionExposureInput =
  | EntryFillPositionExposureInput
  | ExitFillPositionExposureInput;

export type RealtimePositionExposureUpstreamStatus =
  | RealtimeExecutionFillResult["status"]
  | RealtimeExecutionExitFillResult["status"];

export interface NoPositionProjectionResult {
  readonly status: "NO_POSITION_PROJECTION";
  readonly sourceKind: RealtimePositionExposureSourceKind;
  readonly upstreamStatus: RealtimePositionExposureUpstreamStatus;
}

export interface PositionExposureProjectedRealtimeResult {
  readonly status: "POSITION_EXPOSURE_PROJECTED";
  readonly sourceKind: RealtimePositionExposureSourceKind;
  readonly upstreamStatus: RealtimePositionExposureUpstreamStatus;
  readonly positionExposure: PositionExposure;
  readonly positionProjection: PositionExposureProjectedResult;
}

export interface PositionExposureRejectedRealtimeResult {
  readonly status: "POSITION_EXPOSURE_REJECTED";
  readonly sourceKind: RealtimePositionExposureSourceKind;
  readonly upstreamStatus: RealtimePositionExposureUpstreamStatus;
  readonly reason: PositionExposureRejectionReason;
  readonly positionProjection: PositionExposureRejectedResult;
}

export type RealtimePositionExposureResult =
  | NoPositionProjectionResult
  | PositionExposureProjectedRealtimeResult
  | PositionExposureRejectedRealtimeResult;
