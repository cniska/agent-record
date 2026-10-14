import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  asDataHome,
  fingerprint,
  recordWithCommit,
  refusal,
  stampSchemaVersion,
} from "./db-read.test-support";
import { SCHEMA_VERSION } from "./db-schema";
import { dbPath } from "./paths";
import { queryCommand } from "./query-command";
import { QUERIES } from "./query-registry";

function recordOf(path: string): unknown {
  const db = new Database(path);
  try {
    const tables = db
      .query<{ name: string; sql: string }, []>(
        "SELECT name, sql FROM sqlite_master WHERE type = 'table' ORDER BY name",
      )
      .all();
    return {
      userVersion: db.query("PRAGMA user_version").get(),
      tables: tables.map(({ name, sql }) => ({ sql, rows: db.query(`SELECT * FROM "${name}"`).all() })),
    };
  } finally {
    db.close();
  }
}

describe("agent-record query", () => {
  test("answers every query without changing the record, and creates none", async () => {
    const { home, path } = recordWithCommit();
    const empty = mkdtempSync(join(tmpdir(), "agent-record-db-read-"));
    try {
      const before = recordOf(path);
      for (const query of QUERIES) await asDataHome(home, () => queryCommand.run([query.name, "stay"]));
      expect(recordOf(path)).toEqual(before);

      await expect(asDataHome(empty, () => queryCommand.run(["search", "stay"]))).rejects.toMatchObject({
        code: "no_database",
      });
      expect(existsSync(dbPath({ XDG_DATA_HOME: empty }))).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(empty, { recursive: true, force: true });
    }
  });

  for (const version of [SCHEMA_VERSION - 1, SCHEMA_VERSION + 1]) {
    test(`refuses a record of version ${version > SCHEMA_VERSION ? "newer" : "older"} than this one before any query, leaving it as it was`, async () => {
      const { home, path } = recordWithCommit();
      try {
        stampSchemaVersion(path, version);
        const before = fingerprint(path);
        expect(await asDataHome(home, () => refusal(() => queryCommand.run(["search", "stay"])))).toEqual(
          expect.objectContaining({ code: "record_version" }),
        );
        expect(fingerprint(path)).toBe(before);
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    });
  }

  test("names in each query's usage every flag its parse takes, --rows last", () => {
    for (const query of QUERIES) {
      for (const flag of query.flags) expect(query.usage).toContain(` [--${flag} <`);
      expect(query.usage).toEndWith(" [--rows <n>]");
    }
  });

  test("refuses a query while a writer holds the record, naming it busy", async () => {
    const { home, path } = recordWithCommit();
    const writer = new Database(path);
    try {
      writer.run("PRAGMA locking_mode = EXCLUSIVE");
      writer.run("DELETE FROM repo_commit");
      expect(await asDataHome(home, () => refusal(() => queryCommand.run(["search", "stay"])))).toEqual(
        expect.objectContaining({ kind: "refusal", code: "record_busy", meta: { path } }),
      );
    } finally {
      writer.close();
      rmSync(home, { recursive: true, force: true });
    }
  });
});
