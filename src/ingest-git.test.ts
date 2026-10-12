import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SCHEMA_SQL } from "./db-schema";
import { errorCode } from "./error-code";
import { repoWithWorktree } from "./git-fixtures.test-support";
import { ingestCommits, repoRoots } from "./ingest-git";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function dir(name: string): string {
  const made = realpathSync(mkdtempSync(join(tmpdir(), `agent-record-ingest-git-${name}-`)));
  roots.push(made);
  return made;
}

function repoWithCommit(content = "x"): string {
  const repo = dir("healthy");
  const git = (...args: string[]) => Bun.spawnSync(["git", "-C", repo, ...args]);
  git("init", "-q");
  writeFileSync(join(repo, "a.ts"), content);
  git("add", "a.ts");
  git("-c", "user.name=T", "-c", "user.email=t@example.com", "commit", "--no-verify", "-q", "-m", "feat: a");
  return repo;
}

function brokenCheckout(): string {
  const broken = dir("broken");
  writeFileSync(join(broken, ".git"), "gitdir: /nonexistent/agent-record-test\n");
  return broken;
}

describe("reading the repos the sessions ran in", () => {
  test("labels a repo by its origin remote alone", () => {
    const db = new Database(":memory:");
    db.run(SCHEMA_SQL);
    const withOrigin = repoWithCommit();
    const upstreamOnly = repoWithCommit("y");
    Bun.spawnSync(["git", "-C", withOrigin, "remote", "add", "origin", "git@github.com:Acme/Widgets.git"]);
    Bun.spawnSync(["git", "-C", upstreamOnly, "remote", "add", "upstream", "git@github.com:acme/other.git"]);

    ingestCommits(db, [withOrigin, upstreamOnly], () => {});
    expect(db.query("SELECT repo, label FROM repo_commit ORDER BY label IS NULL").all()).toEqual([
      { repo: withOrigin, label: "acme/widgets" },
      { repo: upstreamOnly, label: null },
    ]);
    db.close();
  });

  test("keys the commits of every checkout by their repository, so a second sync reads only the overlap", () => {
    const db = new Database(":memory:");
    db.run(SCHEMA_SQL);
    const { repo, worktree } = repoWithWorktree(dir("worktree"));
    const fail = (path: string, error: unknown) => {
      throw new Error(`${path}: ${String(error)}`);
    };

    expect(ingestCommits(db, [repo, worktree], fail).commits).toBe(3);
    expect(ingestCommits(db, [repo, worktree], fail).commits).toBe(2);
    expect(db.query("SELECT DISTINCT repo FROM repo_commit").all()).toEqual([{ repo }]);
    expect(db.query("SELECT DISTINCT path FROM commit_file ORDER BY path").all()).toEqual([
      { path: `${repo}/a.ts` },
      { path: `${repo}/old.ts` },
    ]);
    db.close();
  });

  test("names a checkout git cannot read as a failure and reads the others", () => {
    const db = new Database(":memory:");
    db.run(SCHEMA_SQL);
    const failed: { path: string; code: unknown }[] = [];
    const fail = (path: string, error: unknown) => failed.push({ path, code: errorCode(error) });
    const healthy = repoWithCommit();
    const broken = brokenCheckout();

    expect(ingestCommits(db, [broken, healthy], fail)).toEqual({ repos: 1, commits: 1, files: 1 });
    expect(failed).toEqual([{ path: broken, code: "git_failed" }]);
    expect(db.query("SELECT subject FROM repo_commit").all()).toEqual([{ subject: "feat: a" }]);

    db.run("INSERT INTO session (id, tool, cwd) VALUES ('s1', 'claude', ?)", [broken]);
    failed.length = 0;
    expect(repoRoots(db, fail)).toEqual([]);
    expect(failed).toEqual([{ path: broken, code: "git_failed" }]);
    db.close();
  });
});
