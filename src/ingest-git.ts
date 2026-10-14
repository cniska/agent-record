import type { Database } from "bun:sqlite";
import { existsSync, realpathSync } from "node:fs";
import { invariant } from "./assert";
import { writeTransaction } from "./db";
import type { Env } from "./env";
import { checkoutRoot } from "./git-checkout";
import { type Checkout, probeCheckout } from "./git-probe";
import { originLabel } from "./git-remote";
import { skippingGoneCheckouts } from "./ingest-checkout-failure";
import type { Failure } from "./ingest-contract";
import { type Commit, readCommits } from "./ingest-git-source";
import { isScratchRepo } from "./ingest-scratch";
import { Timestamp, timestampMinus } from "./timestamp";

export type GitReport = { repos: number; commits: number; files: number; unchanged: number };

const OVERLAP_DAYS = 7;

export function repoRoots(db: Database, env: Env): readonly string[] {
  const cwds = db
    .query<{ cwd: string }, []>(
      `SELECT cwd FROM session WHERE cwd IS NOT NULL
       UNION SELECT repo FROM hook_event WHERE repo IS NOT NULL ORDER BY cwd`,
    )
    .all();
  const roots = new Set<string>();
  for (const { cwd } of cwds) {
    if (!existsSync(cwd) || isScratchRepo(cwd, env)) continue;
    const root = checkoutRoot(cwd);
    if (root !== null) roots.add(realpathSync(root));
  }
  return [...roots];
}

export function probeCheckouts(roots: readonly string[], failure: Failure): readonly Checkout[] {
  const fail = skippingGoneCheckouts(failure);
  const checkouts: Checkout[] = [];
  for (const root of roots) {
    try {
      checkouts.push(probeCheckout(root));
    } catch (error) {
      fail(root, error);
    }
  }
  return checkouts;
}

export function ingestCommits(db: Database, checkouts: readonly Checkout[], failure: Failure): GitReport {
  const fail = skippingGoneCheckouts(failure);
  const insertCommit = db.prepare(
    `INSERT INTO repo_commit (sha, repo, label, ts, author, subject, kind)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(sha) DO UPDATE SET
       repo = excluded.repo, label = coalesce(excluded.label, repo_commit.label),
       ts = excluded.ts, author = excluded.author,
       subject = excluded.subject, kind = excluded.kind`,
  );
  const insertFile = db.prepare(
    "INSERT INTO commit_file (sha, path) VALUES (?, ?) ON CONFLICT(sha, path) DO NOTHING",
  );
  const newestOf = db.query<{ ts: string | null }, [string]>(
    "SELECT max(ts) AS ts FROM repo_commit WHERE repo = ?",
  );
  const newestCommitTime = (repo: string): Timestamp | null => {
    const newest = Timestamp.nullable().safeParse(newestOf.get(repo)?.ts ?? null);
    invariant(newest.success, "a stored commit time parses as a time");
    return newest.data;
  };
  const headUnchanged = db.query<{ one: number }, [string, string | null]>(
    "SELECT 1 AS one FROM checkout WHERE path = ? AND head IS ?",
  );
  const saveHead = db.prepare<void, [string, string, string | null]>(
    "INSERT INTO checkout (path, repo, head) VALUES (?, ?, ?) ON CONFLICT(path) DO UPDATE SET repo = excluded.repo, head = excluded.head",
  );

  const report: GitReport = { repos: 0, commits: 0, files: 0, unchanged: 0 };
  const readHead = (path: string, repo: string, head: string): boolean => {
    let read: { label: string | null; commits: Commit[] };
    const newest = newestCommitTime(repo);
    const since = newest === null ? null : timestampMinus(newest, OVERLAP_DAYS * 86_400_000);
    try {
      read = { label: originLabel(repo), commits: readCommits(path, head, since) };
    } catch (error) {
      fail(path, error);
      return false;
    }
    report.repos += 1;
    for (const c of read.commits) {
      insertCommit.run(c.sha, repo, read.label, c.ts, c.author, c.subject, c.kind);
      report.commits += 1;
      for (const file of c.files) {
        insertFile.run(c.sha, `${repo}/${file}`);
        report.files += 1;
      }
    }
    return true;
  };

  writeTransaction(db, () => {
    for (const { path, repo, head } of checkouts) {
      if (headUnchanged.get(path, head)) {
        report.unchanged += 1;
        continue;
      }
      if (head !== null && !readHead(path, repo, head)) continue;
      saveHead.run(path, repo, head);
    }
  });
  return report;
}
