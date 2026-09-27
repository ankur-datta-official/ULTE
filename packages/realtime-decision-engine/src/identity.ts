import type { AnalysisCycleId } from "@ulte/realtime-analysis-engine";

declare const decisionProfileIdBrand: unique symbol;
declare const decisionCycleIdBrand: unique symbol;
declare const decisionContextFingerprintBrand: unique symbol;

export type DecisionProfileId = string & { readonly [decisionProfileIdBrand]: "DecisionProfileId" };
export type DecisionCycleId = string & { readonly [decisionCycleIdBrand]: "DecisionCycleId" };
export type DecisionContextFingerprint = string & {
  readonly [decisionContextFingerprintBrand]: "DecisionContextFingerprint";
};

export function encodeDecisionFields(values: readonly string[]): string {
  return values.map((value) => `${value.length}:${value}`).join("");
}

export function createDecisionProfileId(fields: readonly string[]): DecisionProfileId {
  return `ulte:realtime-decision-profile:v1:${encodeDecisionFields(fields)}` as DecisionProfileId;
}

export function createDecisionCycleId(
  analysisCycleId: AnalysisCycleId,
  decisionProfileId: DecisionProfileId,
): DecisionCycleId {
  return `ulte:realtime-decision-cycle:v1:${encodeDecisionFields([
    analysisCycleId,
    decisionProfileId,
  ])}` as DecisionCycleId;
}

export function createDecisionContextFingerprint(fields: readonly string[]): DecisionContextFingerprint {
  return `ulte:realtime-decision-context:v1:${encodeDecisionFields(fields)}` as DecisionContextFingerprint;
}
