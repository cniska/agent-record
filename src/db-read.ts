import { Database, SQLiteError } from "bun:sqlite";
import { existsSync } from "node:fs";
import { isFresh, refuseOtherVersion } from "./db";
import { refuseRecord } from "./db-contract";

export function readingRecord<T>(path: string, use: (db: Database) => T): T {
  if (!existsSync(path)) throw refuseRecord("no_database", { path });
  try {
    const db = new Database(path, { readwrite: true, create: false });
    try {
      db.run("PRAGMA query_only = ON");
      if (isFresh(db)) throw refuseRecord("no_database", { path });
      refuseOtherVersion(db);
      return use(db);
    } finally {
      db.close();
    }
  } catch (error) {
    if (error instanceof SQLiteError && error.code?.startsWith("SQLITE_BUSY"))
      throw refuseRecord("record_busy", { path }, error);
    throw error;
  }
}
