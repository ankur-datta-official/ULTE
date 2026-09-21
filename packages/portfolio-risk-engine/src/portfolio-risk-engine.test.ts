import { describe, expect, it } from "vitest";
import { createInstrumentId, currencyCode, unixMs } from "@ulte/instrument-model";
import type { QualifiedRiskResult, RiskQualificationResult } from "@ulte/risk-engine";
import {
  createAccountRiskSnapshot,
  createOpenPositionRisk,
  createPortfolioRiskConfig,
  evaluatePortfolioRisk,
  type AccountRiskSnapshot,
  type OpenPositionRisk,
  type PortfolioRiskConfig,
  type PortfolioRiskEvaluationInput,
} from "./index.js";

const instrument = createInstrumentId({ venue: "TEST", venueSymbol: "ABC", instrumentKind: "SPOT" });
const otherInstrument = createInstrumentId({ venue: "TEST", venueSymbol: "XYZ", instrumentKind: "SPOT" });
const asOf = unixMs(1_000);

const TEST_CONFIG = createPortfolioRiskConfig({
  maxRiskPerTradeBps: 100,
  maxTotalOpenRiskBps: 300,
  maxConcurrentPositions: 3,
  maxDailyLossBps: 500,
  riskGroupLimits: [
    { groupId: "GROUP_A", maxRiskBps: 200 },
    { groupId: "GROUP_B", maxRiskBps: 150 },
    { groupId: "UNRELATED", maxRiskBps: 300 },
  ],
});

function structural(status: RiskQualificationResult["status"] = "QUALIFIED"): RiskQualificationResult {
  const common = { candidateId: "candidate-1", instrumentId: instrument, asOf };
  if (status === "NOT_QUALIFIED") {
    return { status, ...common, reason: "NET_RR_BELOW_MINIMUM" } as RiskQualificationResult;
  }
  if (status === "DATA_REJECTED") {
    return { status, ...common, reason: "DATA_GAP" } as RiskQualificationResult;
  }
  return { status, ...common } as QualifiedRiskResult;
}

function position(
  positionId: string,
  riskAmountAtStop: string,
  riskGroupIds: readonly string[] = ["GROUP_A"],
  selectedInstrument = instrument,
): OpenPositionRisk {
  return createOpenPositionRisk({ positionId, instrumentId: selectedInstrument, riskAmountAtStop, riskGroupIds });
}

function account(options: {
  readonly currentEquity?: string;
  readonly dayStartEquity?: string;
  readonly openPositions?: readonly OpenPositionRisk[];
  readonly snapshotAsOf?: number;
} = {}): AccountRiskSnapshot {
  return createAccountRiskSnapshot({
    asOf: options.snapshotAsOf ?? asOf,
    baseCurrency: "USD",
    currentEquity: options.currentEquity ?? "10000",
    dayStartEquity: options.dayStartEquity ?? "10000",
    openPositions: options.openPositions ?? [],
  });
}

function fixture(overrides: Partial<PortfolioRiskEvaluationInput> = {}): PortfolioRiskEvaluationInput {
  return {
    structuralRiskResult: structural(),
    account: account(),
    requestedRiskAmount: "100",
    proposedRiskGroupIds: ["GROUP_A"],
    config: TEST_CONFIG,
    ...overrides,
  };
}

function run(overrides: Partial<PortfolioRiskEvaluationInput> = {}) {
  return evaluatePortfolioRisk(fixture(overrides));
}

function unsafeAccount(overrides: Partial<AccountRiskSnapshot>): AccountRiskSnapshot {
  return { ...account(), ...overrides };
}

describe("configuration, construction, and upstream boundary", () => {
  it("validates every explicit config field and deeply freezes the policy", () => {
    expect(Object.isFrozen(TEST_CONFIG)).toBe(true);
    expect(Object.isFrozen(TEST_CONFIG.riskGroupLimits)).toBe(true);
    expect(Object.isFrozen(TEST_CONFIG.riskGroupLimits[0])).toBe(true);
    expect(() => createPortfolioRiskConfig({ ...TEST_CONFIG, maxRiskPerTradeBps: 0 })).toThrow();
    expect(() => createPortfolioRiskConfig({ ...TEST_CONFIG, maxRiskPerTradeBps: 301 })).toThrow();
    expect(() => createPortfolioRiskConfig({ ...TEST_CONFIG, maxTotalOpenRiskBps: 10_001 })).toThrow();
    expect(() => createPortfolioRiskConfig({ ...TEST_CONFIG, maxConcurrentPositions: 0 })).toThrow();
    expect(() => createPortfolioRiskConfig({ ...TEST_CONFIG, maxDailyLossBps: 1.5 })).toThrow();
    expect(() => createPortfolioRiskConfig({ ...TEST_CONFIG, riskGroupLimits: [{ groupId: "A", maxRiskBps: 301 }] })).toThrow();
    expect(() => createPortfolioRiskConfig({ ...TEST_CONFIG, riskGroupLimits: [{ groupId: "A", maxRiskBps: 1 }, { groupId: "A", maxRiskBps: 1 }] })).toThrow();
  });

  it("freezes snapshots, position records, and nested arrays", () => {
    const openPosition = position("p1", "10", ["GROUP_A", "GROUP_B"]);
    const snapshot = account({ openPositions: [openPosition] });
    expect(Object.isFrozen(openPosition)).toBe(true);
    expect(Object.isFrozen(openPosition.riskGroupIds)).toBe(true);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.openPositions)).toBe(true);
  });

  it("allows QUALIFIED upstream and preserves NOT_QUALIFIED and DATA_REJECTED", () => {
    expect(run().status).toBe("CAPITAL_ELIGIBLE");
    expect(run({ structuralRiskResult: structural("NOT_QUALIFIED") })).toEqual(expect.objectContaining({
      status: "UPSTREAM_NOT_QUALIFIED", upstreamStatus: "NOT_QUALIFIED", upstreamReason: "NET_RR_BELOW_MINIMUM",
      candidateId: "candidate-1",
    }));
    expect(run({ structuralRiskResult: structural("DATA_REJECTED") })).toEqual(expect.objectContaining({
      status: "UPSTREAM_NOT_QUALIFIED", upstreamStatus: "DATA_REJECTED", upstreamReason: "DATA_GAP",
    }));
  });

  it("returns upstream failure before evaluating invalid portfolio input", () => {
    const result = run({ structuralRiskResult: structural("NOT_QUALIFIED"), requestedRiskAmount: "0" });
    expect(result.status).toBe("UPSTREAM_NOT_QUALIFIED");
  });
});

describe("account and request data validation", () => {
  it.each([
    ["0", "INVALID_ACCOUNT_EQUITY"],
    ["-0.01", "INVALID_ACCOUNT_EQUITY"],
  ] as const)("rejects current equity %s", (value, reason) => {
    expect(run({ account: unsafeAccount({ currentEquity: value as AccountRiskSnapshot["currentEquity"] }) })).toEqual(
      expect.objectContaining({ status: "DATA_REJECTED", reason }),
    );
  });

  it("rejects zero or invalid day-start equity", () => {
    expect(run({ account: unsafeAccount({ dayStartEquity: "0" as AccountRiskSnapshot["dayStartEquity"] }) })).toEqual(
      expect.objectContaining({ status: "DATA_REJECTED", reason: "INVALID_DAY_START_EQUITY" }),
    );
  });

  it.each(["0", "-0.0001"])("rejects requested risk %s", (requestedRiskAmount) => {
    expect(run({ requestedRiskAmount })).toEqual(
      expect.objectContaining({ status: "DATA_REJECTED", reason: "INVALID_REQUESTED_RISK" }),
    );
  });

  it("rejects the strict as-of mismatch", () => {
    expect(run({ account: account({ snapshotAsOf: 999 }) })).toEqual(
      expect.objectContaining({ status: "DATA_REJECTED", reason: "AS_OF_MISMATCH" }),
    );
  });

  it("rejects duplicate/invalid position IDs and negative stop risk", () => {
    const p1 = position("p1", "10");
    expect(run({ account: unsafeAccount({ openPositions: [p1, p1] }) })).toEqual(
      expect.objectContaining({ reason: "DUPLICATE_POSITION_ID" }),
    );
    expect(run({ account: unsafeAccount({ openPositions: [{ ...p1, positionId: "" }] }) })).toEqual(
      expect.objectContaining({ reason: "INVALID_POSITION_ID" }),
    );
    expect(run({ account: unsafeAccount({ openPositions: [{ ...p1, riskAmountAtStop: "-0.01" as OpenPositionRisk["riskAmountAtStop"] }] }) })).toEqual(
      expect.objectContaining({ reason: "INVALID_OPEN_POSITION_RISK" }),
    );
  });

  it("rejects empty and duplicate position groups, including an empty group list", () => {
    const p1 = position("p1", "10");
    expect(run({ account: unsafeAccount({ openPositions: [{ ...p1, riskGroupIds: [""] }] }) })).toEqual(
      expect.objectContaining({ reason: "EMPTY_RISK_GROUP" }),
    );
    expect(run({ account: unsafeAccount({ openPositions: [{ ...p1, riskGroupIds: [] }] }) })).toEqual(
      expect.objectContaining({ reason: "EMPTY_RISK_GROUP" }),
    );
    expect(run({ account: unsafeAccount({ openPositions: [{ ...p1, riskGroupIds: ["GROUP_A", "GROUP_A"] }] }) })).toEqual(
      expect.objectContaining({ reason: "DUPLICATE_POSITION_RISK_GROUP" }),
    );
  });

  it("rejects duplicate, empty, and unknown proposed groups", () => {
    expect(run({ proposedRiskGroupIds: ["GROUP_A", "GROUP_A"] })).toEqual(
      expect.objectContaining({ reason: "DUPLICATE_PROPOSED_RISK_GROUP" }),
    );
    expect(run({ proposedRiskGroupIds: [""] })).toEqual(expect.objectContaining({ reason: "EMPTY_RISK_GROUP" }));
    expect(run({ proposedRiskGroupIds: ["MISSING"] })).toEqual(expect.objectContaining({
      reason: "UNKNOWN_RISK_GROUP", unknownRiskGroupId: "MISSING",
    }));
  });

  it("rejects an unknown group already present in account state", () => {
    expect(run({ account: account({ openPositions: [position("p1", "10", ["MISSING"])] }) })).toEqual(
      expect.objectContaining({ reason: "UNKNOWN_RISK_GROUP", unknownRiskGroupId: "MISSING" }),
    );
  });
});

describe("daily loss and concurrent-position circuit breakers", () => {
  it("floors daily loss at zero when equity increased", () => {
    expect(run({ account: account({ currentEquity: "10100", dayStartEquity: "10000" }) })).toEqual(
      expect.objectContaining({ status: "CAPITAL_ELIGIBLE", dailyLossAmount: "0" }),
    );
  });

  it("calculates an exact loss and blocks exactly at the configured ratio", () => {
    const exact = run({ account: account({ currentEquity: "9500", dayStartEquity: "10000" }), requestedRiskAmount: "1" });
    expect(exact).toEqual(expect.objectContaining({
      status: "BLOCKED", reason: "DAILY_LOSS_LIMIT_REACHED", dailyLossAmount: "500",
      maximumAdditionalRiskAmount: "0",
    }));
    const below = run({ account: account({ currentEquity: "9500.00000001", dayStartEquity: "10000" }), requestedRiskAmount: "1" });
    expect(below).not.toEqual(expect.objectContaining({ reason: "DAILY_LOSS_LIMIT_REACHED" }));
  });

  it("allows below the position count and blocks exactly at it with zero capacity", () => {
    const two = [position("p1", "10"), position("p2", "10")];
    expect(run({ account: account({ openPositions: two }) }).status).toBe("CAPITAL_ELIGIBLE");
    const three = [...two, position("p3", "10")];
    expect(run({ account: account({ openPositions: three }) })).toEqual(expect.objectContaining({
      status: "BLOCKED", reason: "MAX_CONCURRENT_POSITIONS_REACHED", maximumAdditionalRiskAmount: "0",
    }));
  });
});

describe("exact per-trade and aggregate risk", () => {
  it("allows exact per-trade equality and blocks a microscopic excess", () => {
    expect(run({ requestedRiskAmount: "100" }).status).toBe("CAPITAL_ELIGIBLE");
    expect(run({ requestedRiskAmount: "100.0000000000000001" })).toEqual(expect.objectContaining({
      status: "BLOCKED", reason: "PER_TRADE_RISK_LIMIT_EXCEEDED",
    }));
  });

  it("sums multiple open risks exactly and allows aggregate equality", () => {
    const openPositions = [position("p1", "50"), position("p2", "75")];
    const config = createPortfolioRiskConfig({ ...TEST_CONFIG, maxRiskPerTradeBps: 200 });
    expect(run({ account: account({ openPositions }), requestedRiskAmount: "175", proposedRiskGroupIds: ["UNRELATED"], config })).toEqual(expect.objectContaining({
      status: "CAPITAL_ELIGIBLE", currentTotalOpenRisk: "125", postTradeTotalOpenRisk: "300",
      remainingTotalOpenRiskCapacity: "175",
    }));
  });

  it("blocks a microscopic aggregate excess", () => {
    const config = createPortfolioRiskConfig({ ...TEST_CONFIG, maxRiskPerTradeBps: 200 });
    expect(run({
      account: account({ openPositions: [position("p1", "50"), position("p2", "75")] }),
      requestedRiskAmount: "175.0000000001",
      proposedRiskGroupIds: ["UNRELATED"],
      config,
    })).toEqual(expect.objectContaining({ status: "BLOCKED", reason: "TOTAL_OPEN_RISK_LIMIT_EXCEEDED" }));
  });
});

describe("risk-group controls", () => {
  it("allows exact group equality and blocks an excess with its group ID", () => {
    const atCap = run({ account: account({ openPositions: [position("p1", "50", ["GROUP_B"])] }), proposedRiskGroupIds: ["GROUP_B"] });
    expect(atCap.status).toBe("CAPITAL_ELIGIBLE");
    const above = run({ account: account({ openPositions: [position("p1", "50.00001", ["GROUP_B"])] }), proposedRiskGroupIds: ["GROUP_B"] });
    expect(above).toEqual(expect.objectContaining({
      status: "BLOCKED", reason: "RISK_GROUP_LIMIT_EXCEEDED", blockingRiskGroupId: "GROUP_B",
    }));
  });

  it("uses proposed input order when multiple groups fail", () => {
    const openPositions = [position("p1", "100", ["GROUP_A", "GROUP_B"])];
    expect(run({ account: account({ openPositions }), proposedRiskGroupIds: ["GROUP_B", "GROUP_A"] })).toEqual(
      expect.objectContaining({ blockingRiskGroupId: "GROUP_B" }),
    );
  });

  it("counts full risk in every membership and no risk in unrelated groups", () => {
    const openPositions = [position("p1", "60", ["GROUP_A", "GROUP_B"])];
    const result = run({ account: account({ openPositions }), requestedRiskAmount: "80", proposedRiskGroupIds: ["GROUP_A", "GROUP_B", "UNRELATED"] });
    expect(result).toEqual(expect.objectContaining({ status: "CAPITAL_ELIGIBLE" }));
    if ("proposedRiskGroups" in result) {
      expect(result.proposedRiskGroups.map((group) => [group.groupId, group.currentGroupRisk, group.postTradeGroupRisk])).toEqual([
        ["GROUP_A", "60", "140"], ["GROUP_B", "60", "140"], ["UNRELATED", "0", "80"],
      ]);
    }
  });

  it("blocks the failing member in a multi-group proposal", () => {
    const result = run({
      account: account({ openPositions: [position("p1", "60", ["GROUP_B"])] }),
      requestedRiskAmount: "100",
      proposedRiskGroupIds: ["GROUP_A", "GROUP_B"],
    });
    expect(result).toEqual(expect.objectContaining({
      status: "BLOCKED", reason: "RISK_GROUP_LIMIT_EXCEEDED", blockingRiskGroupId: "GROUP_B",
    }));
  });
});

describe("remaining capacity, exact decimal range, and determinism", () => {
  it("selects per-trade, total, or group headroom as the smallest applicable capacity", () => {
    expect(run()).toEqual(expect.objectContaining({ maximumAdditionalRiskAmount: "100" }));
    expect(run({ account: account({ openPositions: [position("p1", "250", ["UNRELATED"])] }) })).toEqual(
      expect.objectContaining({ maximumAdditionalRiskAmount: "50" }),
    );
    expect(run({ account: account({ openPositions: [position("p1", "120", ["GROUP_B"])] }), proposedRiskGroupIds: ["GROUP_B"] })).toEqual(
      expect.objectContaining({ maximumAdditionalRiskAmount: "30" }),
    );
  });

  it("handles tiny and large decimals, 0.1/0.2 sums, and never emits exponent notation", () => {
    const tinyConfig = createPortfolioRiskConfig({
      maxRiskPerTradeBps: 10_000, maxTotalOpenRiskBps: 10_000, maxConcurrentPositions: 3,
      maxDailyLossBps: 10_000, riskGroupLimits: [{ groupId: "GROUP_A", maxRiskBps: 10_000 }],
    });
    const tiny = run({ account: account({ currentEquity: "0.00000003", dayStartEquity: "0.00000003", openPositions: [position("p1", "0.00000001")] }), requestedRiskAmount: "0.00000002", config: tinyConfig });
    expect(tiny).toEqual(expect.objectContaining({ status: "CAPITAL_ELIGIBLE", postTradeTotalOpenRisk: "0.00000003" }));

    const exact = run({ account: account({ currentEquity: "100", dayStartEquity: "100", openPositions: [position("p1", "0.1")] }), requestedRiskAmount: "0.2" });
    expect(exact).toEqual(expect.objectContaining({ currentTotalOpenRisk: "0.1", postTradeTotalOpenRisk: "0.3" }));

    const large = run({ account: account({ currentEquity: "999999999999999999999999999999", dayStartEquity: "999999999999999999999999999999" }), requestedRiskAmount: "1" });
    expect(JSON.stringify(large)).not.toMatch(/\d[eE][+-]?\d/);
  });

  it("preserves fractional limit precision introduced by basis points", () => {
    const result = run({ account: account({ currentEquity: "1.2345", dayStartEquity: "1.2345" }), requestedRiskAmount: "0.012345" });
    expect(result).toEqual(expect.objectContaining({ perTradeRiskLimitAmount: "0.012345" }));
  });

  it("does not mutate inputs, deeply freezes results, and repeats equivalently", () => {
    const proposed = ["GROUP_A"];
    const openPositions = [position("p1", "10")];
    const input = fixture({ account: account({ openPositions }), proposedRiskGroupIds: proposed });
    const before = JSON.stringify(input);
    const first = evaluatePortfolioRisk(input);
    const second = evaluatePortfolioRisk(input);
    expect(JSON.stringify(input)).toBe(before);
    expect(first).toEqual(second);
    expect(Object.isFrozen(first)).toBe(true);
    if ("proposedRiskGroups" in first) {
      expect(Object.isFrozen(first.proposedRiskGroups)).toBe(true);
      expect(Object.isFrozen(first.proposedRiskGroups[0])).toBe(true);
    }
    expect(proposed).toEqual(["GROUP_A"]);
    expect(openPositions).toHaveLength(1);
  });

  it("uses documented reason priority deterministically", () => {
    const positions = [position("p1", "1"), position("p2", "1"), position("p3", "1")];
    const result = run({
      account: account({ currentEquity: "9500", dayStartEquity: "10000", openPositions: positions }),
      requestedRiskAmount: "1000",
    });
    expect(result).toEqual(expect.objectContaining({ reason: "DAILY_LOSS_LIMIT_REACHED" }));
  });

  it("has no wall-clock or randomness dependency", () => {
    const originalNow = Date.now;
    const originalRandom = Math.random;
    Date.now = () => { throw new Error("wall clock accessed"); };
    Math.random = () => { throw new Error("randomness accessed"); };
    try {
      expect(run()).toEqual(evaluatePortfolioRisk(fixture()));
    } finally {
      Date.now = originalNow;
      Math.random = originalRandom;
    }
  });
});

describe("constructor rejection coverage", () => {
  it("rejects malformed position construction", () => {
    expect(() => createOpenPositionRisk({ positionId: "", instrumentId: instrument, riskAmountAtStop: "1", riskGroupIds: ["GROUP_A"] })).toThrow();
    expect(() => createOpenPositionRisk({ positionId: "p", instrumentId: otherInstrument, riskAmountAtStop: "-1", riskGroupIds: ["GROUP_A"] })).toThrow();
    expect(() => createOpenPositionRisk({ positionId: "p", instrumentId: instrument, riskAmountAtStop: "1", riskGroupIds: [] })).toThrow();
    expect(() => createOpenPositionRisk({ positionId: "p", instrumentId: instrument, riskAmountAtStop: "1", riskGroupIds: ["GROUP_A", "GROUP_A"] })).toThrow();
  });

  it("rejects invalid or duplicate account snapshot positions", () => {
    const p1 = { positionId: "p1", instrumentId: instrument, riskAmountAtStop: "1", riskGroupIds: ["GROUP_A"] };
    expect(() => createAccountRiskSnapshot({ asOf, baseCurrency: "USD", currentEquity: "0", dayStartEquity: "1", openPositions: [] })).toThrow();
    expect(() => createAccountRiskSnapshot({ asOf, baseCurrency: "USD", currentEquity: "1", dayStartEquity: "0", openPositions: [] })).toThrow();
    expect(() => createAccountRiskSnapshot({ asOf, baseCurrency: "USD", currentEquity: "1", dayStartEquity: "1", openPositions: [p1, p1] })).toThrow();
  });

  it("uses the existing public currency-code type", () => {
    expect(account().baseCurrency).toBe(currencyCode("USD"));
  });
});
