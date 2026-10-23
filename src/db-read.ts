import type { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import {
  type HeldRecordWait,
  openRecordFile,
  refuseOtherVersion,
  refusingBusy,
  versionAndFreshnessInOneSnapshot,
} from "./db";
import { refuseRecord } from "./db-contract";

export function readingRecord<T>(
  path: string,
  { heldRecordWaitMs }: HeldRecordWait,
  use: (db: Database) => T,
): T {
  if (!existsSync(path)) throw refuseRecord("no_database", { path });
  return refusingBusy(path, () => {
    const db = openRecordFile(path, { readwrite: true, create: false, heldRecordWaitMs });
    try {
      db.run("PRAGMA query_only = ON");
      const { found, fresh } = versionAndFreshnessInOneSnapshot(db);
      if (fresh) throw refuseRecord("no_database", { path });
      refuseOtherVersion(found);
      return use(db);
    } finally {
      db.close();
    }
  });
}
