import { SQLiteError } from "bun:sqlite";
import { type Command, Ran } from "./cli-contract";
import { parseArg } from "./cli-flags";
import { readingRecord } from "./db-read";
import { dbPath } from "./paths";
import { capRows, rowsOf } from "./query-row-cap";
import { refuseSql } from "./sql-contract";

function refusalOf(error: unknown, statement: string): unknown {
  if (!(error instanceof SQLiteError)) return error;
  if (error.code === "SQLITE_ERROR")
    return refuseSql("sql_invalid", { statement, detail: error.message }, error);
  if (error.code?.startsWith("SQLITE_READONLY")) return refuseSql("sql_writes", { statement }, error);
  return error;
}

function answer(path: string, statement: string, maxRows: number): Ran {
  return readingRecord(path, (db) => {
    const rows: Record<string, unknown>[] = [];
    try {
      for (const row of db.query<Record<string, unknown>, []>(statement).iterate()) {
        rows.push(row);
        if (rows.length > maxRows) break;
      }
    } catch (error) {
      throw refusalOf(error, statement);
    }
    return new Ran(
      {
        denominator: rows.length > maxRows ? `more than ${maxRows} rows` : `${rows.length} rows`,
        ...capRows(rows, maxRows),
        note: rows.length === 0 ? "the statement ran and matched nothing" : null,
      },
      0,
    );
  });
}

export const sqlCommand: Command = {
  name: "sql",
  usage: 'agent-record sql "<select>" [--rows <n>]',
  summary: "run one read-only statement against the database",
  run(args) {
    const { arg: statement, flags } = parseArg(args, ["rows"], sqlCommand.usage);
    const maxRows = rowsOf(flags.rows);
    return answer(dbPath(), statement, maxRows);
  },
};
