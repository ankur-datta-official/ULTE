import type { InstrumentId } from "@ulte/instrument-model";
import type { MarketDataSource } from "@ulte/market-data";

declare const analysisProfileIdBrand: unique symbol;
declare const analysisCycleIdBrand: unique symbol;

export type AnalysisProfileId = string & { readonly [analysisProfileIdBrand]: "AnalysisProfileId" };
export type AnalysisCycleId = string & { readonly [analysisCycleIdBrand]: "AnalysisCycleId" };

export function encodeLengthPrefixed(values: readonly string[]): string {
  return values.map((value) => `${value.length}:${value}`).join("");
}

export function createAnalysisProfileId(fields: readonly string[]): AnalysisProfileId {
  return `ulte:realtime-analysis-profile:v1:${encodeLengthPrefixed(fields)}` as AnalysisProfileId;
}

export function createAnalysisCycleId(input: {
  readonly instrumentId: InstrumentId;
  readonly source: MarketDataSource;
  readonly triggerCloseTime: number;
  readonly analysisProfileId: AnalysisProfileId;
}): AnalysisCycleId {
  return `ulte:realtime-analysis-cycle:v1:${encodeLengthPrefixed([
    input.instrumentId,
    input.source,
    String(input.triggerCloseTime),
    input.analysisProfileId,
  ])}` as AnalysisCycleId;
}
