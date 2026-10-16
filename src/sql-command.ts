import type { Database } from "bun:sqlite";
import { z } from "zod";
import type { Command, CommandResult } from "./cli-contract";
import { parseArg } from "./cli-flags";
import { AnyRow, type HeldRecordWait, readRows } from "./db";
import { sqliteCode, sqliteMissingColumn } from "./db-error";
import { readingRecord } from "./db-read";
import { errorDetail } from "./error-read";
import { dbPath } from "./paths";
import { cellOf } from "./query";
import type { Cell, Rows } from "./query-contract";
import { capResult, rowsOf, rowsToRead } from "./query-row-cap";
import { refuseSql } from "./sql-contract";

const SQL_DENOMINATOR = "the rows the statement returned, in the order SQLite returned them";

const NameRow = z.strictObject({ name: z.string() });

const WORD = /[A-Za-z_][A-Za-z0-9_]*/g;

function namedTables(db: Database, statement: string): readonly string[] {
  const schemaNames = new Map(
    readRows(db, "SELECT name FROM sqlite_schema WHERE type IN ('table', 'view')")
      .all(NameRow)
      .map(({ name }) => [name.toLowerCase(), name]),
  );
  const named = (statement.match(WORD) ?? []).map((word) => schemaNames.get(word.toLowerCase()));
  return [...new Set(named.filter((name) => name !== undefined))];
}

function columnsOf(db: Database, tables: readonly string[]): Record<string, readonly string[]> {
  const query = readRows<[string]>(
    db,
    "SELECT name FROM pragma_table_xinfo(?) WHERE hidden <> 1 ORDER BY cid",
  );
  return Object.fromEntries(
    tables.map((table) => [table, query.all(NameRow, table).map(({ name }) => name)]),
  );
}

function refusalOf(db: Database, error: unknown, statement: string): unknown {
  const column = sqliteMissingColumn(error);
  if (column !== null) {
    const tables = namedTables(db, statement);
    if (tables.length > 0)
      return refuseSql("sql_unknown_column", { statement, column, columns: columnsOf(db, tables) }, error);
  }
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

function readStatement(db: Database, statement: string, maxRows: number): Rows {
  try {
    const read = readRows(db, statement);
    const { columns } = read;
    const repeated = columns.find((column, at) => columns.indexOf(column) !== at);
    if (repeated !== undefined) throw refuseSql("sql_columns_repeated", { statement, column: repeated });
    const toRead = rowsToRead(maxRows);
    const rows: Cell[][] = [];
    for (const row of read.iterate(AnyRow)) {
      rows.push(columns.map((column) => sqlCellOf(statement, column, row[column])));
      if (rows.length === toRead) break;
    }
    return { columns, rows };
  } catch (error) {
    throw refusalOf(db, error, statement);
  }
}

function answer(path: string, wait: HeldRecordWait, statement: string, maxRows: number): CommandResult {
  return readingRecord(path, wait, (db) => {
    const { columns, rows } = readStatement(db, statement, maxRows);
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
  run(args, runtime) {
    const { arg: statement, flags } = parseArg(args, ["rows"], sqlCommand.usage);
    const maxRows = rowsOf(flags.rows);
    return answer(dbPath(runtime.env), runtime, statement, maxRows);
  },
};
