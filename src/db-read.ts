import { type Database, SQLiteError } from "bun:sqlite";
import { existsSync } from "node:fs";
import { isFresh, openRecordFile, refuseOtherVersion } from "./db";
import { refuseRecord } from "./db-contract";

const READERS_DO_NOT_WAIT_MS = 0;

export function readingRecord<T>(path: string, use: (db: Database) => T): T {
  if (!existsSync(path)) throw refuseRecord("no_database", { path });
  try {
    const db = openRecordFile(path, {
      readwrite: true,
      create: false,
      busyTimeoutMs: READERS_DO_NOT_WAIT_MS,
    });
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
