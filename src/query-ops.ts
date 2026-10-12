import { readingRecord } from "./db-read";
import { dbPath, resolveHomeDir } from "./paths";
import type { CappedResult, Query } from "./query-contract";
import { QUERIES } from "./query-registry";
import { capResult } from "./query-row-cap";

export function listQueries() {
  return { queries: QUERIES.map(({ name, usage, summary }) => ({ name, usage, summary })) };
}

export function runQuery(query: Query, arg: string, maxRows: number): CappedResult {
  return readingRecord(dbPath(), (db) =>
    capResult(query.run(db, { arg, home: resolveHomeDir(), maxRows }), maxRows),
  );
}
