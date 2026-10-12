import { readingRecord } from "./db-read";
import { dbPath, resolveHomeDir } from "./paths";
import type { Query } from "./query-contract";
import { QUERIES } from "./query-registry";
import { capRows } from "./query-row-cap";

export function listQueries() {
  return { queries: QUERIES.map(({ name, usage, summary }) => ({ name, usage, summary })) };
}

export function runQuery(query: Query, arg: string, maxRows: number) {
  return readingRecord(dbPath(), (db) => {
    const result = query.run(db, { arg, home: resolveHomeDir(), maxRows });
    return { ...result, ...capRows(result.rows, maxRows) };
  });
}
