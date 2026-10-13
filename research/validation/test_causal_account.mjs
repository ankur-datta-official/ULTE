import assert from "node:assert/strict";
import test from "node:test";
import { multiplyDecimal } from "../../packages/exact-decimal/dist/index.js";
import { CausalResearchAccount } from "./causal_account.mjs";

const instrumentId = "ulte:v1:BINANCE:PERPETUAL:BTCUSDT";
const costs = { entryFeeBps: 5, exitFeeBps: 5, entrySlippageBps: 1, exitSlippageBps: 1, spreadBps: 1 };
const hour = 3_600_000;
const quarter = 900_000;
const bar = (openTime, open, high, low) => ({ openTime, closeTime: openTime + quarter, open, high, low });
const decision = (time) => ({
  status: "TRADE_INTENT_CREATED", analysisAsOf: time,
  tradeIntentResult: { candidateId: "candidate-1", direction: "UP", invalidationPrice: "90", primaryTargetPrice: "140" },
  positionSizingResult: { sizedQuantity: "1", actualRiskAmount: "11" },
});

test("account equity changes only after observed exit; open risk and risk budget use current state", () => {
  const account = new CausalResearchAccount({ initialEquity: "10000", instrumentId, costs });
  account.advance(hour, [], []);
  assert.equal(account.snapshot(hour).currentEquity, "10000");
  account.accept(decision(hour));
  assert.equal(account.snapshot(hour).openPositions.length, 0); // next-open fill is pending
  const bars = [bar(hour, "100", "105", "98"), bar(hour + quarter, "104", "110", "101"),
                bar(hour + 2 * quarter, "109", "115", "106"), bar(hour + 3 * quarter, "114", "120", "112")];
  account.advance(2 * hour, bars, []);
  assert.equal(account.completed.length, 0);
  assert.equal(account.snapshot(2 * hour).currentEquity, "10000");
  assert.equal(account.snapshot(2 * hour).openPositions[0].riskAmountAtStop, "11");
  const next = [bar(2 * hour, "119", "141", "118"), bar(2 * hour + quarter, "140", "143", "139"),
                bar(2 * hour + 2 * quarter, "141", "142", "139"), bar(2 * hour + 3 * quarter, "140", "142", "139")];
  account.advance(3 * hour, next, []);
  assert.equal(account.completed.length, 1);
  assert.equal(account.snapshot(3 * hour).openPositions.length, 0);
  assert.equal(account.requestedRiskAmount(),
    multiplyDecimal(account.snapshot(3 * hour).currentEquity, "0.01"));
  assert.equal(account.completed[0].exitTime, 2 * hour + quarter);
});

test("funding is applied only after its event and only to an open position", () => {
  const account = new CausalResearchAccount({ initialEquity: "10000", instrumentId, costs });
  account.advance(hour, [], []);
  account.accept(decision(hour));
  const bars = [bar(hour, "100", "105", "98"), bar(hour + quarter, "100", "105", "98"),
                bar(hour + 2 * quarter, "100", "105", "98"), bar(hour + 3 * quarter, "100", "105", "98")];
  const events = [{ time: hour, rate: "-0.001" }, { time: 2 * hour, rate: "0.001" },
                  { time: 5 * hour, rate: "0.5" }];
  account.advance(2 * hour, bars, events);
  assert.equal(account.snapshot(2 * hour).currentEquity, "9999.89998");
  assert.equal(account.completed.length, 0);
});
