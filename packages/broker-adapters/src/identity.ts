import { createAdapterCapabilities, type AdapterCapabilities } from "@ulte/execution-engine";

declare const brokerAdapterIdBrand: unique symbol;
declare const credentialProfileRefBrand: unique symbol;

export type BrokerAdapterId = string & { readonly [brokerAdapterIdBrand]: "BrokerAdapterId" };
export type CredentialProfileRef = string & { readonly [credentialProfileRefBrand]: "CredentialProfileRef" };

export const EXECUTION_ENVIRONMENTS = ["DRY_RUN", "SANDBOX", "LIVE"] as const;
export type ExecutionEnvironment = (typeof EXECUTION_ENVIRONMENTS)[number];

export interface BrokerAdapterDescriptor {
  readonly adapterId: BrokerAdapterId;
  readonly environment: ExecutionEnvironment;
  readonly credentialProfileRef: CredentialProfileRef;
  readonly capabilities: AdapterCapabilities;
}

export interface BrokerAdapterDescriptorInput {
  readonly adapterId: string;
  readonly environment: ExecutionEnvironment;
  readonly credentialProfileRef: string;
  readonly capabilities: AdapterCapabilities;
}

function opaqueReference(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) {
    throw new TypeError(`${field} must be non-empty and have no surrounding whitespace`);
  }
  return value;
}

export function brokerAdapterId(value: unknown): BrokerAdapterId {
  return opaqueReference(value, "BrokerAdapterId") as BrokerAdapterId;
}

export function credentialProfileRef(value: unknown): CredentialProfileRef {
  return opaqueReference(value, "CredentialProfileRef") as CredentialProfileRef;
}

export function isExecutionEnvironment(value: unknown): value is ExecutionEnvironment {
  return typeof value === "string" && (EXECUTION_ENVIRONMENTS as readonly string[]).includes(value);
}

export function createBrokerAdapterDescriptor(
  input: BrokerAdapterDescriptorInput,
): BrokerAdapterDescriptor {
  if (!isExecutionEnvironment(input.environment)) {
    throw new TypeError("An explicit valid execution environment is required");
  }
  return Object.freeze({
    adapterId: brokerAdapterId(input.adapterId),
    environment: input.environment,
    credentialProfileRef: credentialProfileRef(input.credentialProfileRef),
    capabilities: createAdapterCapabilities(input.capabilities),
  });
}
