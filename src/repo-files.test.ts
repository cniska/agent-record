import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SCHEMA_SQL } from "./db-schema";
import { errorCode } from "./error-read";
import { probeCheckout } from "./git-probe";
import { indexRepoFiles, trackedFiles } from "./repo-files";

function repoWith(files: string[]): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "agent-record-files-")));
  execFileSync("git", ["init", "-q", "-b", "main", dir]);
  execFileSync("git", ["-C", dir, "config", "user.email", "t@example.com"]);
  execFileSync("git", ["-C", dir, "config", "user.name", "T"]);
  execFileSync("git", ["-C", dir, "config", "maintenance.auto", "false"]);
  writeFileSync(join(dir, ".gitignore"), "dist/\n");
  for (const f of files) {
    mkdirSync(join(dir, f, ".."), { recursive: true });
    writeFileSync(join(dir, f), "x");
  }
  execFileSync("git", ["-C", dir, "add", "-A"]);
  execFileSync("git", ["-C", dir, "commit", "--no-verify", "-q", "-m", "feat: the first commit"]);
  return dir;
}

function freshDb(): Database {
  const db = new Database(":memory:");
  db.run(SCHEMA_SQL);
  return db;
}

const failures: { path: string; code: unknown }[] = [];
const fail = (path: string, error: unknown) => failures.push({ path, code: errorCode(error) });

const index = (db: Database, repo: string) => indexRepoFiles(db, [probeCheckout(repo)], fail);

const pathsIn = (db: Database, repo: string): string[] =>
  db
    .prepare<{ path: string }, []>("SELECT path FROM repo_file ORDER BY path")
    .all()
    .map((r) => r.path.replace(`${repo}/`, ""));

describe("indexing what a repo tracks", () => {
  test("records tracked files and leaves ignored ones out", () => {
    const repo = repoWith([".github/workflows/ci.yml", "src/cli.ts"]);
    try {
      mkdirSync(join(repo, "dist"), { recursive: true });
      writeFileSync(join(repo, "dist", "cli.js"), "x");
      expect(trackedFiles(repo).some((p) => p.endsWith("dist/cli.js"))).toBe(false);

      const db = freshDb();
      expect(index(db, repo)).toEqual({ repos: 1, files: 3, unchanged: 0 });
      expect(pathsIn(db, repo)).toEqual([".github/workflows/ci.yml", ".gitignore", "src/cli.ts"]);
      expect(index(db, repo)).toEqual({ repos: 0, files: 0, unchanged: 1 });
      db.close();
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("drops a file the repo no longer tracks", () => {
    const repo = repoWith(["keep.ts", "gone.ts"]);
    try {
      const db = freshDb();
      index(db, repo);
      expect(pathsIn(db, repo)).toContain("gone.ts");

      execFileSync("git", ["-C", repo, "rm", "-q", "gone.ts"]);
      execFileSync("git", ["-C", repo, "commit", "--no-verify", "-q", "-m", "chore: drop it"]);
      index(db, repo);
      expect(pathsIn(db, repo)).not.toContain("gone.ts");
      expect(pathsIn(db, repo)).toContain("keep.ts");

      execFileSync("git", ["-C", repo, "rm", "-q", "-r", "."]);
      index(db, repo);
      expect(pathsIn(db, repo)).toEqual([]);
      db.close();
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("reports a repo git cannot read and still indexes the others", () => {
    const repo = repoWith(["a.ts"]);
    const corrupt = repoWith(["b.ts"]);
    const probedBeforeCorrupt = probeCheckout(corrupt);
    writeFileSync(join(corrupt, ".git", "index"), "not an index");
    failures.length = 0;
    try {
      const db = freshDb();
      expect(indexRepoFiles(db, [probedBeforeCorrupt, probeCheckout(repo)], fail)).toEqual({
        repos: 1,
        files: 2,
        unchanged: 0,
      });
      expect(failures).toEqual([{ path: corrupt, code: "git_failed" }]);
      db.close();
    } finally {
      rmSync(repo, { recursive: true, force: true });
      rmSync(corrupt, { recursive: true, force: true });
    }
  });

  test("skips a checkout removed after it was probed, keeping the files it indexed before", () => {
    const repo = repoWith(["a.ts"]);
    const gone = repoWith(["b.ts"]);
    failures.length = 0;
    try {
      const db = freshDb();
      index(db, gone);
      const probedBeforeGone = probeCheckout(gone);
      writeFileSync(join(gone, "c.ts"), "x");
      execFileSync("git", ["-C", gone, "add", "c.ts"]);
      const probedAfterAdd = probeCheckout(gone);
      expect(probedAfterAdd.indexStat).not.toBe(probedBeforeGone.indexStat);
      rmSync(gone, { recursive: true, force: true });
      expect(existsSync(gone)).toBe(false);
      expect(indexRepoFiles(db, [probedAfterAdd, probeCheckout(repo)], fail)).toEqual({
        repos: 1,
        files: 2,
        unchanged: 0,
      });
      expect(failures).toEqual([]);
      expect(pathsIn(db, gone).filter((path) => !path.startsWith("/"))).toEqual([".gitignore", "b.ts"]);
      db.close();
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
