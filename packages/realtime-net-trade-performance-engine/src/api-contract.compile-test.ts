import type { RealtimeTradeCostAccountingResult } from "@ulte/realtime-trade-cost-accounting-engine";
import type { RealtimeTradePerformanceResult } from "@ulte/realtime-trade-performance-engine";
import { projectRealtimeNetTradePerformance } from "./index.js";

declare const grossAuthority: RealtimeTradePerformanceResult;
declare const costAuthority: RealtimeTradeCostAccountingResult;

projectRealtimeNetTradePerformance(grossAuthority, costAuthority);

// @ts-expect-error The API requires both complete realtime authorities.
projectRealtimeNetTradePerformance(grossAuthority);

// @ts-expect-error A combined object is not the public API.
projectRealtimeNetTradePerformance({ grossAuthority, costAuthority });

// @ts-expect-error No lower-level or monetary override argument is accepted.
projectRealtimeNetTradePerformance(grossAuthority, costAuthority, { netTotalPnl: "999" });

projectRealtimeNetTradePerformance({
  // @ts-expect-error Raw execution, mark, market, cost-event, and monetary fields are not inputs.
  executionAttempt: {},
  accountingSpec: {},
  valuationMark: {},
  marketDataEvent: {},
  costEvents: [],
  grossTotalPnl: "10",
  netCostAmount: "1",
}, costAuthority);
