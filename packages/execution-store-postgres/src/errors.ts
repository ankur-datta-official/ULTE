export class PersistenceCorruptionError extends Error {
  public override readonly name = "PersistenceCorruptionError";

  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
  }
}

export type PersistenceConflictCode =
  | "IDEMPOTENCY_CONFLICT"
  | "IMMUTABLE_IDENTITY_CONFLICT"
  | "MONOTONIC_TIME_VIOLATION"
  | "ADAPTER_ORDER_ID_CONFLICT"
  | "AUDIT_EVENT_CONFLICT"
  | "AMBIGUOUS_ENVIRONMENT";

export class PersistenceConflictError extends Error {
  public override readonly name = "PersistenceConflictError";

  public constructor(
    public readonly code: PersistenceConflictCode,
    message: string,
  ) {
    super(message);
  }
}
