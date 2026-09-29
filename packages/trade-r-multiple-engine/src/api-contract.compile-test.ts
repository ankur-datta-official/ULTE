import type { ExecutionAttempt } from "@ulte/execution-engine";
import type { NetTradePerformanceSnapshot } from "@ulte/net-trade-performance-engine";
import {
  createTradeRiskBasisFromExecutionAttempt,
  projectTradeRMultipleFromAuthorities,
  projectTradeRMultipleSnapshot,
  type TradeRiskBasis,
} from "./index.js";

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends
  (<Value>() => Value extends Right ? 1 : 2) ? true : false;
type Assert<Value extends true> = Value;

type _RiskBasisHasOneInput = Assert<Equal<Parameters<typeof createTradeRiskBasisFromExecutionAttempt>["length"], 1>>;
type _RiskBasisInputIsAttempt = Assert<Equal<Parameters<typeof createTradeRiskBasisFromExecutionAttempt>[0], ExecutionAttempt>>;
type _CompositionHasTwoInputs = Assert<Equal<Parameters<typeof projectTradeRMultipleFromAuthorities>["length"], 2>>;
type _CompositionNetAuthority = Assert<Equal<Parameters<typeof projectTradeRMultipleFromAuthorities>[0], NetTradePerformanceSnapshot>>;
type _CompositionRiskAuthority = Assert<Equal<Parameters<typeof projectTradeRMultipleFromAuthorities>[1], TradeRiskBasis>>;
type _ConvenienceHasTwoInputs = Assert<Equal<Parameters<typeof projectTradeRMultipleSnapshot>["length"], 2>>;
type _ConvenienceAttemptAuthority = Assert<Equal<Parameters<typeof projectTradeRMultipleSnapshot>[0], ExecutionAttempt>>;
type _ConvenienceNetAuthority = Assert<Equal<Parameters<typeof projectTradeRMultipleSnapshot>[1], NetTradePerformanceSnapshot>>;
