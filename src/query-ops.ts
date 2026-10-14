import type { Runtime } from "./cli-contract";
import { readingRecord } from "./db-read";
import { dbPath } from "./paths";
import type { CappedResult, Query, QueryContext } from "./query-contract";
import { QUERIES } from "./query-registry";
import { capResult } from "./query-row-cap";

export function listQueries() {
  return { queries: QUERIES.map(({ name, usage, summary }) => ({ name, usage, summary })) };
}

export function runQuery(
  query: Query,
  asked: Omit<QueryContext, "home">,
  runtime: Pick<Runtime, "env" | "heldRecordWaitMs">,
): CappedResult {
  return readingRecord(dbPath(runtime.env), runtime, (db) =>
    capResult(query.run(db, { ...asked, home: runtime.env.home }), asked.maxRows),
  );
}
