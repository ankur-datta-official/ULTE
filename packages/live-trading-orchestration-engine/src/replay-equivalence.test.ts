import { expect, it } from "vitest";
import { createInstrumentId } from "@ulte/instrument-model";
import type { LiveIngestionResult, LiveTradeEvent } from "@ulte/live-market-data-engine";
import {
  createLiveTradingOrchestrationSession,
  planLiveTradingStep,
  type LiveTradingOrchestrationInput,
} from "./index.js";

const instrument = createInstrumentId({ venue: "test", venueSymbol: "BTC-USD", instrumentKind: "SPOT" });

it("replays the same ordered inputs with equivalent outputs and no hidden state", () => {
  const event = Object.freeze({ event: Object.freeze({ instrumentId: instrument }) }) as unknown as LiveTradeEvent;
  const accepted = Object.freeze({ status: "ACCEPTED" }) as unknown as LiveIngestionResult;
  const duplicate = Object.freeze({ status: "DUPLICATE" }) as unknown as LiveIngestionResult;
  const sequence: readonly LiveTradingOrchestrationInput[] = Object.freeze([
    Object.freeze({ kind: "OBSERVED_LIVE_TRADE", event, observationTime: 1_000 }),
    Object.freeze({ kind: "LIVE_INGESTION_RESULT", result: accepted }),
    Object.freeze({ kind: "LIVE_INGESTION_RESULT", result: duplicate }),
  ]);

  function replay() {
    let current = createLiveTradingOrchestrationSession({
      sessionId: "replay-session",
      mode: "DRY_RUN",
      instrumentId: instrument,
    });
    const outputs = sequence.map((input) => {
      const output = planLiveTradingStep(current, input);
      current = output.session;
      return output;
    });
    return { current, outputs };
  }

  const first = replay();
  const second = replay();
  expect(first).toEqual(second);
  expect(first.outputs[1]?.reference).toBe(accepted);
  expect(first.outputs[2]?.reference).toBe(duplicate);
  expect(first.current).toEqual(second.current);
});
