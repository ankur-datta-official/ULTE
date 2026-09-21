import { EXECUTION_PLAN_SCHEMA_VERSION } from "../types.js";

export interface ExecutionPlanIdentityFields {
  readonly tradeIntentId: string;
  readonly executionAsOf: number;
  readonly marketSnapshotAsOf: number;
  readonly bid: string;
  readonly ask: string;
  readonly entrySide: string;
  readonly quantity: string;
  readonly entryPrice: string;
  readonly stopPrice: string;
  readonly targetPrice: string;
}

export function encodeLengthPrefixed(values: readonly string[]): string {
  return values.map((value) => `${value.length}:${value}`).join("");
}

export function createExecutionPlanId(fields: ExecutionPlanIdentityFields): string {
  return `ulte:execution-plan:${encodeLengthPrefixed([
    EXECUTION_PLAN_SCHEMA_VERSION,
    fields.tradeIntentId,
    String(fields.executionAsOf),
    String(fields.marketSnapshotAsOf),
    fields.bid,
    fields.ask,
    fields.entrySide,
    fields.quantity,
    fields.entryPrice,
    fields.stopPrice,
    fields.targetPrice,
  ])}`;
}
