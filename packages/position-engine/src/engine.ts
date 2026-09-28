import {
  type EntryOrderStatus,
  type ExecutionAttempt,
  type ExecutionState,
} from "@ulte/execution-engine";
import {
  nonNegativeDecimalString,
  positiveDecimalString,
  unixMs,
  type NonNegativeDecimalString,
} from "@ulte/instrument-model";
import { compareDecimal, subtractNonNegative } from "./internal/decimal.js";
import {
  POSITION_EXPOSURE_SCHEMA_VERSION,
  type PositionExposure,
  type PositionExposureProjectionResult,
  type PositionExposureRejectedResult,
  type PositionExposureRejectionReason,
  type PositionExposureState,
} from "./types.js";

const ZERO = nonNegativeDecimalString("0");
const SUPPORTED_EXECUTION_ATTEMPT_SCHEMA_VERSION: string = "EXECUTION_ATTEMPT_V2";

const ENTRY_ORDER_STATUSES: readonly EntryOrderStatus[] = [
  "NOT_SUBMITTED",
  "SUBMISSION_PENDING",
  "WORKING",
  "FILLED",
  "CANCELED",
  "REJECTED",
];

const EXECUTION_STATES: readonly ExecutionState[] = [
  "READY_FOR_ENTRY_SUBMISSION",
  "ENTRY_SUBMISSION_PENDING",
  "ENTRY_WORKING",
  "ENTRY_PARTIALLY_FILLED",
  "ENTRY_FILLED",
  "PROTECTION_PENDING",
  "PROTECTED",
  "EXIT_PARTIALLY_FILLED",
  "EXIT_FILLED",
  "CANCEL_PENDING",
  "CANCELED",
  "ENTRY_CANCELED_WITH_EXPOSURE",
  "REJECTED",
  "FAILED",
];

function rejected(reason: PositionExposureRejectionReason): PositionExposureRejectedResult {
  return Object.freeze({ status: "POSITION_EXPOSURE_REJECTED", reason });
}

function includes<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === "string" && values.some((candidate) => candidate === value);
}

function deriveExposureState(
  filledEntryQuantity: NonNegativeDecimalString,
  exitedQuantity: NonNegativeDecimalString,
  openQuantity: NonNegativeDecimalString,
  entryCanIncreaseExposure: boolean,
  entryOrderStatus: EntryOrderStatus,
  executionState: ExecutionState,
): PositionExposureState | undefined {
  if (compareDecimal(filledEntryQuantity, ZERO) === 0) return "NO_EXPOSURE";
  if (compareDecimal(openQuantity, ZERO) > 0) {
    return compareDecimal(exitedQuantity, ZERO) === 0 ? "OPEN" : "PARTIALLY_EXITED";
  }
  if (entryCanIncreaseExposure) return "FLAT_ENTRY_ACTIVE";
  if (
    (entryOrderStatus === "FILLED" || entryOrderStatus === "CANCELED")
    && executionState === "EXIT_FILLED"
  ) return "CLOSED";
  return undefined;
}

/** Purely projects authoritative executed exposure; it performs no execution transition or accounting. */
export function projectPositionExposure(attempt: ExecutionAttempt): PositionExposureProjectionResult {
  if (typeof attempt !== "object" || attempt === null || attempt.status !== "EXECUTION_ATTEMPT_READY") {
    return rejected("INVALID_EXECUTION_ATTEMPT");
  }
  if (attempt.schemaVersion !== SUPPORTED_EXECUTION_ATTEMPT_SCHEMA_VERSION) {
    return rejected("EXECUTION_SCHEMA_UNSUPPORTED");
  }
  if (
    (attempt.entrySide !== "BUY" && attempt.entrySide !== "SELL")
    || (attempt.exitSide !== "BUY" && attempt.exitSide !== "SELL")
  ) return rejected("INVALID_EXECUTION_ATTEMPT");
  if (attempt.entrySide === attempt.exitSide) return rejected("EXECUTION_SIDE_MISMATCH");
  if (!includes(ENTRY_ORDER_STATUSES, attempt.entryOrderStatus) || !includes(EXECUTION_STATES, attempt.state)) {
    return rejected("INVALID_EXECUTION_ATTEMPT");
  }

  let requestedQuantity;
  let filledEntryQuantity;
  let protectedQuantity;
  let exitedQuantity;
  let unprotectedFilledQuantity;
  let executionAsOf;
  try {
    requestedQuantity = positiveDecimalString(attempt.quantity);
    filledEntryQuantity = nonNegativeDecimalString(attempt.filledEntryQuantity);
    protectedQuantity = nonNegativeDecimalString(attempt.protectedQuantity);
    exitedQuantity = nonNegativeDecimalString(attempt.exitedQuantity);
    unprotectedFilledQuantity = nonNegativeDecimalString(attempt.unprotectedFilledQuantity);
    executionAsOf = unixMs(attempt.lastExecutionEventAt ?? attempt.preparedAsOf);
  } catch {
    return rejected("INVALID_EXECUTION_ATTEMPT");
  }

  if (compareDecimal(filledEntryQuantity, requestedQuantity) > 0) {
    return rejected("ENTRY_QUANTITY_EXCEEDS_REQUESTED");
  }
  if (compareDecimal(exitedQuantity, filledEntryQuantity) > 0) {
    return rejected("EXIT_QUANTITY_EXCEEDS_ENTRY");
  }
  if (compareDecimal(protectedQuantity, filledEntryQuantity) > 0) {
    return rejected("PROTECTED_QUANTITY_EXCEEDS_ENTRY");
  }
  if (
    compareDecimal(
      subtractNonNegative(filledEntryQuantity, protectedQuantity),
      unprotectedFilledQuantity,
    ) !== 0
  ) return rejected("UNPROTECTED_QUANTITY_INCOHERENT");

  const openQuantity = subtractNonNegative(filledEntryQuantity, exitedQuantity);
  const entryCanIncreaseExposure = attempt.entryOrderStatus === "WORKING";
  const terminalQuantitiesAndEntry = compareDecimal(filledEntryQuantity, ZERO) > 0
    && compareDecimal(openQuantity, ZERO) === 0
    && (attempt.entryOrderStatus === "FILLED" || attempt.entryOrderStatus === "CANCELED");
  if (attempt.state === "EXIT_FILLED" && !terminalQuantitiesAndEntry) {
    return rejected("INCOHERENT_TERMINAL_EXECUTION_STATE");
  }
  const exposureState = deriveExposureState(
    filledEntryQuantity,
    exitedQuantity,
    openQuantity,
    entryCanIncreaseExposure,
    attempt.entryOrderStatus,
    attempt.state,
  );
  if (exposureState === undefined) return rejected("INCOHERENT_TERMINAL_EXECUTION_STATE");

  const positionExposure: PositionExposure = Object.freeze({
    schemaVersion: POSITION_EXPOSURE_SCHEMA_VERSION,
    executionAttemptId: attempt.executionAttemptId,
    executionPlanId: attempt.executionPlanId,
    tradeIntentId: attempt.tradeIntentId,
    candidateId: attempt.candidateId,
    instrumentId: attempt.instrumentId,
    direction: attempt.entrySide === "BUY" ? "LONG" : "SHORT",
    entrySide: attempt.entrySide,
    exitSide: attempt.exitSide,
    requestedQuantity,
    filledEntryQuantity,
    exitedQuantity,
    openQuantity,
    entryOrderStatus: attempt.entryOrderStatus,
    executionState: attempt.state,
    entryCanIncreaseExposure,
    exposureState,
    executionAsOf,
  });
  return Object.freeze({ status: "POSITION_EXPOSURE_PROJECTED", positionExposure });
}

export class PositionEngine {
  project(attempt: ExecutionAttempt): PositionExposureProjectionResult {
    return projectPositionExposure(attempt);
  }
}
