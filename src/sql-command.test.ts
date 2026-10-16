import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  fingerprint,
  recordWithCommit,
  refusal,
  stampSchemaVersion,
  testRuntime,
} from "./db-read.test-support";
import { SCHEMA_VERSION } from "./db-schema";
import { scratchEnv } from "./fixtures.test-support";
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
  test("refuses every write as one, and leaves the database as it was", () => {
    const { home, env, path } = recordWithCommit();
    try {
      const before = fingerprint(path);
      for (const statement of WRITES) {
        const refused = refusal(() => sqlCommand.run([statement], testRuntime(env)));
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

  test("refuses a statement SQLite cannot run, naming SQLite's complaint", () => {
    const { home, env } = recordWithCommit();
    try {
      expect(refusal(() => sqlCommand.run(["SELEC 1"], testRuntime(env)))).toEqual(
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

  test("refuses an unknown column by listing the columns of each table the statement names", () => {
    const { home, env } = recordWithCommit();
    const repoCommit = ["sha", "repo", "label", "ts", "author", "subject", "kind"];
    const cases = [
      { statement: "SELECT shaa FROM repo_commit", column: "shaa", columns: { repo_commit: repoCommit } },
      {
        statement: 'SELECT c.sha, f.nope FROM "Repo_Commit" c JOIN [commit_file] f ON f.sha = c.sha',
        column: "f.nope",
        columns: { repo_commit: repoCommit, commit_file: ["sha", "path"] },
      },
      {
        statement: "WITH recent AS (SELECT sha FROM repo_commit) SELECT subject FROM recent",
        column: "subject",
        columns: { repo_commit: repoCommit },
      },
      {
        statement: "SELECT nope FROM main.commit_file",
        column: "nope",
        columns: { commit_file: ["sha", "path"] },
      },
    ];
    try {
      for (const { statement, column, columns } of cases) {
        expect(refusal(() => sqlCommand.run([statement], testRuntime(env)))).toEqual(
          expect.objectContaining({
            kind: "refusal",
            code: "sql_unknown_column",
            message: `${JSON.stringify(statement)} names the column ${column}, which SQLite cannot find`,
            meta: { statement, column, columns },
          }),
        );
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("names each table's columns in the fix, generated columns included", () => {
    const { home, env } = recordWithCommit();
    try {
      expect(refusal(() => sqlCommand.run(["SELECT nope FROM commit_file"], testRuntime(env)))).toMatchObject(
        {
          resolve: "use a column of the tables it names: commit_file (sha, path)",
        },
      );
      expect(refusal(() => sqlCommand.run(["SELECT nope FROM skill_load"], testRuntime(env)))).toMatchObject({
        code: "sql_unknown_column",
        meta: { columns: { skill_load: expect.arrayContaining(["skill_name", "anchor_id"]) } },
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("refuses an unknown column with SQLite's reason when the statement names no table", () => {
    const { home, env } = recordWithCommit();
    const statement = "WITH n(i) AS (SELECT 1) SELECT j FROM n";
    try {
      expect(refusal(() => sqlCommand.run([statement], testRuntime(env)))).toEqual(
        expect.objectContaining({
          kind: "refusal",
          code: "sql_invalid",
          meta: { statement, detail: "no such column: j" },
          resolve: "fix the statement and run it again",
        }),
      );
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("prints columns and rows like a query", () => {
    const { home, env } = recordWithCommit();
    try {
      const { value } = sqlCommand.run(["SELECT sha FROM repo_commit"], testRuntime(env));
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

  test("keeps the columns of a statement that matched nothing", () => {
    const { home, env } = recordWithCommit();
    try {
      const { value } = sqlCommand.run(
        ["SELECT sha, subject FROM repo_commit WHERE sha = 'none'"],
        testRuntime(env),
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

  test("refuses a result that names a column twice, naming it", () => {
    const { home, env } = recordWithCommit();
    const statement = "SELECT sha, subject AS sha FROM repo_commit";
    try {
      expect(refusal(() => sqlCommand.run([statement], testRuntime(env)))).toEqual(
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

  test("refuses a blob, naming hex() as the way to read it", () => {
    const { home, env } = recordWithCommit();
    const statement = "SELECT sha, randomblob(4) AS salt FROM repo_commit";
    try {
      expect(refusal(() => sqlCommand.run([statement], testRuntime(env)))).toEqual(
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

  test("refuses a read while a writer holds the record, naming it busy", () => {
    const { home, env, path } = recordWithCommit();
    const writer = new Database(path);
    try {
      writer.run("PRAGMA locking_mode = EXCLUSIVE");
      writer.run("DELETE FROM repo_commit");
      expect(refusal(() => sqlCommand.run(["SELECT 1"], testRuntime(env)))).toEqual(
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

  test("reads one row past the cap and no further", () => {
    const { home, env } = recordWithCommit();
    try {
      const failsAtRow50 = `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 100)
        SELECT CASE WHEN i = 50 THEN abs(-9223372036854775808) ELSE i END AS i FROM n`;
      const { value: result } = sqlCommand.run([failsAtRow50], testRuntime(env));
      expect(result).toMatchObject({ more: "more rows than 40; --rows <n> to widen" });
      expect(result).toHaveProperty("rows.length", 40);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  for (const version of [SCHEMA_VERSION - 1, SCHEMA_VERSION + 1]) {
    test(`refuses a record of version ${version > SCHEMA_VERSION ? "newer" : "older"} than this one before any statement, leaving it as it was`, () => {
      const { home, env, path } = recordWithCommit();
      try {
        stampSchemaVersion(path, version);
        const before = fingerprint(path);
        expect(refusal(() => sqlCommand.run(["SELECT 1"], testRuntime(env)))).toEqual(
          expect.objectContaining({ code: "record_version" }),
        );
        expect(fingerprint(path)).toBe(before);
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    });
  }

  test("creates no database where there is none", () => {
    const empty = mkdtempSync(join(tmpdir(), "agent-record-db-read-"));
    try {
      expect(refusal(() => sqlCommand.run(["SELECT 1"], testRuntime(scratchEnv(empty))))).toMatchObject({
        code: "no_database",
      });
      expect(existsSync(dbPath(scratchEnv(empty)))).toBe(false);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});
