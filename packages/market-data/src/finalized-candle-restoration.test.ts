import { describe, expect, it } from "vitest";
import { createInstrumentId, parseTimeframe, unixMs } from "@ulte/instrument-model";
import {
  FINALIZED_CANDLE_RECOVERY_EVIDENCE_SCHEMA_VERSION,
  MAX_FINALIZED_CANDLE_RECOVERY_TARGET_TRADES,
  TradeToCandleBuilder,
  createMarketDataEvent,
  createTradeTick,
  marketDataSource,
  restoreFinalizedCandleSnapshot,
  type CandleEngineEvent,
  type FinalizedCandleRecoveryEvidenceV1,
  type FinalizedCandleRecoveryTradeV1,
} from "./index.js";

const instrument = createInstrumentId({ venue: "test", venueSymbol: "BTC/USD", instrumentKind: "SPOT" });
const otherInstrument = createInstrumentId({ venue: "test", venueSymbol: "ETH/USD", instrumentKind: "SPOT" });
const source = marketDataSource("historical-feed");

function trade(
  eventTime: number,
  price = "10",
  quantity = "1",
  overrides: Partial<FinalizedCandleRecoveryTradeV1> = {},
): FinalizedCandleRecoveryTradeV1 {
  return {
    instrumentId: instrument,
    source,
    eventTime,
    receivedAt: eventTime + 5,
    price,
    quantity,
    side: "UNKNOWN",
    quality: ["DELAYED"],
    ...overrides,
  };
}

function evidence(input: {
  readonly openTime?: number;
  readonly closeTime?: number;
  readonly timeframe?: string;
  readonly anchorTime?: number;
  readonly previousAcceptedTrade?: FinalizedCandleRecoveryTradeV1;
  readonly targetAcceptedTrades?: readonly FinalizedCandleRecoveryTradeV1[];
  readonly finalizationWitness?: FinalizedCandleRecoveryTradeV1;
} = {}): FinalizedCandleRecoveryEvidenceV1 {
  const openTime = input.openTime ?? 60_000;
  const closeTime = input.closeTime ?? openTime + 60_000;
  return {
    schemaVersion: FINALIZED_CANDLE_RECOVERY_EVIDENCE_SCHEMA_VERSION,
    config: {
      instrumentId: instrument,
      source,
      timeframe: input.timeframe ?? "1m",
      anchorTime: input.anchorTime ?? 0,
    },
    target: { openTime, closeTime },
    previousAcceptedTrade: input.previousAcceptedTrade ?? trade(openTime - 59_000, "8"),
    targetAcceptedTrades: input.targetAcceptedTrades ?? [
      trade(openTime + 1_000, "10", "0.1", { quality: ["DELAYED", "SNAPSHOT"] }),
      trade(openTime + 2_000, "12", "0.2", { quality: ["LIVE"] }),
      trade(openTime + 3_000, "9", "0.30", { quality: ["STALE", "LIVE"] }),
      trade(openTime + 4_000, "11", "0.4", { quality: ["DELAYED"] }),
    ],
    finalizationWitness: input.finalizationWitness ?? trade(closeTime, "20"),
  };
}

function normalEvent(value: FinalizedCandleRecoveryTradeV1) {
  return createMarketDataEvent({
    instrumentId: value.instrumentId,
    source: value.source,
    eventTime: value.eventTime,
    receivedAt: value.receivedAt,
    payload: createTradeTick({ price: value.price, quantity: value.quantity, side: value.side }),
    quality: value.quality,
    ...(value.sequenceId === undefined ? {} : { sequenceId: value.sequenceId }),
  });
}

function closed(events: readonly CandleEngineEvent[], openTime: number) {
  const result = events.find((event): event is Extract<CandleEngineEvent, { type: "CANDLE_CLOSED" }> =>
    event.type === "CANDLE_CLOSED" && event.snapshot.candle.openTime === openTime);
  if (result === undefined) throw new Error("Expected normal builder to close the target candle");
  return result.snapshot;
}

describe("restoreFinalizedCandleSnapshot", () => {
  it("uses a contiguous predecessor without adding GAP_DETECTED", () => {
    const result = restoreFinalizedCandleSnapshot(evidence());

    expect(result.status).toBe("FINALIZED_CANDLE_SNAPSHOT_RESTORED");
    if (result.status !== "FINALIZED_CANDLE_SNAPSHOT_RESTORED") return;
    expect(result.snapshot.candle).toEqual({
      instrumentId: instrument,
      timeframe: "1m",
      openTime: 60_000,
      closeTime: 120_000,
      open: "10",
      high: "12",
      low: "9",
      close: "11",
      volume: "1",
      tradeCount: 4,
      isClosed: true,
    });
    expect(result.snapshot.quality).toEqual(["DELAYED", "SNAPSHOT", "LIVE", "STALE"]);
    expect(result.snapshot.quality).not.toContain("GAP_DETECTED");
    expect(result.snapshot.candle.quoteVolume).toBeUndefined();
    expect(Object.isFrozen(result.snapshot)).toBe(true);
    expect(Object.isFrozen(result.snapshot.candle)).toBe(true);
  });

  it("is deep-equal to the snapshot emitted by the normal builder path", () => {
    const input = evidence();
    const builder = new TradeToCandleBuilder({
      instrumentId: instrument,
      source,
      timeframe: parseTimeframe("1m"),
      anchorTime: unixMs(0),
    });
    builder.process(normalEvent(input.previousAcceptedTrade));
    for (const value of input.targetAcceptedTrades) builder.process(normalEvent(value));
    const expected = closed(builder.process(normalEvent(input.finalizationWitness)), 60_000);
    const first = restoreFinalizedCandleSnapshot(input);
    const second = restoreFinalizedCandleSnapshot(input);

    expect(first).toEqual({ status: "FINALIZED_CANDLE_SNAPSHOT_RESTORED", snapshot: expected });
    expect(second).toEqual(first);
  });

  it("derives GAP_DETECTED through predecessor-to-target rollover", () => {
    const input = evidence({
      openTime: 180_000,
      closeTime: 240_000,
      previousAcceptedTrade: trade(1_000, "8", "1", { quality: ["DELAYED"] }),
      targetAcceptedTrades: [
        trade(180_000, "10", "2", { quality: ["LIVE"] }),
        trade(181_000, "11", "3", { quality: ["STALE"] }),
      ],
      finalizationWitness: trade(240_000, "12"),
    });
    const result = restoreFinalizedCandleSnapshot(input);

    expect(result.status).toBe("FINALIZED_CANDLE_SNAPSHOT_RESTORED");
    if (result.status !== "FINALIZED_CANDLE_SNAPSHOT_RESTORED") return;
    expect(result.snapshot.quality).toEqual(["LIVE", "GAP_DETECTED", "STALE"]);
    expect(result.snapshot.candle).toMatchObject({ openTime: 180_000, closeTime: 240_000, volume: "5" });
  });

  it("rejects missing predecessor authority", () => {
    const canonical = evidence();
    const { previousAcceptedTrade: _omitted, ...missingPrevious } = canonical;

    expect(restoreFinalizedCandleSnapshot(missingPrevious)).toEqual({
      status: "FINALIZED_CANDLE_SNAPSHOT_RESTORATION_REJECTED",
      reason: "PREVIOUS_ACCEPTED_TRADE_REQUIRED",
    });
  });

  it("rejects an omission attack instead of restoring gapped evidence without GAP_DETECTED", () => {
    const canonical = evidence({
      openTime: 180_000,
      closeTime: 240_000,
      previousAcceptedTrade: trade(1_000),
      targetAcceptedTrades: [trade(181_000)],
      finalizationWitness: trade(240_000),
    });
    const { previousAcceptedTrade: _omitted, ...missingPrevious } = canonical;

    expect(restoreFinalizedCandleSnapshot(missingPrevious)).toEqual({
      status: "FINALIZED_CANDLE_SNAPSHOT_RESTORATION_REJECTED",
      reason: "PREVIOUS_ACCEPTED_TRADE_REQUIRED",
    });
  });

  it.each([
    ["instrumentId", { instrumentId: otherInstrument }],
    ["source", { source: "other-feed" }],
  ] as const)("rejects a wrong %s", (field, override) => {
    const result = restoreFinalizedCandleSnapshot(evidence({
      targetAcceptedTrades: [trade(61_000, "10", "1", override)],
    }));
    expect(result).toEqual({
      status: "FINALIZED_CANDLE_SNAPSHOT_RESTORATION_REJECTED",
      reason: "IDENTITY_MISMATCH",
      field,
    });
  });

  it.each([
    ["instrumentId", { instrumentId: otherInstrument }],
    ["source", { source: "other-feed" }],
  ] as const)("rejects a wrong predecessor %s", (field, override) => {
    const result = restoreFinalizedCandleSnapshot(evidence({
      previousAcceptedTrade: trade(1_000, "8", "1", override),
    }));
    expect(result).toEqual({
      status: "FINALIZED_CANDLE_SNAPSHOT_RESTORATION_REJECTED",
      reason: "IDENTITY_MISMATCH",
      field,
    });
  });

  it("rejects malformed timeframe, trade, and quality data", () => {
    expect(restoreFinalizedCandleSnapshot(evidence({ timeframe: "calendar-month" }))).toMatchObject({
      reason: "INVALID_RECOVERY_EVIDENCE",
    });
    expect(restoreFinalizedCandleSnapshot({
      ...evidence(),
      targetAcceptedTrades: [{ ...trade(61_000), price: "not-a-price" }],
    })).toMatchObject({ reason: "INVALID_RECOVERY_EVIDENCE" });
    expect(restoreFinalizedCandleSnapshot({
      ...evidence(),
      targetAcceptedTrades: [{ ...trade(61_000), quality: [] }],
    })).toMatchObject({ reason: "INVALID_RECOVERY_EVIDENCE" });
  });

  it("rejects compensated sparse target-trade and quality arrays", () => {
    const targetAcceptedTrades = new Array<FinalizedCandleRecoveryTradeV1>(1);
    (targetAcceptedTrades as any).extra = "compensating-key";
    expect(() => restoreFinalizedCandleSnapshot({
      ...evidence(),
      targetAcceptedTrades,
    })).not.toThrow();
    expect(restoreFinalizedCandleSnapshot({
      ...evidence(),
      targetAcceptedTrades,
    })).toMatchObject({ reason: "INVALID_RECOVERY_EVIDENCE" });

    const quality = new Array<"LIVE">(1);
    (quality as any).extra = "compensating-key";
    expect(restoreFinalizedCandleSnapshot({
      ...evidence(),
      targetAcceptedTrades: [{ ...trade(61_000), quality }],
    })).toMatchObject({ reason: "INVALID_RECOVERY_EVIDENCE" });
  });

  it("rejects a target boundary inconsistent with historical alignment", () => {
    expect(restoreFinalizedCandleSnapshot(evidence({ anchorTime: 1_000 }))).toMatchObject({
      reason: "TARGET_ALIGNMENT_MISMATCH",
    });
  });

  it("rejects decreasing canonical replay order", () => {
    expect(restoreFinalizedCandleSnapshot(evidence({
      targetAcceptedTrades: [trade(62_000), trade(61_000)],
    }))).toMatchObject({ reason: "OUT_OF_ORDER_EVIDENCE" });
  });

  it("requires a real later-bucket finalization witness", () => {
    const canonical = evidence();
    const { finalizationWitness: _omitted, ...missingWitness } = canonical;
    expect(restoreFinalizedCandleSnapshot(missingWitness)).toMatchObject({
      reason: "FINALIZATION_WITNESS_REQUIRED",
    });
    expect(restoreFinalizedCandleSnapshot({ ...missingWitness, isClosed: true })).toMatchObject({
      reason: "FINALIZATION_WITNESS_REQUIRED",
    });
    expect(restoreFinalizedCandleSnapshot(evidence({ finalizationWitness: trade(119_999) }))).toMatchObject({
      reason: "FINALIZATION_WITNESS_IN_TARGET_BUCKET",
    });
  });

  it("rejects contradictory bucket evidence and invalid predecessor state", () => {
    expect(restoreFinalizedCandleSnapshot(evidence({
      targetAcceptedTrades: [trade(61_000), trade(120_000)],
      finalizationWitness: trade(180_000),
    }))).toMatchObject({ reason: "CONFLICTING_RECOVERY_EVIDENCE" });
    expect(restoreFinalizedCandleSnapshot(evidence({
      previousAcceptedTrade: trade(61_000),
    }))).toMatchObject({ reason: "PREVIOUS_TRADE_NOT_BEFORE_TARGET" });
    expect(restoreFinalizedCandleSnapshot(evidence({
      previousAcceptedTrade: trade(120_000),
    }))).toMatchObject({ reason: "PREVIOUS_TRADE_NOT_BEFORE_TARGET" });
  });

  it("rejects duplicate and conflicting supplied recovery identities", () => {
    const identified = trade(61_000, "10", "1", { eventIdentity: "event-1" });
    expect(restoreFinalizedCandleSnapshot(evidence({
      targetAcceptedTrades: [identified, identified],
    }))).toMatchObject({ reason: "DUPLICATE_RECOVERY_EVENT_IDENTITY" });
    expect(restoreFinalizedCandleSnapshot(evidence({
      targetAcceptedTrades: [identified, { ...identified, price: "11" }],
    }))).toMatchObject({ reason: "CONFLICTING_RECOVERY_EVIDENCE" });
  });

  it("rejects unsupported schemas and enforces the bounded trade cardinality", () => {
    expect(restoreFinalizedCandleSnapshot({ ...evidence(), schemaVersion: "V2" })).toMatchObject({
      reason: "UNSUPPORTED_RECOVERY_SCHEMA",
    });
    expect(restoreFinalizedCandleSnapshot({
      ...evidence(),
      targetAcceptedTrades: Array(MAX_FINALIZED_CANDLE_RECOVERY_TARGET_TRADES + 1).fill(trade(61_000)),
    })).toMatchObject({ reason: "TARGET_TRADE_LIMIT_EXCEEDED" });
  });

  it("does not mutate supplied recovery evidence", () => {
    const input = evidence();
    const before = structuredClone(input);
    restoreFinalizedCandleSnapshot(input);
    expect(input).toEqual(before);
  });
});
