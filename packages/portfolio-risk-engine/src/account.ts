import {
  currencyCode,
  instrumentId,
  nonNegativeDecimalString,
  positiveDecimalString,
  unixMs,
} from "@ulte/instrument-model";
import type {
  AccountRiskSnapshot,
  AccountRiskSnapshotInput,
  OpenPositionRisk,
  OpenPositionRiskInput,
} from "./types.js";

function id(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) {
    throw new TypeError(`${label} must be non-empty and have no surrounding whitespace`);
  }
  return value;
}

export function createOpenPositionRisk(input: OpenPositionRiskInput): Readonly<OpenPositionRisk> {
  if (input.riskGroupIds.length === 0) throw new TypeError("riskGroupIds must not be empty");
  const seenGroups = new Set<string>();
  const riskGroupIds = input.riskGroupIds.map((value) => {
    const groupId = id(value, "riskGroupId");
    if (seenGroups.has(groupId)) throw new TypeError(`Duplicate position risk group: ${groupId}`);
    seenGroups.add(groupId);
    return groupId;
  });
  return Object.freeze({
    positionId: id(input.positionId, "positionId"),
    instrumentId: instrumentId(input.instrumentId),
    riskAmountAtStop: nonNegativeDecimalString(input.riskAmountAtStop),
    riskGroupIds: Object.freeze(riskGroupIds),
  });
}

export function createAccountRiskSnapshot(input: AccountRiskSnapshotInput): Readonly<AccountRiskSnapshot> {
  const positionIds = new Set<string>();
  const openPositions = input.openPositions.map((inputPosition) => {
    const position = createOpenPositionRisk(inputPosition);
    if (positionIds.has(position.positionId)) throw new TypeError(`Duplicate position ID: ${position.positionId}`);
    positionIds.add(position.positionId);
    return position;
  });
  return Object.freeze({
    asOf: unixMs(input.asOf),
    baseCurrency: currencyCode(input.baseCurrency),
    currentEquity: positiveDecimalString(input.currentEquity),
    dayStartEquity: positiveDecimalString(input.dayStartEquity),
    openPositions: Object.freeze(openPositions),
  });
}
