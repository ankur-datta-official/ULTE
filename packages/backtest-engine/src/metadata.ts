import { instrumentId, unixMs, type InstrumentId, type UnixMs } from "@ulte/instrument-model";
import { marketDataSource, type MarketDataSource } from "@ulte/market-data";

declare const datasetIdBrand: unique symbol;
declare const backtestRunIdBrand: unique symbol;
declare const replaySchemaVersionBrand: unique symbol;

export type DatasetId = string & { readonly [datasetIdBrand]: "DatasetId" };
export type BacktestRunId = string & { readonly [backtestRunIdBrand]: "BacktestRunId" };
export type ReplaySchemaVersion = string & { readonly [replaySchemaVersionBrand]: "ReplaySchemaVersion" };

function opaqueId<T extends string>(value: unknown, label: string): T {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) {
    throw new TypeError(`${label} must be a non-empty string without surrounding whitespace`);
  }
  return value as T;
}

export const datasetId = (value: unknown): DatasetId => opaqueId<DatasetId>(value, "DatasetId");
export const backtestRunId = (value: unknown): BacktestRunId => opaqueId<BacktestRunId>(value, "BacktestRunId");
export const replaySchemaVersion = (value: unknown): ReplaySchemaVersion =>
  opaqueId<ReplaySchemaVersion>(value, "ReplaySchemaVersion");

export interface HistoricalDatasetManifest {
  readonly datasetId: DatasetId;
  readonly instrumentId: InstrumentId;
  readonly source: MarketDataSource;
  readonly eventType: string;
  readonly startTime?: UnixMs;
  readonly endTime?: UnixMs;
  readonly eventCount?: number;
}

export function createHistoricalDatasetManifest(input: {
  readonly datasetId: string;
  readonly instrumentId: string;
  readonly source: string;
  readonly eventType: string;
  readonly startTime?: number;
  readonly endTime?: number;
  readonly eventCount?: number;
}): HistoricalDatasetManifest {
  const startTime = input.startTime === undefined ? undefined : unixMs(input.startTime);
  const endTime = input.endTime === undefined ? undefined : unixMs(input.endTime);
  if (startTime !== undefined && endTime !== undefined && endTime < startTime) {
    throw new RangeError("Dataset endTime cannot precede startTime");
  }
  if (input.eventCount !== undefined && (!Number.isSafeInteger(input.eventCount) || input.eventCount < 0)) {
    throw new RangeError("Dataset eventCount must be a non-negative safe integer");
  }
  if (input.eventCount === 0 && (startTime !== undefined || endTime !== undefined)) {
    throw new TypeError("An empty dataset cannot have a startTime or endTime");
  }
  const eventType = opaqueId<string>(input.eventType, "EventType");
  return Object.freeze({
    datasetId: datasetId(input.datasetId),
    instrumentId: instrumentId(input.instrumentId),
    source: marketDataSource(input.source),
    eventType,
    ...(startTime === undefined ? {} : { startTime }),
    ...(endTime === undefined ? {} : { endTime }),
    ...(input.eventCount === undefined ? {} : { eventCount: input.eventCount }),
  });
}

export type ReplayConfigurationValue =
  | null | boolean | number | string
  | readonly ReplayConfigurationValue[]
  | { readonly [key: string]: ReplayConfigurationValue };

function snapshotConfiguration(value: ReplayConfigurationValue): ReplayConfigurationValue {
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new TypeError("Replay configuration numbers must be finite");
  }
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return Object.freeze(value.map(snapshotConfiguration));
  const snapshot: Record<string, ReplayConfigurationValue> = {};
  for (const [key, item] of Object.entries(value)) snapshot[key] = snapshotConfiguration(item);
  return Object.freeze(snapshot);
}

export interface BacktestRunMetadata {
  readonly runId: BacktestRunId;
  readonly datasetId: DatasetId;
  readonly replaySchemaVersion: ReplaySchemaVersion;
  readonly configuration: ReplayConfigurationValue;
}

export function createBacktestRunMetadata(input: {
  readonly runId: string;
  readonly datasetId: string;
  readonly replaySchemaVersion: string;
  readonly configuration: ReplayConfigurationValue;
}): BacktestRunMetadata {
  return Object.freeze({
    runId: backtestRunId(input.runId),
    datasetId: datasetId(input.datasetId),
    replaySchemaVersion: replaySchemaVersion(input.replaySchemaVersion),
    configuration: snapshotConfiguration(input.configuration),
  });
}
