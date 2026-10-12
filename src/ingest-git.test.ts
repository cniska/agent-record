import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { SCHEMA_SQL } from "./db-schema";
import { errorCode } from "./error-code";
import { repoWithWorktree } from "./git-fixtures.test-support";
import { ingestCommits, probeCheckouts, repoRoots } from "./ingest-git";
import { indexRepoFiles } from "./repo-files";

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

const failing = (path: string, error: unknown) => {
  throw new Error(`${path}: ${String(error)}`);
};

function freshDb(): Database {
  const db = new Database(":memory:");
  db.run(SCHEMA_SQL);
  return db;
}

function commitIn(repo: string, file: string): void {
  writeFileSync(join(repo, file), file);
  Bun.spawnSync(["git", "-C", repo, "add", file]);
  Bun.spawnSync([
    "git",
    "-C",
    repo,
    "-c",
    "user.name=T",
    "-c",
    "user.email=t@example.com",
    "commit",
    "--no-verify",
    "-q",
    "-m",
    `feat: ${file}`,
  ]);
}

const commitsOf = (db: Database, roots: readonly string[]) =>
  ingestCommits(db, probeCheckouts(roots, failing), failing);

describe("reading the repos the sessions ran in", () => {
  test("labels a repo by its origin remote alone", () => {
    const db = freshDb();
    const withOrigin = repoWithCommit();
    const upstreamOnly = repoWithCommit("y");
    Bun.spawnSync(["git", "-C", withOrigin, "remote", "add", "origin", "git@github.com:Acme/Widgets.git"]);
    Bun.spawnSync(["git", "-C", upstreamOnly, "remote", "add", "upstream", "git@github.com:acme/other.git"]);

    commitsOf(db, [withOrigin, upstreamOnly]);
    expect(db.query("SELECT repo, label FROM repo_commit ORDER BY label IS NULL").all()).toEqual([
      { repo: withOrigin, label: "acme/widgets" },
      { repo: upstreamOnly, label: null },
    ]);
    db.close();
  });

  test("keys the commits of every checkout by their repository, so a new commit reads only the overlap", () => {
    const db = freshDb();
    const { repo, worktree } = repoWithWorktree(dir("worktree"));

    expect(commitsOf(db, [repo, worktree])).toEqual({ repos: 2, commits: 3, files: 3, unchanged: 0 });
    commitIn(worktree, "b.ts");
    expect(commitsOf(db, [repo, worktree])).toEqual({ repos: 1, commits: 2, files: 2, unchanged: 1 });
    expect(db.query("SELECT DISTINCT repo FROM repo_commit").all()).toEqual([{ repo }]);
    expect(db.query("SELECT DISTINCT path FROM commit_file ORDER BY path").all()).toEqual([
      { path: `${repo}/a.ts` },
      { path: `${repo}/b.ts` },
      { path: `${repo}/old.ts` },
    ]);
    db.close();
  });

  test("reads a checkout again only once its head moves", () => {
    const db = freshDb();
    const repo = repoWithCommit();

    expect(commitsOf(db, [repo])).toEqual({ repos: 1, commits: 1, files: 1, unchanged: 0 });
    expect(commitsOf(db, [repo])).toEqual({ repos: 0, commits: 0, files: 0, unchanged: 1 });
    commitIn(repo, "b.ts");
    expect(commitsOf(db, [repo])).toMatchObject({ repos: 1, unchanged: 0 });
    expect(db.query("SELECT subject FROM repo_commit ORDER BY subject").all()).toEqual([
      { subject: "feat: a" },
      { subject: "feat: b.ts" },
    ]);
    db.close();
  });

  test("records a repo with no commits yet without reading it, until its first commit", () => {
    const db = freshDb();
    const repo = dir("unborn");
    Bun.spawnSync(["git", "init", "-q", repo]);

    expect(commitsOf(db, [repo])).toEqual({ repos: 0, commits: 0, files: 0, unchanged: 0 });
    expect(db.query("SELECT path, head FROM checkout").all()).toEqual([{ path: repo, head: null }]);
    expect(commitsOf(db, [repo])).toEqual({ repos: 0, commits: 0, files: 0, unchanged: 1 });
    commitIn(repo, "a.ts");
    expect(commitsOf(db, [repo])).toEqual({ repos: 1, commits: 1, files: 1, unchanged: 0 });
    db.close();
  });

  test("re-reads the files of a checkout whose index changed without its commits", () => {
    const db = freshDb();
    const repo = repoWithCommit();
    const sync = () => {
      const checkouts = probeCheckouts([repo], failing);
      return {
        git: ingestCommits(db, checkouts, failing),
        repoFiles: indexRepoFiles(db, checkouts, failing),
      };
    };

    sync();
    writeFileSync(join(repo, "b.ts"), "b");
    Bun.spawnSync(["git", "-C", repo, "add", "b.ts"]);
    expect(sync()).toEqual({
      git: { repos: 0, commits: 0, files: 0, unchanged: 1 },
      repoFiles: { repos: 1, files: 2, unchanged: 0 },
    });
    db.close();
  });

  test("names a checkout git cannot read as a failure, keeps what it read before and reads the others", () => {
    const db = freshDb();
    const failed: { path: string; code: unknown }[] = [];
    const fail = (path: string, error: unknown) => failed.push({ path, code: errorCode(error) });
    const healthy = repoWithCommit();
    const breaking = repoWithCommit("y");
    commitsOf(db, [breaking]);

    rmSync(join(breaking, ".git"), { recursive: true });
    writeFileSync(join(breaking, ".git"), "gitdir: /nonexistent/agent-record-test\n");
    const checkouts = probeCheckouts([breaking, healthy], fail);
    expect(checkouts.map((checkout) => checkout.path)).toEqual([healthy]);
    expect(failed).toEqual([{ path: breaking, code: "git_failed" }]);
    expect(ingestCommits(db, checkouts, fail)).toEqual({ repos: 1, commits: 1, files: 1, unchanged: 0 });
    expect(db.query("SELECT path FROM checkout ORDER BY path").all()).toEqual(
      [breaking, healthy].sort().map((path) => ({ path })),
    );
    db.close();
  });
});

describe("finding the checkouts the sessions ran in", () => {
  const thisCheckout = dirname(import.meta.dir);
  const rootsOf = (cwds: readonly string[]): readonly string[] => {
    const db = freshDb();
    cwds.forEach((cwd, i) => {
      db.run("INSERT INTO session (id, tool, cwd) VALUES (?, 'claude', ?)", [`s${i}`, cwd]);
    });
    const roots = repoRoots(db);
    db.close();
    return roots;
  };

  test("climbs from each cwd to its checkout, once per checkout", () => {
    expect(rootsOf([thisCheckout, import.meta.dir, join(import.meta.dir, "..", "plugin")])).toEqual([
      thisCheckout,
    ]);
  });

  test("skips a cwd that is gone, so a repo above it is not mistaken for its checkout", () => {
    expect(rootsOf([join(import.meta.dir, "agent-record-a-directory-that-is-gone")])).toEqual([]);
  });

  test("skips a scratch tree without asking git, even one whose .git is empty", () => {
    const scratch = dir("scratch");
    mkdirSync(join(scratch, ".git"));
    expect(rootsOf([scratch])).toEqual([]);
  });
});
