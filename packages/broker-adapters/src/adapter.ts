import { createAdapterCapabilities, type ExecutionAdapter } from "@ulte/execution-engine";
import {
  brokerAdapterId,
  credentialProfileRef,
  isExecutionEnvironment,
  type BrokerAdapterDescriptor,
} from "./identity.js";

/** Venue-neutral asynchronous adapter contract. It adds metadata without changing execution contracts. */
export interface BrokerAdapter extends ExecutionAdapter {
  readonly descriptor: BrokerAdapterDescriptor;
}

const DESCRIPTOR_FIELDS: readonly string[] = Object.freeze([
  "adapterId",
  "environment",
  "credentialProfileRef",
  "capabilities",
]);

/** Runtime handshake for adapters entering a registry. It performs no I/O. */
export function assertBrokerAdapterConformance(adapter: BrokerAdapter): void {
  const descriptor = adapter.descriptor;
  if (!Object.isFrozen(descriptor) || !Object.isFrozen(descriptor.capabilities)) {
    throw new TypeError("Broker adapter descriptor and capabilities must be immutable");
  }
  const descriptorKeys = Object.keys(descriptor);
  if (
    descriptorKeys.length !== DESCRIPTOR_FIELDS.length
    || descriptorKeys.some((field) => !DESCRIPTOR_FIELDS.includes(field))
  ) {
    throw new TypeError("Broker adapter descriptor contains unsupported fields");
  }
  brokerAdapterId(descriptor.adapterId);
  credentialProfileRef(descriptor.credentialProfileRef);
  if (!isExecutionEnvironment(descriptor.environment)) {
    throw new TypeError("Broker adapter environment must be explicit");
  }
  const exposed = createAdapterCapabilities(adapter.capabilities);
  const declared = descriptor.capabilities;
  if (
    exposed.supportsClientIdempotency !== declared.supportsClientIdempotency
    || exposed.supportsCloseOnlyExit !== declared.supportsCloseOnlyExit
    || exposed.supportsNativeBracketProtection !== declared.supportsNativeBracketProtection
    || exposed.supportsProtectionModification !== declared.supportsProtectionModification
    || exposed.supportsOrderCancellation !== declared.supportsOrderCancellation
    || exposed.supportsPartialFillReporting !== declared.supportsPartialFillReporting
  ) {
    throw new TypeError("Broker adapter capabilities do not match its descriptor");
  }
}
