export interface PostgresQueryResult<Row> {
  readonly rows: readonly Row[];
  readonly rowCount: number;
}

export interface PostgresTransaction {
  query<Row>(sql: string, params: readonly unknown[]): Promise<PostgresQueryResult<Row>>;
}

export interface PostgresExecutor extends PostgresTransaction {
  transaction<T>(work: (transaction: PostgresTransaction) => Promise<T>): Promise<T>;
}

/** A single pinned, REPEATABLE READ READ ONLY PostgreSQL transaction.
 * The executor establishes isolation before any transactional read, runs all
 * callback queries on that connection, commits on success, and rolls back on
 * error. No broker or provider operation is implied.
 */
export interface PostgresSnapshotExecutor extends PostgresExecutor {
  snapshot<T>(work: (transaction: PostgresTransaction) => Promise<T>): Promise<T>;
}
