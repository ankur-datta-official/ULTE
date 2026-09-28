import type {
  EntryOrderStatus,
  ExecutionAttempt,
  ExecutionState,
} from "@ulte/execution-engine";
import type {
  InstrumentId,
  NonNegativeDecimalString,
  PositiveDecimalString,
  UnixMs,
} from "@ulte/instrument-model";

export const POSITION_EXPOSURE_SCHEMA_VERSION = "POSITION_EXPOSURE_V1" as const;

export type PositionDirection = "LONG" | "SHORT";

export type PositionExposureState =
  | "NO_EXPOSURE"
  | "OPEN"
  | "PARTIALLY_EXITED"
  | "FLAT_ENTRY_ACTIVE"
  | "CLOSED";

export interface PositionExposure {
  readonly schemaVersion: typeof POSITION_EXPOSURE_SCHEMA_VERSION;
  readonly executionAttemptId: string;
  readonly executionPlanId: string;
  readonly tradeIntentId: string;
  readonly candidateId: string;
  readonly instrumentId: InstrumentId;
  readonly direction: PositionDirection;
  readonly entrySide: ExecutionAttempt["entrySide"];
  readonly exitSide: ExecutionAttempt["exitSide"];
  readonly requestedQuantity: PositiveDecimalString;
  readonly filledEntryQuantity: NonNegativeDecimalString;
  readonly exitedQuantity: NonNegativeDecimalString;
  readonly openQuantity: NonNegativeDecimalString;
  readonly entryOrderStatus: EntryOrderStatus;
  readonly executionState: ExecutionState;
  readonly entryCanIncreaseExposure: boolean;
  readonly exposureState: PositionExposureState;
  readonly executionAsOf: UnixMs;
}

export type PositionExposureRejectionReason =
  | "INVALID_EXECUTION_ATTEMPT"
  | "EXECUTION_SCHEMA_UNSUPPORTED"
  | "EXECUTION_SIDE_MISMATCH"
  | "ENTRY_QUANTITY_EXCEEDS_REQUESTED"
  | "EXIT_QUANTITY_EXCEEDS_ENTRY"
  | "PROTECTED_QUANTITY_EXCEEDS_ENTRY"
  | "UNPROTECTED_QUANTITY_INCOHERENT"
  | "INCOHERENT_TERMINAL_EXECUTION_STATE";

export interface PositionExposureProjectedResult {
  readonly status: "POSITION_EXPOSURE_PROJECTED";
  readonly positionExposure: PositionExposure;
}

export interface PositionExposureRejectedResult {
  readonly status: "POSITION_EXPOSURE_REJECTED";
  readonly reason: PositionExposureRejectionReason;
}

export type PositionExposureProjectionResult =
  | PositionExposureProjectedResult
  | PositionExposureRejectedResult;
