import { describe, expect, it } from "vitest";
import { createInstrumentId } from "@ulte/instrument-model";
import {
  FINALIZED_CANDLE_RECOVERY_EVIDENCE_SCHEMA_VERSION,
  restoreFinalizedCandleSnapshot,
  type CandleSnapshot,
  type FinalizedCandleRecoveryEvidenceV1,
} from "@ulte/market-data";
import { classifyMarketRegime, createRegimeConfig } from "@ulte/regime-engine";
import { analyzeMarketStructure, createStructureConfig } from "@ulte/structure-engine";

const instrument = createInstrumentId({ venue: "test", venueSymbol: "BTC/USD", instrumentKind: "SPOT" });

function recoveryEvidence(openTime: number, price: string): FinalizedCandleRecoveryEvidenceV1 {
  const targetTrade = {
    instrumentId: instrument,
    source: "historical-feed",
    eventTime: openTime + 1_000,
    receivedAt: openTime + 1_005,
    price,
    quantity: "1",
    side: "UNKNOWN" as const,
    quality: ["DELAYED"] as const,
  };
  return {
    schemaVersion: FINALIZED_CANDLE_RECOVERY_EVIDENCE_SCHEMA_VERSION,
    config: { instrumentId: instrument, source: "historical-feed", timeframe: "1m", anchorTime: 0 },
    target: { openTime, closeTime: openTime + 60_000 },
    previousAcceptedTrade: {
      ...targetTrade,
      eventTime: openTime - 59_000,
      receivedAt: openTime - 58_995,
    },
    targetAcceptedTrades: [targetTrade],
    finalizationWitness: {
      ...targetTrade,
      eventTime: openTime + 60_000,
      receivedAt: openTime + 60_005,
    },
  };
}

function restored(openTime: number, price: string): CandleSnapshot {
  const result = restoreFinalizedCandleSnapshot(recoveryEvidence(openTime, price));
  if (result.status !== "FINALIZED_CANDLE_SNAPSHOT_RESTORED") {
    throw new Error(`Restoration rejected: ${result.reason}`);
  }
  return result.snapshot;
}

describe("finalized candle restoration downstream integration", () => {
  it("supplies normal READY inputs to regime and structure analysis", () => {
    const snapshots = [restored(60_000, "10"), restored(120_000, "11"), restored(180_000, "12")];
    const regime = classifyMarketRegime(snapshots, createRegimeConfig({
      trendLookback: 2,
      baselineVolatilityBars: 1,
      recentVolatilityBars: 1,
      trendEfficiencyMinBps: 7_000,
      trendConsistencyMinBps: 7_000,
      rangeEfficiencyMaxBps: 3_000,
      rangeConsistencyMaxBps: 3_000,
      compressionRatioMaxBps: 8_000,
      expansionRatioMinBps: 12_000,
    }));
    const structure = analyzeMarketStructure(snapshots, createStructureConfig({
      lookbackBars: 3,
      pivotLeftBars: 1,
      pivotRightBars: 1,
    }));

    expect(regime.status).toBe("READY");
    expect(structure.status).toBe("READY");
    expect(snapshots.every((snapshot) => snapshot.candle.isClosed)).toBe(true);
  });
});
