import type { LiveTradingOrchestrationInput, LiveTradingOrchestrationSession } from "@ulte/live-trading-orchestration-engine";
import {
  SandboxOrchestrationRunner,
  type SandboxOrchestrationRuntime,
} from "./index.js";

declare const session: LiveTradingOrchestrationSession;
declare const runtime: SandboxOrchestrationRuntime;
declare const input: LiveTradingOrchestrationInput;

const runner = new SandboxOrchestrationRunner({ session, runtime });
runner.dispatch(input);

// @ts-expect-error Per-dispatch command overrides are not accepted.
runner.dispatch(input, { command: "SUBMIT_REALTIME_EXECUTION" });

// @ts-expect-error Per-dispatch broker overrides are not accepted.
runner.dispatch({ ...input, brokerAdapter: {} });

// @ts-expect-error LIVE is not a representable session mode.
new SandboxOrchestrationRunner({ session: { ...session, mode: "LIVE" }, runtime });

// @ts-expect-error Runtime dependencies are mandatory construction-time configuration.
new SandboxOrchestrationRunner({ session });

// @ts-expect-error Quantity, risk, PnL, and R overrides are not accepted by dispatch.
runner.dispatch(input, { quantity: "1", risk: "2", pnl: "3", r: "4" });
