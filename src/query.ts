import type { Database, SQLQueryBindings } from "bun:sqlite";
import { invariant } from "./assert";
import type { Cell, Rows } from "./query-contract";

export const SAID = "m.is_skill_body = 0 AND (m.is_meta = 0 OR m.origin_kind IN ('coordinator', 'peer'))";

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
