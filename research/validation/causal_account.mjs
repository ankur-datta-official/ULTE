/** Deterministic research account, advanced only by closed 15m bars and funding events. */
import { addDecimal, multiplyDecimal, subtractDecimal, compareDecimal } from "../../packages/exact-decimal/dist/index.js";

const DAY = 86_400_000;
const ZERO = "0";
const bps = (value) => {
  if (!Number.isInteger(value) || value < 0 || value > 10_000) throw new Error("Invalid basis-point cost");
  return `${Math.trunc(value / 10_000)}.${String(value % 10_000).padStart(4, "0")}`;
};
const positive = (value) => compareDecimal(value, ZERO) > 0;
const signed = (value, direction) => direction === "UP" ? value : subtractDecimal(ZERO, value);

export class CausalResearchAccount {
  constructor({ initialEquity, instrumentId, costs, riskFraction = "0.01" }) {
    if (!positive(initialEquity) || !positive(riskFraction)) throw new Error("Positive initial equity and risk fraction required");
    this.initialEquity = initialEquity;
    this.currentEquity = initialEquity;
    this.dayStartEquity = initialEquity;
    this.instrumentId = instrumentId;
    this.costs = costs;
    this.riskFraction = riskFraction;
    this.positions = [];
    this.completed = [];
    this.lastBoundary = null;
    this.fundingCursor = 0;
  }

  snapshot(asOf) {
    if (this.lastBoundary !== asOf) throw new Error("Account snapshot requires the current closed boundary");
    if (!positive(this.currentEquity)) throw new Error("Research account equity exhausted");
    return {
      asOf, baseCurrency: "USDT", currentEquity: this.currentEquity,
      dayStartEquity: this.dayStartEquity,
      openPositions: this.positions.filter((p) => p.entryPrice !== null).map((p) => ({
        positionId: p.candidateId, instrumentId: this.instrumentId,
        riskAmountAtStop: p.riskAmount, riskGroupIds: [],
      })),
    };
  }

  requestedRiskAmount() {
    return multiplyDecimal(this.currentEquity, this.riskFraction);
  }

  accept(decision) {
    if (decision.status !== "TRADE_INTENT_CREATED" || decision.analysisAsOf !== this.lastBoundary) {
      throw new Error("Only current-boundary ready intents can enter the account");
    }
    const intent = decision.tradeIntentResult;
    const sizing = decision.positionSizingResult;
    if (this.positions.some((p) => p.candidateId === intent.candidateId) ||
        this.completed.some((p) => p.candidateId === intent.candidateId)) {
      throw new Error("Repeated candidate cannot be opened again");
    }
    this.positions.push({
      candidateId: intent.candidateId, direction: intent.direction,
      decisionTime: decision.analysisAsOf, entryTime: decision.analysisAsOf,
      entryPrice: null, quantity: sizing.sizedQuantity, riskAmount: sizing.actualRiskAmount,
      stop: intent.invalidationPrice, target: intent.primaryTargetPrice,
      accruedFunding: ZERO, fundingEvents: 0,
    });
  }

  advance(boundary, quarters, fundingEvents) {
    if (this.lastBoundary === null) {
      if (quarters.length) throw new Error("First boundary cannot include prior candles");
    } else {
      if (boundary !== this.lastBoundary + 3_600_000 || quarters.length !== 4 ||
          quarters[0].openTime !== this.lastBoundary || quarters[3].closeTime !== boundary) {
        throw new Error("Noncausal or incomplete account step");
      }
      for (const candle of quarters) this.processQuarter(candle, fundingEvents);
    }
    this.lastBoundary = boundary;
    if (boundary % DAY === 0) this.dayStartEquity = this.currentEquity;
  }

  processQuarter(candle, fundingEvents) {
    for (const p of this.positions) {
      if (p.entryPrice === null) {
        if (p.entryTime !== candle.openTime) throw new Error("Pending entry missed next 15m open");
        const adverse = multiplyDecimal(candle.open, bps(this.costs.entrySlippageBps + this.costs.spreadBps));
        p.entryPrice = p.direction === "UP" ? addDecimal(candle.open, adverse) : subtractDecimal(candle.open, adverse);
        if (!positive(p.entryPrice) ||
            (p.direction === "UP" ? compareDecimal(p.entryPrice, p.stop) <= 0 : compareDecimal(p.entryPrice, p.stop) >= 0)) {
          throw new Error("Next-open entry invalidates structural stop");
        }
      }
      const stopHit = p.direction === "UP" ? compareDecimal(candle.low, p.stop) <= 0 : compareDecimal(candle.high, p.stop) >= 0;
      const targetHit = p.direction === "UP" ? compareDecimal(candle.high, p.target) >= 0 : compareDecimal(candle.low, p.target) <= 0;
      let rawExit = null;
      let exitReason = null;
      if (stopHit) {
        rawExit = p.direction === "UP"
          ? (compareDecimal(candle.open, p.stop) < 0 ? candle.open : p.stop)
          : (compareDecimal(candle.open, p.stop) > 0 ? candle.open : p.stop);
        exitReason = targetHit ? "BOTH_STOP_FIRST" : "STOP";
      } else if (targetHit) {
        rawExit = p.target;
        exitReason = "TARGET";
      }
      // The exit bar has unknown intrabar settlement order: possible debits
      // count, possible credits do not. Earlier bars use the actual signed rate.
      for (let k = this.fundingCursor; k < fundingEvents.length; k++) {
        const event = fundingEvents[k];
        if (event.time > candle.closeTime) break;
        if (event.time < candle.openTime || event.time < p.entryTime) continue;
        const debitRate = signed(event.rate, p.direction);
        const boundaryAmbiguous = event.time === p.entryTime || rawExit !== null;
        const appliedRate = !boundaryAmbiguous || positive(debitRate) ? debitRate : ZERO;
        const amount = multiplyDecimal(multiplyDecimal(p.entryPrice, p.quantity), appliedRate);
        p.accruedFunding = addDecimal(p.accruedFunding, amount);
        this.currentEquity = subtractDecimal(this.currentEquity, amount);
        p.fundingEvents += 1;
      }
      if (rawExit !== null) {
        const exitSlippage = multiplyDecimal(rawExit, bps(this.costs.exitSlippageBps + this.costs.spreadBps));
        const exitPrice = p.direction === "UP" ? subtractDecimal(rawExit, exitSlippage) : addDecimal(rawExit, exitSlippage);
        const move = p.direction === "UP" ? subtractDecimal(exitPrice, p.entryPrice) : subtractDecimal(p.entryPrice, exitPrice);
        const fees = addDecimal(multiplyDecimal(p.entryPrice, bps(this.costs.entryFeeBps)),
                                multiplyDecimal(exitPrice, bps(this.costs.exitFeeBps)));
        const pricePnl = multiplyDecimal(p.quantity, subtractDecimal(move, fees));
        this.currentEquity = addDecimal(this.currentEquity, pricePnl);
        this.completed.push({ ...p, exitTime: candle.closeTime, exitPrice, exitReason,
                              netPnl: subtractDecimal(pricePnl, p.accruedFunding),
                              accountEquityAfterExit: this.currentEquity });
        p.closed = true;
      }
    }
    this.positions = this.positions.filter((p) => !p.closed);
    while (this.fundingCursor < fundingEvents.length && fundingEvents[this.fundingCursor].time <= candle.closeTime) {
      this.fundingCursor += 1;
    }
  }
}
