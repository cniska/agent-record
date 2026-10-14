import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  asDataHome,
  fingerprint,
  NO_WAIT,
  recordWithCommit,
  refusal,
  stampSchemaVersion,
} from "./db-read.test-support";
import { SCHEMA_VERSION } from "./db-schema";
import { dbPath } from "./paths";
import { sqlCommand } from "./sql-command";

const WRITES = [
  "INSERT INTO repo_commit (sha, repo, label, ts, subject) VALUES ('def456', '/repo', 'x', '2026-01-01T00:00:00Z', 'x')",
  "UPDATE repo_commit SET subject = 'changed'",
  "DELETE FROM repo_commit",
  "CREATE TABLE note (body TEXT)",
  "DROP TABLE repo_file",
  "PRAGMA user_version = 7",
  "VACUUM",
  "REINDEX",
  "ANALYZE",
];

describe("agent-record sql", () => {
  test("refuses every write as one, and leaves the database as it was", async () => {
    const { home, path } = recordWithCommit();
    try {
      const before = fingerprint(path);
      for (const statement of WRITES) {
        const refused = await asDataHome(home, () => refusal(() => sqlCommand.run([statement], NO_WAIT)));
        expect({ statement, refused }).toEqual({
          statement,
          refused: expect.objectContaining({
            kind: "refusal",
            code: "sql_writes",
            meta: { statement },
            resolve: "run a read-only SELECT",
          }),
        });
        expect(fingerprint(path)).toBe(before);
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("refuses a statement SQLite cannot run, naming SQLite's complaint", async () => {
    const { home } = recordWithCommit();
    try {
      expect(await asDataHome(home, () => refusal(() => sqlCommand.run(["SELEC 1"], NO_WAIT)))).toEqual(
        expect.objectContaining({
          kind: "refusal",
          code: "sql_invalid",
          meta: { statement: "SELEC 1", detail: 'near "SELEC": syntax error' },
          resolve: "fix the statement and run it again",
        }),
      );
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("prints columns and rows like a query", async () => {
    const { home } = recordWithCommit();
    try {
      const { value } = await asDataHome(home, () =>
        sqlCommand.run(["SELECT sha FROM repo_commit"], NO_WAIT),
      );
      expect(value).toEqual({
        denominator: "the rows the statement returned, in the order SQLite returned them",
        columns: ["sha"],
        rows: [["abc123"]],
        more: null,
        note: null,
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("keeps the columns of a statement that matched nothing", async () => {
    const { home } = recordWithCommit();
    try {
      const { value } = await asDataHome(home, () =>
        sqlCommand.run(["SELECT sha, subject FROM repo_commit WHERE sha = 'none'"], NO_WAIT),
      );
      expect(value).toEqual({
        denominator: "the rows the statement returned, in the order SQLite returned them",
        columns: ["sha", "subject"],
        rows: [],
        more: null,
        note: "the statement ran and matched nothing",
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("refuses a result that names a column twice, naming it", async () => {
    const { home } = recordWithCommit();
    const statement = "SELECT sha, subject AS sha FROM repo_commit";
    try {
      expect(await asDataHome(home, () => refusal(() => sqlCommand.run([statement], NO_WAIT)))).toEqual(
        expect.objectContaining({
          kind: "refusal",
          code: "sql_columns_repeated",
          meta: { statement, column: "sha" },
          resolve: "name each column once, with AS",
        }),
      );
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("refuses a blob, naming hex() as the way to read it", async () => {
    const { home } = recordWithCommit();
    const statement = "SELECT sha, randomblob(4) AS salt FROM repo_commit";
    try {
      expect(await asDataHome(home, () => refusal(() => sqlCommand.run([statement], NO_WAIT)))).toEqual(
        expect.objectContaining({
          kind: "refusal",
          code: "sql_blob",
          meta: { statement, column: "salt" },
          resolve: "select hex(salt) instead",
        }),
      );
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("refuses a read while a writer holds the record, naming it busy", async () => {
    const { home, path } = recordWithCommit();
    const writer = new Database(path);
    try {
      writer.run("PRAGMA locking_mode = EXCLUSIVE");
      writer.run("DELETE FROM repo_commit");
      expect(await asDataHome(home, () => refusal(() => sqlCommand.run(["SELECT 1"], NO_WAIT)))).toEqual(
        expect.objectContaining({
          kind: "refusal",
          code: "record_busy",
          meta: { path },
          message: `another process holds ${path}, or SQLite is recovering it after a crash`,
          resolve: "run this again; if it keeps failing, close whatever holds the file",
        }),
      );
    } finally {
      writer.close();
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("reads one row past the cap and no further", async () => {
    const { home } = recordWithCommit();
    try {
      const failsAtRow50 = `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 100)
        SELECT CASE WHEN i = 50 THEN abs(-9223372036854775808) ELSE i END AS i FROM n`;
      const { value: result } = await asDataHome(home, () => sqlCommand.run([failsAtRow50], NO_WAIT));
      expect(result).toMatchObject({ more: "more rows than 40; --rows <n> to widen" });
      expect(result).toHaveProperty("rows.length", 40);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  for (const version of [SCHEMA_VERSION - 1, SCHEMA_VERSION + 1]) {
    test(`refuses a record of version ${version > SCHEMA_VERSION ? "newer" : "older"} than this one before any statement, leaving it as it was`, async () => {
      const { home, path } = recordWithCommit();
      try {
        stampSchemaVersion(path, version);
        const before = fingerprint(path);
        expect(await asDataHome(home, () => refusal(() => sqlCommand.run(["SELECT 1"], NO_WAIT)))).toEqual(
          expect.objectContaining({ code: "record_version" }),
        );
        expect(fingerprint(path)).toBe(before);
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    });
  }

  test("creates no database where there is none", async () => {
    const empty = mkdtempSync(join(tmpdir(), "agent-record-db-read-"));
    try {
      expect(
        await asDataHome(empty, () => refusal(() => sqlCommand.run(["SELECT 1"], NO_WAIT))),
      ).toMatchObject({
        code: "no_database",
      });
      expect(existsSync(dbPath({ XDG_DATA_HOME: empty }))).toBe(false);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});
