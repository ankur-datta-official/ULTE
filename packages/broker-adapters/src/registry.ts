import { assertBrokerAdapterConformance, type BrokerAdapter } from "./adapter.js";
import { brokerAdapterId, type BrokerAdapterId } from "./identity.js";

export interface BrokerAdapterRegistry {
  /** IDs appear in explicit registration order. */
  readonly adapterIds: readonly BrokerAdapterId[];
  get(adapterId: BrokerAdapterId | string): BrokerAdapter | undefined;
}

export function createBrokerAdapterRegistry(
  adapters: readonly BrokerAdapter[],
): BrokerAdapterRegistry {
  const byId = new Map<BrokerAdapterId, BrokerAdapter>();
  const adapterIds: BrokerAdapterId[] = [];

  for (const adapter of adapters) {
    assertBrokerAdapterConformance(adapter);
    const id = brokerAdapterId(adapter.descriptor.adapterId);
    if (byId.has(id)) throw new TypeError(`Duplicate broker adapter ID: ${id}`);
    byId.set(id, adapter);
    adapterIds.push(id);
  }

  const publicIds = Object.freeze(adapterIds);
  return Object.freeze({
    adapterIds: publicIds,
    get(adapterId: BrokerAdapterId | string): BrokerAdapter | undefined {
      return byId.get(brokerAdapterId(adapterId));
    },
  });
}
