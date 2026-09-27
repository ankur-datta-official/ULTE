import type { InstrumentId } from "@ulte/instrument-model";
import type { MarketDataSource, SequenceId } from "@ulte/market-data";
import type { LiveEventKind, SourceEpochId, SourceEventId } from "./contracts.js";

declare const liveStreamIdBrand: unique symbol;
declare const liveEventIdentityBrand: unique symbol;
declare const liveEventFingerprintBrand: unique symbol;

export type LiveStreamId = string & { readonly [liveStreamIdBrand]: "LiveStreamId" };
export type LiveEventIdentity = string & { readonly [liveEventIdentityBrand]: "LiveEventIdentity" };
export type LiveEventFingerprint = string & { readonly [liveEventFingerprintBrand]: "LiveEventFingerprint" };

export function encodeLengthPrefixed(values: readonly string[]): string {
  return values.map((value) => `${value.length}:${value}`).join("");
}

export function createLiveStreamId(input: {
  readonly sourceId: MarketDataSource;
  readonly instrumentId: InstrumentId;
  readonly eventKind: LiveEventKind;
}): LiveStreamId {
  return `ulte:live-stream:v1:${encodeLengthPrefixed([
    input.sourceId,
    input.instrumentId,
    input.eventKind,
  ])}` as LiveStreamId;
}

export function createLiveEventIdentity(input: {
  readonly streamId: LiveStreamId;
  readonly epochId: SourceEpochId;
  readonly sequenceId?: SequenceId;
  readonly sourceEventId?: SourceEventId;
}): LiveEventIdentity {
  if ((input.sequenceId === undefined) === (input.sourceEventId === undefined)) {
    throw new TypeError("Event identity requires exactly one of sequenceId or sourceEventId");
  }
  const discriminator = input.sequenceId === undefined
    ? ["SOURCE_EVENT_ID", input.sourceEventId!]
    : ["SEQUENCE_ID", input.sequenceId];
  return `ulte:live-event:v1:${encodeLengthPrefixed([
    input.streamId,
    input.epochId,
    ...discriminator,
  ])}` as LiveEventIdentity;
}

export function createLiveEventFingerprint(fields: readonly string[]): LiveEventFingerprint {
  return `ulte:live-fingerprint:v1:${encodeLengthPrefixed(fields)}` as LiveEventFingerprint;
}
