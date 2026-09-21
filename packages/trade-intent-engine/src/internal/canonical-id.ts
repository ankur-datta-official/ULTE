import { TRADE_INTENT_SCHEMA_VERSION } from "../types.js";

export interface TradeIntentIdentityFields {
  readonly candidateId: string;
  readonly instrumentId: string;
  readonly asOf: number;
  readonly direction: string;
  readonly entryReferencePrice: string;
  readonly invalidationPrice: string;
  readonly primaryTargetPrice: string;
  readonly quantity: string;
  readonly accountCurrency: string;
}

export function encodeLengthPrefixed(values: readonly string[]): string {
  return values.map((value) => `${value.length}:${value}`).join("");
}

export function createIntentId(fields: TradeIntentIdentityFields): string {
  return `ulte:trade-intent:${encodeLengthPrefixed([
    TRADE_INTENT_SCHEMA_VERSION,
    fields.candidateId,
    fields.instrumentId,
    String(fields.asOf),
    fields.direction,
    fields.entryReferencePrice,
    fields.invalidationPrice,
    fields.primaryTargetPrice,
    fields.quantity,
    fields.accountCurrency,
  ])}`;
}
