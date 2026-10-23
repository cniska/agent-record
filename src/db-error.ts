import { SQLiteError } from "bun:sqlite";

const MISSING_COLUMN = "no such column: ";

export function sqliteCode(error: unknown): string | null {
  if (!(error instanceof SQLiteError)) return null;
  return error.code ?? null;
}

export function sqliteBusy(error: unknown): boolean {
  return sqliteCode(error)?.startsWith("SQLITE_BUSY") ?? false;
}

export function sqliteMissingColumn(error: unknown): string | null {
  if (!(error instanceof SQLiteError) || error.code !== "SQLITE_ERROR") return null;
  if (!error.message.startsWith(MISSING_COLUMN)) return null;
  return error.message.slice(MISSING_COLUMN.length);
}
