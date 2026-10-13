import { Database, type DatabaseOptions } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { invariant } from "./assert";
import { refuseRecord } from "./db-contract";
import { SCHEMA_SQL, SCHEMA_VERSION } from "./db-schema";
import { sqliteCodeOf } from "./error-code";

export function recordVersion(db: Database): number {
  const row = db.query<{ user_version: number }, []>("PRAGMA user_version").get();
  invariant(row !== null, "PRAGMA user_version returns one row");
  return row.user_version;
}

export function isFresh(db: Database): boolean {
  return (
    recordVersion(db) === 0 &&
    db.query<{ n: number }, []>("SELECT count(*) AS n FROM sqlite_master").get()?.n === 0
  );
}

export function refuseOtherVersion(db: Database): void {
  const found = recordVersion(db);
  if (found !== SCHEMA_VERSION) throw refuseRecord("record_version", { found, expected: SCHEMA_VERSION });
}

function failNowIfUnopenable(db: Database): void {
  recordVersion(db);
}

const UNOPENABLE_CODES = ["SQLITE_CANTOPEN", "SQLITE_NOTADB"] as const;

export function openRecordFile(
  path: string,
  { busyTimeoutMs, ...options }: DatabaseOptions & { readonly busyTimeoutMs: number },
): Database {
  let db: Database | null = null;
  try {
    db = new Database(path, options);
    db.run(`PRAGMA busy_timeout = ${busyTimeoutMs}`);
    failNowIfUnopenable(db);
    return db;
  } catch (error) {
    db?.close();
    const code = sqliteCodeOf(error);
    if (UNOPENABLE_CODES.some((unopenable) => code?.startsWith(unopenable)))
      throw refuseRecord("record_unopenable", { path }, error);
    throw error;
  }
}

const CONCURRENT_WRITER_WAIT_MS = 5000;

export function openDb(path: string, opts: { forRebuild?: boolean; busyTimeoutMs?: number } = {}): Database {
  mkdirSync(dirname(path), { recursive: true });
  const db = openRecordFile(path, {
    create: true,
    busyTimeoutMs: opts.busyTimeoutMs ?? CONCURRENT_WRITER_WAIT_MS,
  });
  try {
    const fresh = isFresh(db);
    if (!fresh && !opts.forRebuild) refuseOtherVersion(db);
    db.run("PRAGMA journal_mode = WAL");
    db.run("PRAGMA foreign_keys = ON");
    if (fresh) {
      writeTransaction(db, () => {
        if (!isFresh(db)) return;
        db.run(SCHEMA_SQL);
        db.run(`PRAGMA user_version = ${SCHEMA_VERSION}`);
      });
    }
    if (opts.forRebuild) return db;
    refuseOtherVersion(db);
    db.run(SCHEMA_SQL);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

export function writeTransaction<T>(db: Database, fn: () => T): T {
  return db.transaction(fn).immediate();
}

export function withDb<T>(path: string, use: (db: Database) => T, opts: { forRebuild?: boolean } = {}): T {
  const db = openDb(path, opts);
  try {
    return use(db);
  } finally {
    db.close();
  }
}
