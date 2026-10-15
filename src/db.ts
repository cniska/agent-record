import { Database, type DatabaseOptions } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { invariant, unreachable } from "./assert";
import { refuseRecord } from "./db-contract";
import { sqliteCode } from "./db-error";
import { SCHEMA_SQL, SCHEMA_VERSION } from "./db-schema";
import { nextBackupPath } from "./file-backup";

export function recordVersion(db: Database): number {
  const row = db.query<{ user_version: number }, []>("PRAGMA user_version").get();
  invariant(row !== null, "PRAGMA user_version returns one row");
  return row.user_version;
}

function holdsNoTables(db: Database): boolean {
  return db.query<{ n: number }, []>("SELECT count(*) AS n FROM sqlite_master").get()?.n === 0;
}

export function isFresh(db: Database): boolean {
  return recordVersion(db) === 0 && holdsNoTables(db);
}

export function refuseOtherVersion(db: Database): void {
  const found = recordVersion(db);
  if (found !== SCHEMA_VERSION) throw refuseRecord("record_version", { found, expected: SCHEMA_VERSION });
}

function failNowIfUnopenable(db: Database): void {
  recordVersion(db);
}

export type HeldRecordWait = { readonly heldRecordWaitMs: number };

const UNOPENABLE_CODES = ["SQLITE_CANTOPEN", "SQLITE_NOTADB"] as const;

export function openRecordFile(
  path: string,
  { heldRecordWaitMs, ...options }: DatabaseOptions & HeldRecordWait,
): Database {
  let db: Database | null = null;
  try {
    db = new Database(path, options);
    db.run(`PRAGMA busy_timeout = ${heldRecordWaitMs}`);
    failNowIfUnopenable(db);
    return db;
  } catch (error) {
    db?.close();
    const code = sqliteCode(error);
    if (UNOPENABLE_CODES.some((unopenable) => code?.startsWith(unopenable)))
      throw refuseRecord("record_unopenable", { path }, error);
    throw error;
  }
}

type Admits = "current" | "older" | "any";

export type RecordOpening = HeldRecordWait & { readonly admits?: Admits };

type OpenedRecord = { readonly db: Database; readonly older: number | null };

function refusesVersion(admits: Admits, found: number): boolean {
  switch (admits) {
    case "current":
      return found !== SCHEMA_VERSION;
    case "older":
      return found > SCHEMA_VERSION;
    case "any":
      return false;
    default:
      return unreachable(admits);
  }
}

function openRecord(path: string, opts: RecordOpening): OpenedRecord {
  const admits = opts.admits ?? "current";
  mkdirSync(dirname(path), { recursive: true });
  const db = openRecordFile(path, {
    create: true,
    heldRecordWaitMs: opts.heldRecordWaitMs,
  });
  try {
    const found = recordVersion(db);
    const fresh = found === 0 && holdsNoTables(db);
    if (!fresh && refusesVersion(admits, found))
      throw refuseRecord("record_version", { found, expected: SCHEMA_VERSION });
    const older = !fresh && found < SCHEMA_VERSION ? found : null;
    db.run("PRAGMA journal_mode = WAL");
    db.run("PRAGMA foreign_keys = ON");
    if (fresh) {
      writeTransaction(db, () => {
        if (!isFresh(db)) return;
        db.run(SCHEMA_SQL);
        db.run(`PRAGMA user_version = ${SCHEMA_VERSION}`);
      });
    }
    if (admits === "any" || older !== null) return { db, older };
    refuseOtherVersion(db);
    db.run(SCHEMA_SQL);
    return { db, older };
  } catch (error) {
    db.close();
    throw error;
  }
}

export function openDb(path: string, opts: RecordOpening): Database {
  return openRecord(path, opts).db;
}

export function backUpRecord(db: Database): string {
  const backup = nextBackupPath(db.filename);
  db.run("VACUUM INTO ?", [backup]);
  return backup;
}

export function writeTransaction<T>(db: Database, fn: () => T): T {
  return db.transaction(fn).immediate();
}

export function refusingBusy<T>(path: string, run: () => T): T {
  try {
    return run();
  } catch (error) {
    if (sqliteCode(error)?.startsWith("SQLITE_BUSY")) throw refuseRecord("record_busy", { path }, error);
    throw error;
  }
}

export function withDb<T>(
  path: string,
  opts: RecordOpening,
  use: (db: Database, older: number | null) => T,
): T {
  return refusingBusy(path, () => {
    const { db, older } = openRecord(path, opts);
    try {
      return use(db, older);
    } finally {
      db.close();
    }
  });
}
