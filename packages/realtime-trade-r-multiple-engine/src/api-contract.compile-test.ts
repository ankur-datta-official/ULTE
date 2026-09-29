import type { RealtimeNetTradePerformanceResult } from "@ulte/realtime-net-trade-performance-engine";
import type { TradeRiskBasis } from "@ulte/trade-r-multiple-engine";
import { projectRealtimeTradeRMultiple } from "./index.js";

declare const realtimeNetPerformance: RealtimeNetTradePerformanceResult;
declare const riskBasis: TradeRiskBasis;

projectRealtimeTradeRMultiple(realtimeNetPerformance, riskBasis);

// @ts-expect-error Both complete authorities are required.
projectRealtimeTradeRMultiple(realtimeNetPerformance);

// @ts-expect-error Execution attempts are not accepted in place of an established risk basis.
projectRealtimeTradeRMultiple(realtimeNetPerformance, { executionAttemptId: "attempt" });

// @ts-expect-error No monetary, risk, currency, conversion, or timestamp override is accepted.
projectRealtimeTradeRMultiple(realtimeNetPerformance, riskBasis, { netTotalPnl: "999" });

projectRealtimeTradeRMultiple({
  // @ts-expect-error Raw executions and monetary inputs are not realtime net authority results.
  executionAttempt: {},
  actualRiskAmount: "10",
  netTotalPnl: "20",
}, riskBasis);
