import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readingRecord } from "./db-read";
import { SCHEMA_VERSION } from "./db-schema";

function writtenDatabase(): string {
  const path = join(mkdtempSync(join(tmpdir(), "agent-record-db-read-")), "sessions.db");
  const db = new Database(path, { create: true });
  db.run("PRAGMA journal_mode = WAL");
  db.run("CREATE TABLE note (body TEXT)");
  db.run("INSERT INTO note VALUES ('kept')");
  db.run(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  db.close();
  return path;
}

describe("opening the database to read", () => {
  test("reads a WAL database whose -wal and -shm files are gone", () => {
    const path = writtenDatabase();
    rmSync(`${path}-wal`, { force: true });
    rmSync(`${path}-shm`, { force: true });

    expect(readingRecord(path, (db) => db.query("SELECT body FROM note").all())).toEqual([{ body: "kept" }]);
  });

  test("refuses a write", () => {
    expect(() =>
      readingRecord(writtenDatabase(), (db) => db.run("INSERT INTO note VALUES ('changed')")),
    ).toThrow(expect.objectContaining({ code: "SQLITE_READONLY" }));
  });

  test("names a record the first sync has created but not yet filled as missing, not as another version", () => {
    const path = join(mkdtempSync(join(tmpdir(), "agent-record-db-read-")), "sessions.db");
    new Database(path, { create: true }).close();

    expect(() => readingRecord(path, () => null)).toThrow(expect.objectContaining({ code: "no_database" }));
  });

  test("names a missing database without creating one", () => {
    const path = join(mkdtempSync(join(tmpdir(), "agent-record-db-read-")), "sessions.db");

    expect(() => readingRecord(path, () => null)).toThrow(expect.objectContaining({ code: "no_database" }));
    expect(existsSync(path)).toBe(false);
  });
});
