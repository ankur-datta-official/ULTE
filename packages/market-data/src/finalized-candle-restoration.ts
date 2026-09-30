import {
  instrumentId,
  parseTimeframe,
  unixMs,
  type UnixMs,
} from "@ulte/instrument-model";
import {
  TradeToCandleBuilder,
  candleBucket,
  type CandleSnapshot,
} from "./candle-engine.js";
import { createTradeTick, TRADE_SIDES, type TradeSide, type TradeTick } from "./contracts.js";
import {
  createMarketDataEvent,
  DATA_QUALITY_FLAGS,
  marketDataSource,
  type DataQualityFlag,
  type MarketDataEvent,
} from "./event.js";

export const FINALIZED_CANDLE_RECOVERY_EVIDENCE_SCHEMA_VERSION =
  "FINALIZED_CANDLE_RECOVERY_EVIDENCE_V1" as const;

// Recovery is intentionally unavailable for candles whose raw target-bucket
// evidence exceeds this V1 boundary. This keeps replay memory and work bounded.
export const MAX_FINALIZED_CANDLE_RECOVERY_TARGET_TRADES = 10_000;

export interface FinalizedCandleRecoveryTradeV1 {
  /** Optional evidence-local identity used only to reject duplicate/conflicting recovery entries. */
  readonly eventIdentity?: string;
  readonly instrumentId: string;
  readonly source: string;
  readonly eventTime: number;
  readonly receivedAt: number;
  readonly price: string;
  readonly quantity: string;
  readonly side: TradeSide;
  readonly quality: readonly DataQualityFlag[];
  readonly sequenceId?: string;
}

export interface FinalizedCandleRecoveryEvidenceV1 {
  readonly schemaVersion: typeof FINALIZED_CANDLE_RECOVERY_EVIDENCE_SCHEMA_VERSION;
  readonly config: Readonly<{
    readonly instrumentId: string;
    readonly source: string;
    readonly timeframe: string;
    readonly anchorTime: number;
  }>;
  readonly target: Readonly<{
    readonly openTime: number;
    readonly closeTime: number;
  }>;
  /** The exact last accepted canonical trade preceding the target bucket. */
  readonly previousAcceptedTrade: FinalizedCandleRecoveryTradeV1;
  /** Complete accepted-trade evidence for the target bucket, already in canonical replay order. */
  readonly targetAcceptedTrades: readonly FinalizedCandleRecoveryTradeV1[];
  /** The first supplied accepted event in a later bucket, proving target finalization by rollover. */
  readonly finalizationWitness: FinalizedCandleRecoveryTradeV1;
}

export type FinalizedCandleSnapshotRestorationRejectionReason =
  | "INVALID_RECOVERY_EVIDENCE"
  | "UNSUPPORTED_RECOVERY_SCHEMA"
  | "TARGET_TRADE_LIMIT_EXCEEDED"
  | "IDENTITY_MISMATCH"
  | "OUT_OF_ORDER_EVIDENCE"
  | "TARGET_ALIGNMENT_MISMATCH"
  | "PREVIOUS_ACCEPTED_TRADE_REQUIRED"
  | "PREVIOUS_TRADE_NOT_BEFORE_TARGET"
  | "FINALIZATION_WITNESS_REQUIRED"
  | "FINALIZATION_WITNESS_NOT_LATER"
  | "FINALIZATION_WITNESS_IN_TARGET_BUCKET"
  | "DUPLICATE_RECOVERY_EVENT_IDENTITY"
  | "CONFLICTING_RECOVERY_EVIDENCE";

export type FinalizedCandleSnapshotRestorationResult =
  | Readonly<{
      readonly status: "FINALIZED_CANDLE_SNAPSHOT_RESTORED";
      readonly snapshot: CandleSnapshot;
    }>
  | Readonly<{
      readonly status: "FINALIZED_CANDLE_SNAPSHOT_RESTORATION_REJECTED";
      readonly reason: FinalizedCandleSnapshotRestorationRejectionReason;
      readonly field?: "instrumentId" | "source";
    }>;

type DataRecord = Readonly<Record<string, unknown>>;

function isRecord(value: unknown): value is DataRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function hasExactKeys(value: DataRecord, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
}

function isDenseArray(value: unknown): value is readonly unknown[] {
  if (!Array.isArray(value)
      || Object.keys(value).length !== value.length
      || Reflect.ownKeys(value).length !== value.length + 1) return false;
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.prototype.hasOwnProperty.call(value, index)) return false;
  }
  return true;
}

function isQuality(value: unknown): value is readonly DataQualityFlag[] {
  return isDenseArray(value) && value.every((flag) =>
    typeof flag === "string" && (DATA_QUALITY_FLAGS as readonly string[]).includes(flag));
}

function isTradeSide(value: unknown): value is TradeSide {
  return typeof value === "string" && (TRADE_SIDES as readonly string[]).includes(value);
}

function isRecoveryTrade(value: unknown): value is FinalizedCandleRecoveryTradeV1 {
  if (!isRecord(value)) return false;
  const keys = ["instrumentId", "source", "eventTime", "receivedAt", "price", "quantity", "side", "quality"];
  if (value["eventIdentity"] !== undefined) keys.push("eventIdentity");
  if (value["sequenceId"] !== undefined) keys.push("sequenceId");
  return hasExactKeys(value, keys)
    && (value["eventIdentity"] === undefined || (
      typeof value["eventIdentity"] === "string"
      && value["eventIdentity"].length > 0
      && value["eventIdentity"].trim() === value["eventIdentity"]
    ))
    && typeof value["instrumentId"] === "string"
    && typeof value["source"] === "string"
    && typeof value["eventTime"] === "number"
    && Number.isFinite(value["eventTime"])
    && typeof value["receivedAt"] === "number"
    && Number.isFinite(value["receivedAt"])
    && typeof value["price"] === "string"
    && typeof value["quantity"] === "string"
    && isTradeSide(value["side"])
    && isQuality(value["quality"])
    && (value["sequenceId"] === undefined || typeof value["sequenceId"] === "string");
}

function sameRecoveryTrade(
  left: FinalizedCandleRecoveryTradeV1,
  right: FinalizedCandleRecoveryTradeV1,
): boolean {
  return left.eventIdentity === right.eventIdentity
    && left.instrumentId === right.instrumentId
    && left.source === right.source
    && left.eventTime === right.eventTime
    && left.receivedAt === right.receivedAt
    && left.price === right.price
    && left.quantity === right.quantity
    && left.side === right.side
    && left.sequenceId === right.sequenceId
    && left.quality.length === right.quality.length
    && left.quality.every((flag, index) => flag === right.quality[index]);
}

function isRecoveryConfig(value: unknown): value is FinalizedCandleRecoveryEvidenceV1["config"] {
  return isRecord(value)
    && hasExactKeys(value, ["instrumentId", "source", "timeframe", "anchorTime"])
    && typeof value["instrumentId"] === "string"
    && typeof value["source"] === "string"
    && typeof value["timeframe"] === "string"
    && typeof value["anchorTime"] === "number"
    && Number.isFinite(value["anchorTime"]);
}

function isRecoveryTarget(value: unknown): value is FinalizedCandleRecoveryEvidenceV1["target"] {
  return isRecord(value)
    && hasExactKeys(value, ["openTime", "closeTime"])
    && typeof value["openTime"] === "number"
    && Number.isFinite(value["openTime"])
    && typeof value["closeTime"] === "number"
    && Number.isFinite(value["closeTime"]);
}

function rejected(
  reason: FinalizedCandleSnapshotRestorationRejectionReason,
  field?: "instrumentId" | "source",
): FinalizedCandleSnapshotRestorationResult {
  return Object.freeze({
    status: "FINALIZED_CANDLE_SNAPSHOT_RESTORATION_REJECTED",
    reason,
    ...(field === undefined ? {} : { field }),
  });
}

function validateEvidence(value: unknown):
  | Readonly<{ readonly evidence: FinalizedCandleRecoveryEvidenceV1 }>
  | FinalizedCandleSnapshotRestorationResult {
  if (!isRecord(value)) return rejected("INVALID_RECOVERY_EVIDENCE");
  if (value["schemaVersion"] !== FINALIZED_CANDLE_RECOVERY_EVIDENCE_SCHEMA_VERSION) {
    return typeof value["schemaVersion"] === "string"
      ? rejected("UNSUPPORTED_RECOVERY_SCHEMA")
      : rejected("INVALID_RECOVERY_EVIDENCE");
  }
  if (value["previousAcceptedTrade"] === undefined) {
    return rejected("PREVIOUS_ACCEPTED_TRADE_REQUIRED");
  }
  if (value["finalizationWitness"] === undefined) return rejected("FINALIZATION_WITNESS_REQUIRED");
  if (!isDenseArray(value["targetAcceptedTrades"])) {
    return rejected("INVALID_RECOVERY_EVIDENCE");
  }
  if (value["targetAcceptedTrades"].length > MAX_FINALIZED_CANDLE_RECOVERY_TARGET_TRADES) {
    return rejected("TARGET_TRADE_LIMIT_EXCEEDED");
  }
  const keys = [
    "schemaVersion", "config", "target", "previousAcceptedTrade", "targetAcceptedTrades",
    "finalizationWitness",
  ];
  if (!hasExactKeys(value, keys)
      || !isRecoveryConfig(value["config"])
      || !isRecoveryTarget(value["target"])
      || !isRecoveryTrade(value["previousAcceptedTrade"])
      || !value["targetAcceptedTrades"].every(isRecoveryTrade)
      || !isRecoveryTrade(value["finalizationWitness"])) {
    return rejected("INVALID_RECOVERY_EVIDENCE");
  }
  return Object.freeze({
    evidence: Object.freeze({
      schemaVersion: FINALIZED_CANDLE_RECOVERY_EVIDENCE_SCHEMA_VERSION,
      config: value["config"],
      target: value["target"],
      previousAcceptedTrade: value["previousAcceptedTrade"],
      targetAcceptedTrades: value["targetAcceptedTrades"],
      finalizationWitness: value["finalizationWitness"],
    }),
  });
}

function restoreEvent(trade: FinalizedCandleRecoveryTradeV1): MarketDataEvent<TradeTick> {
  return createMarketDataEvent({
    instrumentId: trade.instrumentId,
    source: trade.source,
    eventTime: trade.eventTime,
    receivedAt: trade.receivedAt,
    payload: createTradeTick({ price: trade.price, quantity: trade.quantity, side: trade.side }),
    quality: trade.quality,
    ...(trade.sequenceId === undefined ? {} : { sequenceId: trade.sequenceId }),
  });
}

export function restoreFinalizedCandleSnapshot(
  recoveryEvidence: unknown,
): FinalizedCandleSnapshotRestorationResult {
  const validation = validateEvidence(recoveryEvidence);
  if (!("evidence" in validation)) return validation;
  const evidence = validation.evidence;
  if (evidence.targetAcceptedTrades.length === 0) return rejected("CONFLICTING_RECOVERY_EVIDENCE");

  const identifiedEvents = new Map<string, FinalizedCandleRecoveryTradeV1>();
  const suppliedTrades = [
    evidence.previousAcceptedTrade,
    ...evidence.targetAcceptedTrades,
    evidence.finalizationWitness,
  ];
  for (const trade of suppliedTrades) {
    if (trade.eventIdentity === undefined) continue;
    const existing = identifiedEvents.get(trade.eventIdentity);
    if (existing !== undefined) {
      return rejected(sameRecoveryTrade(existing, trade)
        ? "DUPLICATE_RECOVERY_EVENT_IDENTITY"
        : "CONFLICTING_RECOVERY_EVIDENCE");
    }
    identifiedEvents.set(trade.eventIdentity, trade);
  }

  let builder: TradeToCandleBuilder;
  let targetOpenTime: UnixMs;
  let targetCloseTime: UnixMs;
  let previous: MarketDataEvent<TradeTick>;
  let targetTrades: readonly MarketDataEvent<TradeTick>[];
  let witness: MarketDataEvent<TradeTick>;
  try {
    builder = new TradeToCandleBuilder({
      instrumentId: instrumentId(evidence.config.instrumentId),
      source: marketDataSource(evidence.config.source),
      timeframe: parseTimeframe(evidence.config.timeframe),
      anchorTime: unixMs(evidence.config.anchorTime),
    });
    targetOpenTime = unixMs(evidence.target.openTime);
    targetCloseTime = unixMs(evidence.target.closeTime);
    previous = restoreEvent(evidence.previousAcceptedTrade);
    targetTrades = Object.freeze(evidence.targetAcceptedTrades.map(restoreEvent));
    witness = restoreEvent(evidence.finalizationWitness);
  } catch {
    return rejected("INVALID_RECOVERY_EVIDENCE");
  }

  const replayEvents = Object.freeze([
    previous,
    ...targetTrades,
    witness,
  ]);
  for (const event of replayEvents) {
    if (event.instrumentId !== builder.config.instrumentId) return rejected("IDENTITY_MISMATCH", "instrumentId");
    if (event.source !== builder.config.source) return rejected("IDENTITY_MISMATCH", "source");
  }
  if (previous.eventTime >= targetOpenTime || previous.eventTime >= targetTrades[0]!.eventTime) {
    return rejected("PREVIOUS_TRADE_NOT_BEFORE_TARGET");
  }
  for (let index = 1; index < replayEvents.length; index += 1) {
    if (replayEvents[index]!.eventTime < replayEvents[index - 1]!.eventTime) {
      return rejected("OUT_OF_ORDER_EVIDENCE");
    }
  }

  let alignedTarget: Readonly<{ openTime: UnixMs; closeTime: UnixMs }>;
  let previousBucket: Readonly<{ openTime: UnixMs; closeTime: UnixMs }>;
  let witnessBucket: Readonly<{ openTime: UnixMs; closeTime: UnixMs }>;
  try {
    alignedTarget = candleBucket(targetTrades[0]!.eventTime, builder.config);
    previousBucket = candleBucket(previous.eventTime, builder.config);
    witnessBucket = candleBucket(witness.eventTime, builder.config);
  } catch {
    return rejected("INVALID_RECOVERY_EVIDENCE");
  }
  if (alignedTarget.openTime !== targetOpenTime || alignedTarget.closeTime !== targetCloseTime) {
    return rejected("TARGET_ALIGNMENT_MISMATCH");
  }
  for (const event of targetTrades) {
    const bucket = candleBucket(event.eventTime, builder.config);
    if (bucket.openTime !== targetOpenTime || bucket.closeTime !== targetCloseTime) {
      return rejected("CONFLICTING_RECOVERY_EVIDENCE");
    }
  }
  if (previousBucket.openTime >= targetOpenTime) {
    return rejected("PREVIOUS_TRADE_NOT_BEFORE_TARGET");
  }
  if (witnessBucket.openTime === targetOpenTime) {
    return rejected("FINALIZATION_WITNESS_IN_TARGET_BUCKET");
  }
  if (witnessBucket.openTime < targetOpenTime) {
    return rejected("FINALIZATION_WITNESS_NOT_LATER");
  }

  let restored: CandleSnapshot | undefined;
  for (const event of replayEvents) {
    for (const output of builder.process(event)) {
      if (output.type === "OUT_OF_ORDER_REJECTED") return rejected("OUT_OF_ORDER_EVIDENCE");
      if (output.type === "IDENTITY_MISMATCH_REJECTED") return rejected("IDENTITY_MISMATCH", output.field);
      if (output.type === "CANDLE_CLOSED" && output.snapshot.candle.openTime === targetOpenTime) {
        if (restored !== undefined || output.snapshot.candle.closeTime !== targetCloseTime) {
          return rejected("CONFLICTING_RECOVERY_EVIDENCE");
        }
        restored = output.snapshot;
      }
    }
  }
  return restored === undefined
    ? rejected("FINALIZATION_WITNESS_NOT_LATER")
    : Object.freeze({ status: "FINALIZED_CANDLE_SNAPSHOT_RESTORED", snapshot: restored });
}
