import type { Database } from "bun:sqlite";
import type { Command, CommandResult } from "./cli-contract";
import { parseArg } from "./cli-flags";
import { sqliteCode } from "./db-error";
import { readingRecord } from "./db-read";
import { errorDetail } from "./error-read";
import { dbPath } from "./paths";
import { cellOf } from "./query";
import type { Cell, Rows } from "./query-contract";
import { capResult, rowsOf, rowsToRead } from "./query-row-cap";
import { refuseSql } from "./sql-contract";

const SQL_DENOMINATOR = "the rows the statement returned, in the order SQLite returned them";

function refusalOf(error: unknown, statement: string): unknown {
  const code = sqliteCode(error);
  if (code === "SQLITE_ERROR")
    return refuseSql("sql_invalid", { statement, detail: errorDetail(error) }, error);
  if (code?.startsWith("SQLITE_READONLY")) return refuseSql("sql_writes", { statement }, error);
  return error;
}

function sqlCellOf(statement: string, column: string, value: unknown): Cell {
  if (value instanceof Uint8Array) throw refuseSql("sql_blob", { statement, column });
  return cellOf(value);
}

function readRows(db: Database, statement: string, maxRows: number): Rows {
  try {
    const prepared = db.query<Record<string, unknown>, []>(statement);
    const columns = prepared.columnNames;
    const repeated = columns.find((column, at) => columns.indexOf(column) !== at);
    if (repeated !== undefined) throw refuseSql("sql_columns_repeated", { statement, column: repeated });
    const toRead = rowsToRead(maxRows);
    const rows: Cell[][] = [];
    for (const row of prepared.iterate()) {
      rows.push(columns.map((column) => sqlCellOf(statement, column, row[column])));
      if (rows.length === toRead) break;
    }
    return { columns, rows };
  } catch (error) {
    throw refusalOf(error, statement);
  }
}

function answer(path: string, statement: string, maxRows: number): CommandResult {
  return readingRecord(path, (db) => {
    const { columns, rows } = readRows(db, statement, maxRows);
    const result = {
      denominator: SQL_DENOMINATOR,
      columns,
      rows,
      note: rows.length === 0 ? "the statement ran and matched nothing" : null,
    };
    return { value: capResult(result, maxRows), exitCode: 0 };
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
