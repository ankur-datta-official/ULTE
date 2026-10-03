export class PersistenceCorruptionError extends Error {
  public override readonly name = "PersistenceCorruptionError";

  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
  }
}

export class PersistenceConflictError extends Error {
  public override readonly name = "PersistenceConflictError";

  public constructor(
    public readonly code: "CONCURRENT_RECOVERY_CONFLICT" | "REVISION_OVERFLOW" | "CONCURRENT_LEASE_CONFLICT" | "LEASE_FENCE_OVERFLOW",
    message: string,
  ) {
    super(message);
  }
}

export class PersistenceInfrastructureError extends Error {
  public override readonly name = "PersistenceInfrastructureError";

  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
  }
}
