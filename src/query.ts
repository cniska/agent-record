import type { Database, SQLQueryBindings } from "bun:sqlite";
import { invariant } from "./assert";
import { type Cell, type Rows, refuseQuery } from "./query-contract";
import { ArgumentTimestamp, type Timestamp } from "./timestamp";

export const SAID = "m.is_skill_body = 0 AND (m.is_meta = 0 OR m.origin_kind IN ('coordinator', 'peer'))";

export function callFailureSql(call: string): string {
  return `CASE
    WHEN ${call}.is_interrupted = 1 THEN 'interrupted'
    WHEN ${call}.exit_code IS NOT NULL AND ${call}.exit_code <> 0 THEN 'exit ' || ${call}.exit_code
    WHEN ${call}.is_error = 1 THEN 'error'
  END`;
}

export function scalar(db: Database, sql: string, params: SQLQueryBindings[] = []): number {
  const row = db.query<{ n: number }, SQLQueryBindings[]>(sql).get(...params);
  invariant(row !== null, `a count returns one row: ${sql}`);
  return row.n;
}

export function cellOf(value: unknown): Cell {
  invariant(
    value === null || typeof value === "string" || typeof value === "number",
    `a query column holds text, a number or null, not ${typeof value}`,
  );
  return value;
}

export function select(db: Database, sql: string, params: SQLQueryBindings[] = []): Rows {
  const statement = db.query<unknown, SQLQueryBindings[]>(sql);
  const rows = statement.values(...params).map((row) => row.map(cellOf));
  return { columns: statement.columnNames, rows };
}

export function countFlag(flag: string, value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw refuseQuery("not_a_count", { flag, value });
  return n;
}

export function timeFlag(flag: string, value: string): Timestamp {
  const time = ArgumentTimestamp.safeParse(value);
  if (!time.success) throw refuseQuery("not_a_time", { flag, value });
  return time.data;
}

export function sessionByPrefix(db: Database, query: string, prefix: string): string | null {
  const found = db
    .query<{ id: string }, [string]>(
      "SELECT id FROM session WHERE instr(lower(id), lower(?)) = 1 ORDER BY id LIMIT 2",
    )
    .all(prefix);
  if (found.length > 1) {
    throw refuseQuery("ambiguous_session", { query, prefix, matches: found.map((session) => session.id) });
  }
  return found[0]?.id ?? null;
}
