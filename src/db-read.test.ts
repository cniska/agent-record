import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openReadOnly } from "./db-read";
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

    const db = openReadOnly(path);
    try {
      expect(db.query("SELECT body FROM note").all()).toEqual([{ body: "kept" }]);
    } finally {
      db.close();
    }
  });

  test("refuses a write", () => {
    const db = openReadOnly(writtenDatabase());
    try {
      expect(() => db.run("INSERT INTO note VALUES ('changed')")).toThrow(
        expect.objectContaining({ code: "SQLITE_READONLY" }),
      );
    } finally {
      db.close();
    }
  });

  test("names a missing database without creating one", () => {
    const path = join(mkdtempSync(join(tmpdir(), "agent-record-db-read-")), "sessions.db");

    expect(() => openReadOnly(path)).toThrow(expect.objectContaining({ code: "no_database" }));
    expect(existsSync(path)).toBe(false);
  });
});
