import { PRIMARY_REGIMES, type PrimaryRegime } from "@ulte/regime-engine";

export interface PositionSetupConfig {
  readonly continuationAllowedRegimes: readonly PrimaryRegime[];
  readonly breakoutAllowedRegimes: readonly PrimaryRegime[];
  readonly reversalAllowedRegimes: readonly PrimaryRegime[];
}

function regimes(values: readonly PrimaryRegime[], field: string): readonly PrimaryRegime[] {
  if (!Array.isArray(values)) throw new TypeError(`${field} must be an array`);
  if (new Set(values).size !== values.length) throw new TypeError(`${field} must not contain duplicates`);
  if (values.some((value) => !(PRIMARY_REGIMES as readonly unknown[]).includes(value))) {
    throw new TypeError(`${field} contains an unknown primary regime`);
  }
  return Object.freeze([...values]);
}

export function createPositionSetupConfig(input: PositionSetupConfig): Readonly<PositionSetupConfig> {
  return Object.freeze({
    continuationAllowedRegimes: regimes(input.continuationAllowedRegimes, "continuationAllowedRegimes"),
    breakoutAllowedRegimes: regimes(input.breakoutAllowedRegimes, "breakoutAllowedRegimes"),
    reversalAllowedRegimes: regimes(input.reversalAllowedRegimes, "reversalAllowedRegimes"),
  });
}
