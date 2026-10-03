export class PersistenceCorruptionError extends Error {
  public override readonly name = "PersistenceCorruptionError";

  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
  }
}

export class PersistenceConflictError extends Error {
  public override readonly name = "PersistenceConflictError";

  public constructor(
    public readonly code: "CONCURRENT_RECOVERY_CONFLICT" | "REVISION_OVERFLOW",
    message: string,
  ) {
    super(message);
  }
}
