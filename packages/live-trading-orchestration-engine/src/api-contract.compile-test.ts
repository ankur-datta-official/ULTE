import type { InstrumentId } from "@ulte/instrument-model";
import {
  createLiveTradingOrchestrationSession,
  hydrateLiveTradingOrchestrationSession,
  planLiveTradingStep,
  type LiveTradingOrchestrationInput,
  type LiveTradingOrchestrationSession,
} from "./index.js";

declare const session: LiveTradingOrchestrationSession;
declare const input: LiveTradingOrchestrationInput;
declare const instrumentId: InstrumentId;

planLiveTradingStep(session, input);
createLiveTradingOrchestrationSession({ sessionId: "caller-owned", mode: "DRY_RUN", instrumentId });
createLiveTradingOrchestrationSession({ sessionId: "caller-owned", mode: "SANDBOX", instrumentId });
hydrateLiveTradingOrchestrationSession({
  schemaVersion: "LIVE_TRADING_ORCHESTRATION_SESSION_V1",
  sessionId: "caller-owned",
  mode: "SANDBOX",
  instrumentId,
});

// @ts-expect-error LIVE is not representable in V1.
createLiveTradingOrchestrationSession({ sessionId: "caller-owned", mode: "LIVE", instrumentId });

// @ts-expect-error Session identity is caller-supplied and required.
createLiveTradingOrchestrationSession({ mode: "DRY_RUN", instrumentId });

// @ts-expect-error No monetary or execution override argument is accepted.
planLiveTradingStep(session, input, { quantity: "1", risk: "2", pnl: "3", r: "4" });

planLiveTradingStep(session, {
  // @ts-expect-error Arbitrary broker instructions are not orchestration inputs.
  kind: "BROKER_ORDER_OVERRIDE",
  order: {},
});

hydrateLiveTradingOrchestrationSession({
  schemaVersion: "LIVE_TRADING_ORCHESTRATION_SESSION_V1",
  sessionId: "caller-owned",
  mode: "DRY_RUN",
  instrumentId,
  // @ts-expect-error Hydration accepts authority objects, not raw lifecycle fields.
  filledQuantity: "1",
});
