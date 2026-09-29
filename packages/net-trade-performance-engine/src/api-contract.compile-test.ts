import type { TradeCostAccounting } from "@ulte/trade-cost-accounting-engine";
import type { TradePerformanceSnapshot } from "@ulte/trade-performance-engine";
import {
  projectNetTradePerformanceFromAuthorities,
  projectNetTradePerformanceSnapshot,
} from "./index.js";

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends
  (<Value>() => Value extends Right ? 1 : 2) ? true : false;
type Assert<Value extends true> = Value;

type _StandaloneHasFourInputs = Assert<Equal<Parameters<typeof projectNetTradePerformanceSnapshot>["length"], 4>>;
type _CompositionHasTwoInputs = Assert<Equal<Parameters<typeof projectNetTradePerformanceFromAuthorities>["length"], 2>>;
type _CompositionGrossAuthority = Assert<Equal<Parameters<typeof projectNetTradePerformanceFromAuthorities>[0], TradePerformanceSnapshot>>;
type _CompositionCostAuthority = Assert<Equal<Parameters<typeof projectNetTradePerformanceFromAuthorities>[1], TradeCostAccounting>>;
