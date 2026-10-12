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
import { errorCode } from "./error-code";
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
  test("fails on every write and leaves the database as it was", async () => {
    const { home, path } = recordWithCommit();
    try {
      const before = fingerprint(path);
      for (const statement of WRITES) {
        const refused = await asDataHome(home, async () => {
          try {
            await sqlCommand.run([statement]);
            return null;
          } catch (error) {
            return errorCode(error);
          }
        });
        expect({ statement, refused }).toEqual({ statement, refused: "SQLITE_READONLY" });
        expect(fingerprint(path)).toBe(before);
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("reads one row past the cap and no further", async () => {
    const { home } = recordWithCommit();
    try {
      const failsAtRow50 = `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 100)
        SELECT CASE WHEN i = 50 THEN abs(-9223372036854775808) ELSE i END AS i FROM n`;
      const { value: result } = await asDataHome(home, () => sqlCommand.run([failsAtRow50]));
      expect(result).toMatchObject({
        denominator: "more than 40 rows",
        more: "more rows than 40; --rows <n> to widen",
      });
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
        expect(await asDataHome(home, () => refusal(() => sqlCommand.run(["SELECT 1"])))).toEqual(
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
      expect(await asDataHome(empty, () => refusal(() => sqlCommand.run(["SELECT 1"])))).toMatchObject({
        code: "no_database",
      });
      expect(existsSync(dbPath({ XDG_DATA_HOME: empty }))).toBe(false);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});
