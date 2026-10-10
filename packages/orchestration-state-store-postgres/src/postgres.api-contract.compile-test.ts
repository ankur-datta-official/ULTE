import type { PostgresExecutor, PostgresSnapshotExecutor } from "./index.js";

type Assert<T extends true> = T;
export type PlainExecutorExcluded = Assert<PostgresExecutor extends PostgresSnapshotExecutor ? false : true>;
export type SnapshotExtendsWriter = Assert<PostgresSnapshotExecutor extends PostgresExecutor ? true : false>;
export type SnapshotMethodRequired = Assert<undefined extends PostgresSnapshotExecutor["snapshot"] ? false : true>;
