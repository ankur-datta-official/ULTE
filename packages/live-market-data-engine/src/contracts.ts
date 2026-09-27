import {
  instrumentId,
  unixMs,
  type InstrumentId,
  type UnixMs,
} from "@ulte/instrument-model";
import {
  createMarketDataEvent,
  createTradeTick,
  marketDataSource,
  type MarketDataEvent,
  type MarketDataSource,
  type TradeTick,
} from "@ulte/market-data";

export const LIVE_EVENT_KINDS = ["TRADE"] as const;
export type LiveEventKind = (typeof LIVE_EVENT_KINDS)[number];

export const LIVE_SOURCE_MODES = ["LIVE", "PAPER", "REPLAY"] as const;
export type LiveSourceMode = (typeof LIVE_SOURCE_MODES)[number];

export const SEQUENCE_SEMANTICS = [
  "NONE",
  "OPAQUE",
  "STRICTLY_INCREMENTING_NON_NEGATIVE_INTEGER",
] as const;
export type SequenceSemantics = (typeof SEQUENCE_SEMANTICS)[number];

declare const sourceEventIdBrand: unique symbol;
declare const sourceEpochIdBrand: unique symbol;
declare const subscriptionIdBrand: unique symbol;

export type SourceEventId = string & { readonly [sourceEventIdBrand]: "SourceEventId" };
export type SourceEpochId = string & { readonly [sourceEpochIdBrand]: "SourceEpochId" };
export type LiveSubscriptionId = string & { readonly [subscriptionIdBrand]: "LiveSubscriptionId" };

function opaqueId(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) {
    throw new TypeError(`${label} must be non-empty and have no surrounding whitespace`);
  }
  return value;
}

export function sourceEventId(value: unknown): SourceEventId {
  return opaqueId(value, "SourceEventId") as SourceEventId;
}

export function sourceEpochId(value: unknown): SourceEpochId {
  return opaqueId(value, "SourceEpochId") as SourceEpochId;
}

export function liveSubscriptionId(value: unknown): LiveSubscriptionId {
  return opaqueId(value, "LiveSubscriptionId") as LiveSubscriptionId;
}

export interface LiveMarketDataSourceDescriptor {
  readonly sourceId: MarketDataSource;
  readonly mode: LiveSourceMode;
  readonly capabilities: readonly LiveEventKind[];
  readonly sequenceSemantics: SequenceSemantics;
}

export function createLiveMarketDataSourceDescriptor(
  input: LiveMarketDataSourceDescriptor,
): LiveMarketDataSourceDescriptor {
  if (!(LIVE_SOURCE_MODES as readonly string[]).includes(input.mode)) {
    throw new TypeError(`Invalid live source mode: ${String(input.mode)}`);
  }
  if (!(SEQUENCE_SEMANTICS as readonly string[]).includes(input.sequenceSemantics)) {
    throw new TypeError(`Invalid sequence semantics: ${String(input.sequenceSemantics)}`);
  }
  if (input.capabilities.length === 0 || new Set(input.capabilities).size !== input.capabilities.length ||
      input.capabilities.some((capability) => !(LIVE_EVENT_KINDS as readonly string[]).includes(capability))) {
    throw new TypeError("Source capabilities must be non-empty, supported, and unique");
  }
  return Object.freeze({
    sourceId: marketDataSource(input.sourceId),
    mode: input.mode,
    capabilities: Object.freeze([...input.capabilities]),
    sequenceSemantics: input.sequenceSemantics,
  });
}

export interface LiveTradeEvent {
  readonly kind: "TRADE";
  readonly sourceEventId?: SourceEventId;
  readonly event: MarketDataEvent<TradeTick>;
}

export function createLiveTradeEvent(input: {
  readonly sourceEventId?: string;
  readonly event: MarketDataEvent<TradeTick>;
}): LiveTradeEvent {
  const event = createMarketDataEvent({
    instrumentId: input.event.instrumentId,
    source: input.event.source,
    eventTime: input.event.eventTime,
    receivedAt: input.event.receivedAt,
    payload: createTradeTick({
      price: input.event.payload.price,
      quantity: input.event.payload.quantity,
      side: input.event.payload.side,
    }),
    quality: input.event.quality,
    ...(input.event.sequenceId === undefined ? {} : { sequenceId: input.event.sequenceId }),
  });
  return Object.freeze({
    kind: "TRADE",
    ...(input.sourceEventId === undefined ? {} : { sourceEventId: sourceEventId(input.sourceEventId) }),
    event,
  });
}

export interface LiveSubscriptionRequest {
  readonly instrumentId: InstrumentId;
  readonly eventKinds: readonly LiveEventKind[];
}

export function createLiveSubscriptionRequest(input: LiveSubscriptionRequest): LiveSubscriptionRequest {
  if (input.eventKinds.length === 0 || new Set(input.eventKinds).size !== input.eventKinds.length ||
      input.eventKinds.some((kind) => !(LIVE_EVENT_KINDS as readonly string[]).includes(kind))) {
    throw new TypeError("Subscription event kinds must be non-empty, supported, and unique");
  }
  return Object.freeze({
    instrumentId: instrumentId(input.instrumentId),
    eventKinds: Object.freeze([...input.eventKinds]),
  });
}

export interface LiveMarketDataSink {
  onEvent(event: LiveTradeEvent, observationTime: UnixMs): void | Promise<void>;
}

export interface LiveSubscription {
  readonly subscriptionId: LiveSubscriptionId;
  unsubscribe(): Promise<void>;
}

export interface LiveMarketDataSource {
  readonly descriptor: LiveMarketDataSourceDescriptor;
  subscribe(request: LiveSubscriptionRequest, sink: LiveMarketDataSink): Promise<LiveSubscription>;
}

export function observationTime(value: unknown): UnixMs {
  return unixMs(value);
}
