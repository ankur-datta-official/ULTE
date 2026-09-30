import type { PositiveDecimalString } from "@ulte/instrument-model";
import type { ReadyExecutionPlan } from "../types.js";
import { compareDecimal } from "./decimal.js";

type Direction = ReadyExecutionPlan["direction"];

export function executionSides(direction: Direction): Readonly<{
  entrySide: ReadyExecutionPlan["entrySide"];
  exitSide: ReadyExecutionPlan["exitSide"];
}> {
  return direction === "UP"
    ? Object.freeze({ entrySide: "BUY", exitSide: "SELL" })
    : Object.freeze({ entrySide: "SELL", exitSide: "BUY" });
}

export function pricesAreCoherent(
  direction: Direction,
  entry: PositiveDecimalString,
  invalidation: PositiveDecimalString,
  target: PositiveDecimalString,
): boolean {
  return direction === "UP"
    ? compareDecimal(invalidation, entry) < 0 && compareDecimal(entry, target) < 0
    : compareDecimal(target, entry) < 0 && compareDecimal(entry, invalidation) < 0;
}

export function marketRemainsEligible(
  direction: Direction,
  bid: PositiveDecimalString,
  ask: PositiveDecimalString,
  invalidation: PositiveDecimalString,
  target: PositiveDecimalString,
): boolean {
  return direction === "UP"
    ? compareDecimal(bid, invalidation) > 0 && compareDecimal(ask, target) < 0
    : compareDecimal(ask, invalidation) < 0 && compareDecimal(bid, target) > 0;
}

export function currentExecutablePrice(
  direction: Direction,
  bid: PositiveDecimalString,
  ask: PositiveDecimalString,
): PositiveDecimalString {
  return direction === "UP" ? ask : bid;
}

export function createExecutionInstructions(
  direction: Direction,
  entry: PositiveDecimalString,
  invalidation: PositiveDecimalString,
  target: PositiveDecimalString,
  quantity: PositiveDecimalString,
): Readonly<Pick<
  ReadyExecutionPlan,
  "entryInstruction" | "protectiveStopInstruction" | "profitTargetInstruction"
>> {
  const { entrySide, exitSide } = executionSides(direction);
  return Object.freeze({
    entryInstruction: Object.freeze({
      kind: "ENTRY_LIMIT",
      side: entrySide,
      price: entry,
      quantity,
      positionEffect: "OPEN",
    }),
    protectiveStopInstruction: Object.freeze({
      kind: "PROTECTIVE_STOP_TRIGGER",
      side: exitSide,
      triggerPrice: invalidation,
      quantity,
      positionEffect: "CLOSE",
    }),
    profitTargetInstruction: Object.freeze({
      kind: "PROFIT_TARGET_LIMIT",
      side: exitSide,
      price: target,
      quantity,
      positionEffect: "CLOSE",
    }),
  });
}
