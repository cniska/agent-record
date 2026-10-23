import { Database, type DatabaseOptions, type SQLQueryBindings } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import { invariant, unreachable } from "./assert";
import { faultRecord, refuseRecord } from "./db-contract";
import { sqliteBusy, sqliteCode } from "./db-error";
import { SCHEMA_SQL, SCHEMA_VERSION } from "./db-schema";
import { issuesOf } from "./error-read";
import { nextBackupPath } from "./file-backup";

export type RowRead<Params extends SQLQueryBindings[]> = {
  readonly columns: readonly string[];
  readonly get: <Row>(schema: z.ZodType<Row>, ...params: Params) => Row | null;
  readonly all: <Row>(schema: z.ZodType<Row>, ...params: Params) => Row[];
  readonly iterate: <Row>(schema: z.ZodType<Row>, ...params: Params) => Generator<Row>;
  readonly values: <Row>(schema: z.ZodType<Row>, ...params: Params) => Row[];
};

export const SqlFlag = z.union([z.literal(0), z.literal(1)]).transform((flag) => flag === 1);

export function readRows<Params extends SQLQueryBindings[] = []>(db: Database, sql: string): RowRead<Params> {
  const statement = db.query<unknown, SQLQueryBindings[]>(sql);
  const parse = <Row>(schema: z.ZodType<Row>, row: unknown): Row => {
    const parsed = schema.safeParse(row);
    if (!parsed.success) throw faultRecord("row_mismatch", { sql, detail: issuesOf(parsed.error) });
    return parsed.data;
  };
  return {
    columns: statement.columnNames,
    get: (schema, ...params) => {
      const row = statement.get(...params);
      return row === null ? null : parse(schema, row);
    },
    all: (schema, ...params) => parse(z.array(schema), statement.all(...params)),
    iterate: function* (schema, ...params) {
      for (const row of statement.iterate(...params)) yield parse(schema, row);
    },
    values: (schema, ...params) => parse(z.array(schema), statement.values(...params)),
  };
}

const UserVersion = z.strictObject({ user_version: z.number() });

export function recordVersion(db: Database): number {
  const row = readRows(db, "PRAGMA user_version").get(UserVersion);
  invariant(row !== null, "PRAGMA user_version returns one row");
  return row.user_version;
}

export const Count = z.strictObject({ n: z.number() });

export const AnyRow = z.record(z.string(), z.unknown());

export const Exists = z.strictObject({ one: z.literal(1) });

const VersionAndTables = z.strictObject({ version: z.number(), tables: z.number() });

const VERSION_AND_TABLES_SQL =
  "SELECT (SELECT user_version FROM pragma_user_version) AS version, (SELECT count(*) FROM sqlite_master) AS tables";

export function versionAndFreshnessInOneSnapshot(db: Database): {
  readonly found: number;
  readonly fresh: boolean;
} {
  const row = readRows(db, VERSION_AND_TABLES_SQL).get(VersionAndTables);
  invariant(row !== null, "the version and table count select returns one row");
  return { found: row.version, fresh: row.version === 0 && row.tables === 0 };
}

export function refuseOtherVersion(found: number): void {
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

const WAL_RETRY_MS = 5;

function enableWalRetryingBusy(db: Database, heldRecordWaitMs: number): void {
  const deadline = Date.now() + heldRecordWaitMs;
  for (;;) {
    try {
      db.run("PRAGMA journal_mode = WAL");
      return;
    } catch (error) {
      if (!sqliteBusy(error) || Date.now() >= deadline) throw error;
      Bun.sleepSync(WAL_RETRY_MS);
    }
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
    const { found, fresh } = versionAndFreshnessInOneSnapshot(db);
    if (!fresh && refusesVersion(admits, found))
      throw refuseRecord("record_version", { found, expected: SCHEMA_VERSION });
    const older = !fresh && found < SCHEMA_VERSION ? found : null;
    enableWalRetryingBusy(db, opts.heldRecordWaitMs);
    db.run("PRAGMA foreign_keys = ON");
    if (fresh) {
      writeTransaction(db, () => {
        if (!versionAndFreshnessInOneSnapshot(db).fresh) return;
        db.run(SCHEMA_SQL);
        db.run(`PRAGMA user_version = ${SCHEMA_VERSION}`);
      });
    }
    if (admits === "any" || older !== null) return { db, older };
    refuseOtherVersion(versionAndFreshnessInOneSnapshot(db).found);
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
    if (sqliteBusy(error)) throw refuseRecord("record_busy", { path }, error);
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
