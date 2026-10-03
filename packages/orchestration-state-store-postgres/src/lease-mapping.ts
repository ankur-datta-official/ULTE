import { unixMs, type UnixMs } from "@ulte/instrument-model";
import {
  orchestrationFenceToken,
  orchestrationLeaseOwnerId,
  orchestrationSessionId,
  type OrchestrationFenceToken,
  type OrchestrationHeldLease,
  type OrchestrationSessionId,
} from "@ulte/orchestration-state-store";
import { PersistenceCorruptionError } from "./errors.js";

export interface LeaseRow {
  readonly session_id: unknown;
  readonly owner_id: unknown;
  readonly fence_token: unknown;
  readonly expires_at_ms: unknown;
}

export function safeLeaseBigint(value: unknown, field: string): number {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return value;
  if (typeof value === "string" && /^(0|[1-9]\d*)$/.test(value)) {
    const parsed = BigInt(value);
    if (parsed <= BigInt(Number.MAX_SAFE_INTEGER)) return Number(parsed);
  }
  throw new PersistenceCorruptionError(`Invalid ${field} BIGINT`);
}

export interface MappedLeaseRow {
  readonly sessionId: OrchestrationSessionId;
  readonly ownerId: OrchestrationHeldLease["ownerId"] | null;
  readonly fenceToken: OrchestrationFenceToken;
  readonly expiresAt: UnixMs | null;
}

export function mapLeaseRow(row: LeaseRow): MappedLeaseRow {
  try {
    const sessionId = orchestrationSessionId(row.session_id);
    const fenceToken = orchestrationFenceToken(safeLeaseBigint(row.fence_token, "fence_token"));
    const ownerId = row.owner_id === null ? null : orchestrationLeaseOwnerId(row.owner_id);
    const expiresAt = row.expires_at_ms === null ? null : unixMs(safeLeaseBigint(row.expires_at_ms, "expires_at_ms"));
    if ((ownerId === null) !== (expiresAt === null)) throw new TypeError("Lease owner/expiry mismatch");
    return Object.freeze({ sessionId, ownerId, fenceToken, expiresAt });
  } catch (cause) {
    throw new PersistenceCorruptionError("Invalid orchestration recovery lease row", { cause });
  }
}
