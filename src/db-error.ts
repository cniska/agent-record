import { SQLiteError } from "bun:sqlite";

export function sqliteCode(error: unknown): string | null {
  if (!(error instanceof SQLiteError)) return null;
  return error.code ?? null;
}
