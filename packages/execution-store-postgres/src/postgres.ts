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
