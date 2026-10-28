import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { SCHEMA_SQL } from "./db-schema";
import { repoWithWorktree } from "./git-fixtures.test-support";
import { probeCheckout } from "./git-probe";
import { priorArt } from "./query-prior-art";
import { ctx, recordCommits } from "./query.test-support";
import { indexRepoFiles } from "./repo-files";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const fail = (path: string, error: unknown) => {
  throw new Error(`${path}: ${String(error)}`);
};

test("dates a file found only through a worktree by the commits of its repository", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-record-prior-art-"));
  roots.push(root);
  const { repo, worktree } = repoWithWorktree(root);
  const db = new Database(":memory:");
  try {
    db.run(SCHEMA_SQL);
    recordCommits(db, [worktree, repo], fail);
    indexRepoFiles(db, [probeCheckout(worktree)], fail);

    const result = priorArt.run(db, { ...ctx, arg: "a.ts", home: dirname(repo) });
    expect(result.columns).toEqual(["file", "where", "commits", "days_since", "authors"]);
    expect(result.rows).toEqual([["repo/a.ts", "repo", 1, 0, 1]]);

    indexRepoFiles(db, [probeCheckout(repo)], fail);
    expect(priorArt.run(db, { ...ctx, arg: "a.ts", home: dirname(repo) }).denominator).toContain(
      "in 1 of 1 checkouts indexed",
    );
  } finally {
    db.close();
  }
});

test("matches a path holding SQL wildcard characters as written", () => {
  const db = new Database(":memory:");
  try {
    db.run(SCHEMA_SQL);
    db.run("INSERT INTO repo_file (checkout, path) VALUES ('/h/r','/h/r/a_b.ts'), ('/h/r', '/h/r/aXb.ts')");

    expect(priorArt.run(db, { ...ctx, arg: "A_B", home: "/h" }).rows.map((row) => row[0])).toEqual([
      "r/a_b.ts",
    ]);
  } finally {
    db.close();
  }
});

const repo = (n: string) => `/h/code/${n}`;

test("ranks by recency, caps one repo, and folds its worktrees together", () => {
  const db = new Database(":memory:");
  try {
    db.run(SCHEMA_SQL);
    const addFile = (r: string, p: string) =>
      db.run("INSERT INTO repo_file (checkout, path) VALUES (?, ?)", [repo(r), `${repo(r)}/${p}`]);
    const addCommit = (sha: string, r: string, p: string, ts: string) => {
      db.run(
        "INSERT OR IGNORE INTO repo_commit (sha, repo, label, ts, author, subject) VALUES (?, ?, ?, ?, 'a', 's')",
        [sha, repo(r), `owner/${r}`, ts],
      );
      db.run("INSERT INTO commit_file (sha, path) VALUES (?, ?)", [sha, `${repo(r)}/${p}`]);
    };

    addFile("one", ".github/workflows/ci.yml");
    addCommit("s1", "one", ".github/workflows/ci.yml", "2026-09-10T00:00:00Z");
    addFile("one", ".claude/worktrees/wt/.github/workflows/ci.yml");
    addCommit("s2", "one", ".github/workflows/ci.yml", "2026-09-11T00:00:00Z");

    for (const n of ["a", "b", "c", "d"]) {
      addFile("two", `.github/workflows/${n}.yml`);
      addCommit(`t${n}`, "two", `.github/workflows/${n}.yml`, "2026-09-01T00:00:00Z");
    }

    const result = priorArt.run(db, { ...ctx, arg: ".github/workflows", home: "/h" });
    const files = result.rows.map((r) => r[0]);
    expect(files[0]).toBe("code/one/.github/workflows/ci.yml");
    expect(files.filter((f) => String(f).includes("/two/"))).toHaveLength(3);
    expect(files.some((f) => String(f).includes("worktrees"))).toBe(false);
    expect(result.rows[0]?.[2]).toBe(2);
    expect(result.denominator).toContain("5 tracked files");
  } finally {
    db.close();
  }
});
