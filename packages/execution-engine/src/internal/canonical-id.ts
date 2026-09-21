import { EXECUTION_ATTEMPT_SCHEMA_VERSION } from "../types.js";

export function encodeLengthPrefixed(values: readonly string[]): string {
  return values.map((value) => `${value.length}:${value}`).join("");
}

export interface ExecutionAttemptIdentityFields {
  readonly executionPlanId: string;
  readonly tradeIntentId: string;
  readonly instrumentId: string;
  readonly entrySide: string;
  readonly quantity: string;
  readonly entryPrice: string;
  readonly stopTriggerPrice: string;
  readonly targetPrice: string;
}

export function createExecutionAttemptId(fields: ExecutionAttemptIdentityFields): string {
  return `ulte:execution-attempt:${encodeLengthPrefixed([
    EXECUTION_ATTEMPT_SCHEMA_VERSION,
    fields.executionPlanId,
    fields.tradeIntentId,
    fields.instrumentId,
    fields.entrySide,
    fields.quantity,
    fields.entryPrice,
    fields.stopTriggerPrice,
    fields.targetPrice,
  ])}`;
}

export function createOperationKey(
  executionAttemptId: string,
  operation: "ENTRY_SUBMISSION" | "PROTECTION" | "ENTRY_CANCELLATION",
  discriminator?: string,
): string {
  return `ulte:execution-operation:${encodeLengthPrefixed([
    EXECUTION_ATTEMPT_SCHEMA_VERSION,
    executionAttemptId,
    operation,
    ...(discriminator === undefined ? [] : [discriminator]),
  ])}`;
}
