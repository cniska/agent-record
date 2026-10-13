import { readingRecord } from "./db-read";
import { dbPath, resolveHomeDir } from "./paths";
import type { CappedResult, Query, QueryContext } from "./query-contract";
import { QUERIES } from "./query-registry";
import { capResult } from "./query-row-cap";

export function listQueries() {
  return { queries: QUERIES.map(({ name, usage, summary }) => ({ name, usage, summary })) };
}

export function runQuery(query: Query, asked: Omit<QueryContext, "home">): CappedResult {
  return readingRecord(dbPath(), (db) =>
    capResult(query.run(db, { ...asked, home: resolveHomeDir() }), asked.maxRows),
  );
}
