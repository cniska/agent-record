import { SQLiteError } from "bun:sqlite";

export function errorCode(error: unknown): unknown {
  return error instanceof Error && "code" in error ? error.code : undefined;
}

export function sqliteCodeOf(error: unknown): string | null {
  if (!(error instanceof SQLiteError)) return null;
  return error.code ?? null;
}
