import type { DecisionCycleId } from "@ulte/realtime-decision-engine";

declare const preparationProfileIdBrand: unique symbol;
declare const preparationCycleIdBrand: unique symbol;
declare const preparationContextFingerprintBrand: unique symbol;

export type PreparationProfileId = string & {
  readonly [preparationProfileIdBrand]: "PreparationProfileId";
};
export type PreparationCycleId = string & {
  readonly [preparationCycleIdBrand]: "PreparationCycleId";
};
export type PreparationContextFingerprint = string & {
  readonly [preparationContextFingerprintBrand]: "PreparationContextFingerprint";
};

export function encodePreparationFields(values: readonly string[]): string {
  return values.map((value) => `${value.length}:${value}`).join("");
}

export function createPreparationProfileId(fields: readonly string[]): PreparationProfileId {
  return `ulte:realtime-execution-preparation-profile:v1:${encodePreparationFields(fields)}` as PreparationProfileId;
}

export function createPreparationCycleId(
  decisionCycleId: DecisionCycleId,
  preparationProfileId: PreparationProfileId,
): PreparationCycleId {
  return `ulte:realtime-execution-preparation-cycle:v1:${encodePreparationFields([
    decisionCycleId,
    preparationProfileId,
  ])}` as PreparationCycleId;
}

export function createPreparationContextFingerprint(
  fields: readonly string[],
): PreparationContextFingerprint {
  return `ulte:realtime-execution-preparation-context:v1:${encodePreparationFields(fields)}` as PreparationContextFingerprint;
}
