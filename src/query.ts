import type { Database, SQLQueryBindings } from "bun:sqlite";
import { z } from "zod";
import { invariant } from "./assert";
import { Count, readRows } from "./db";
import { agentIdOfFileName, subagentSessionSql } from "./ingest-ids";
import { Cell, type Rows, refuseQuery } from "./query-contract";
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
  const row = readRows<SQLQueryBindings[]>(db, sql).get(Count, ...params);
  invariant(row !== null, `a count returns one row: ${sql}`);
  return row.n;
}

export function cellOf(value: unknown): Cell {
  const cell = Cell.safeParse(value);
  invariant(cell.success, `a query column holds text, a number or null, not ${typeof value}`);
  return cell.data;
}

const CellRow = z.array(Cell);

export function select(db: Database, sql: string, params: SQLQueryBindings[] = []): Rows {
  const read = readRows<SQLQueryBindings[]>(db, sql);
  return { columns: read.columns, rows: read.values(CellRow, ...params) };
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

const SessionRow = z.strictObject({ id: z.string() });

export function sessionByPrefix(db: Database, query: string, prefix: string): string | null {
  const found = readRows<[string, string | null]>(
    db,
    `SELECT id FROM session
     WHERE instr(lower(id), lower(?1)) = 1
        OR (${subagentSessionSql("id")} AND instr(lower(id), lower(?2)) = 1)
     ORDER BY id LIMIT 2`,
  ).all(SessionRow, prefix, agentIdOfFileName(prefix));
  if (found.length > 1) {
    throw refuseQuery("ambiguous_session", { query, prefix, matches: found.map((session) => session.id) });
  }
  return found[0]?.id ?? null;
}
