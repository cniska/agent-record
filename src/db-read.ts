import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { refuseOtherVersion } from "./db";
import { refuseRecord } from "./db-contract";

export function openReadOnly(path: string): Database {
  if (!existsSync(path)) throw refuseRecord("no_database", { path });
  const db = new Database(path, { readwrite: true, create: false });
  try {
    db.run("PRAGMA query_only = ON");
    refuseOtherVersion(db);
  } catch (error) {
    db.close();
    throw error;
  }
  return db;
}
