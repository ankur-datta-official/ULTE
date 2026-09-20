import {
  nonNegativeDecimalString,
  positiveDecimalString,
  type NonNegativeDecimalString,
  type PositiveDecimalString,
} from "./decimal.js";
import { unixMs, type UnixMs } from "./time.js";

declare const venueIdBrand: unique symbol;
declare const venueSymbolBrand: unique symbol;
declare const currencyCodeBrand: unique symbol;
declare const instrumentIdBrand: unique symbol;

export type VenueId = string & { readonly [venueIdBrand]: "VenueId" };
export type VenueSymbol = string & { readonly [venueSymbolBrand]: "VenueSymbol" };
export type CurrencyCode = string & { readonly [currencyCodeBrand]: "CurrencyCode" };
export type InstrumentId = string & { readonly [instrumentIdBrand]: "InstrumentId" };

export const ASSET_CLASSES = [
  "CRYPTO", "FX", "METAL", "ENERGY", "AGRICULTURE", "EQUITY", "INDEX", "FIXED_INCOME", "OTHER",
] as const;
export type AssetClass = (typeof ASSET_CLASSES)[number];

export const INSTRUMENT_KINDS = [
  "SPOT", "PERPETUAL", "FUTURE", "OPTION", "CFD", "EQUITY", "ETF", "INDEX",
] as const;
export type InstrumentKind = (typeof INSTRUMENT_KINDS)[number];

export const MARKET_DATA_CAPABILITIES = [
  "QUOTE", "TRADES", "CANDLES", "ORDER_BOOK", "MARK_PRICE", "INDEX_PRICE", "FUNDING", "OPEN_INTEREST",
] as const;
export type MarketDataCapability = (typeof MARKET_DATA_CAPABILITIES)[number];

function nonEmptyUntrimmed(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) {
    throw new TypeError(`${label} must be non-empty and have no surrounding whitespace`);
  }
  return value;
}

export function venueId(value: unknown): VenueId {
  return nonEmptyUntrimmed(value, "VenueId") as VenueId;
}

export function venueSymbol(value: unknown): VenueSymbol {
  return nonEmptyUntrimmed(value, "VenueSymbol") as VenueSymbol;
}

export function currencyCode(value: unknown): CurrencyCode {
  if (typeof value !== "string" || !/^[A-Za-z0-9]{2,16}$/.test(value)) {
    throw new TypeError(`Invalid currency code: ${String(value)}`);
  }
  return value as CurrencyCode;
}

function isInstrumentKind(value: string): value is InstrumentKind {
  return (INSTRUMENT_KINDS as readonly string[]).includes(value);
}

export interface InstrumentIdentity {
  readonly venue: VenueId;
  readonly venueSymbol: VenueSymbol;
  readonly instrumentKind: InstrumentKind;
}

export function createInstrumentId(identity: {
  readonly venue: string;
  readonly venueSymbol: string;
  readonly instrumentKind: InstrumentKind;
}): InstrumentId {
  const venue = venueId(identity.venue);
  const symbol = venueSymbol(identity.venueSymbol);
  if (!isInstrumentKind(identity.instrumentKind)) {
    throw new TypeError(`Invalid instrument kind: ${String(identity.instrumentKind)}`);
  }
  return `ulte:v1:${encodeURIComponent(venue)}:${identity.instrumentKind}:${encodeURIComponent(symbol)}` as InstrumentId;
}

export function parseInstrumentId(value: unknown): InstrumentIdentity {
  if (typeof value !== "string") {
    throw new TypeError("InstrumentId must be a string");
  }
  const parts = value.split(":");
  if (parts.length !== 5 || parts[0] !== "ulte" || parts[1] !== "v1" || !isInstrumentKind(parts[3]!)) {
    throw new TypeError(`Invalid InstrumentId: ${value}`);
  }
  let venue: VenueId;
  let symbol: VenueSymbol;
  try {
    venue = venueId(decodeURIComponent(parts[2]!));
    symbol = venueSymbol(decodeURIComponent(parts[4]!));
  } catch {
    throw new TypeError(`Invalid InstrumentId: ${value}`);
  }
  const identity = Object.freeze({ venue, venueSymbol: symbol, instrumentKind: parts[3] as InstrumentKind });
  if (createInstrumentId(identity) !== value) {
    throw new TypeError(`InstrumentId is not canonical: ${value}`);
  }
  return identity;
}

export function instrumentId(value: unknown): InstrumentId {
  parseInstrumentId(value);
  return value as InstrumentId;
}

export interface InstrumentMetadata {
  readonly instrumentId: InstrumentId;
  readonly venue: VenueId;
  readonly venueSymbol: VenueSymbol;
  readonly assetClass: AssetClass;
  readonly instrumentKind: InstrumentKind;
  readonly baseCurrency?: CurrencyCode;
  readonly quoteCurrency?: CurrencyCode;
  readonly settlementCurrency?: CurrencyCode;
  readonly tickSize: PositiveDecimalString;
  readonly quantityStep: PositiveDecimalString;
  readonly contractSize?: PositiveDecimalString;
  readonly minimumQuantity?: NonNegativeDecimalString;
  readonly maximumQuantity?: NonNegativeDecimalString;
  readonly minimumNotional?: NonNegativeDecimalString;
  readonly expiryTime?: UnixMs;
  readonly marketDataCapabilities: readonly MarketDataCapability[];
}

export interface InstrumentMetadataInput extends Omit<InstrumentMetadata,
  "instrumentId" | "venue" | "venueSymbol" | "baseCurrency" | "quoteCurrency" | "settlementCurrency" |
  "tickSize" | "quantityStep" | "contractSize" | "minimumQuantity" | "maximumQuantity" | "minimumNotional" |
  "expiryTime" | "marketDataCapabilities"> {
  readonly instrumentId: string;
  readonly venue: string;
  readonly venueSymbol: string;
  readonly baseCurrency?: string;
  readonly quoteCurrency?: string;
  readonly settlementCurrency?: string;
  readonly tickSize: string;
  readonly quantityStep: string;
  readonly contractSize?: string;
  readonly minimumQuantity?: string;
  readonly maximumQuantity?: string;
  readonly minimumNotional?: string;
  readonly expiryTime?: number;
  readonly marketDataCapabilities: readonly MarketDataCapability[];
}

export function createInstrumentMetadata(input: InstrumentMetadataInput): InstrumentMetadata {
  if (!(ASSET_CLASSES as readonly string[]).includes(input.assetClass)) throw new TypeError("Invalid asset class");
  if (!isInstrumentKind(input.instrumentKind)) throw new TypeError("Invalid instrument kind");
  const id = instrumentId(input.instrumentId);
  const venue = venueId(input.venue);
  const symbol = venueSymbol(input.venueSymbol);
  const parsedIdentity = parseInstrumentId(id);
  if (parsedIdentity.venue !== venue || parsedIdentity.venueSymbol !== symbol || parsedIdentity.instrumentKind !== input.instrumentKind) {
    throw new TypeError("Instrument metadata identity does not match instrumentId");
  }
  const capabilities = [...new Set(input.marketDataCapabilities)];
  if (capabilities.length !== input.marketDataCapabilities.length || capabilities.some((item) => !(MARKET_DATA_CAPABILITIES as readonly string[]).includes(item))) {
    throw new TypeError("Market-data capabilities must be valid and unique");
  }
  return Object.freeze({
    instrumentId: id, venue, venueSymbol: symbol, assetClass: input.assetClass, instrumentKind: input.instrumentKind,
    ...(input.baseCurrency === undefined ? {} : { baseCurrency: currencyCode(input.baseCurrency) }),
    ...(input.quoteCurrency === undefined ? {} : { quoteCurrency: currencyCode(input.quoteCurrency) }),
    ...(input.settlementCurrency === undefined ? {} : { settlementCurrency: currencyCode(input.settlementCurrency) }),
    tickSize: positiveDecimalString(input.tickSize), quantityStep: positiveDecimalString(input.quantityStep),
    ...(input.contractSize === undefined ? {} : { contractSize: positiveDecimalString(input.contractSize) }),
    ...(input.minimumQuantity === undefined ? {} : { minimumQuantity: nonNegativeDecimalString(input.minimumQuantity) }),
    ...(input.maximumQuantity === undefined ? {} : { maximumQuantity: nonNegativeDecimalString(input.maximumQuantity) }),
    ...(input.minimumNotional === undefined ? {} : { minimumNotional: nonNegativeDecimalString(input.minimumNotional) }),
    ...(input.expiryTime === undefined ? {} : { expiryTime: unixMs(input.expiryTime) }),
    marketDataCapabilities: Object.freeze(capabilities),
  });
}
