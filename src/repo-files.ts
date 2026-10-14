import type { Database } from "bun:sqlite";
import { join } from "node:path";
import { writeTransaction } from "./db";
import { nulFields, ran } from "./git";
import type { Checkout } from "./git-probe";
import type { Failure } from "./ingest-contract";

export type RepoFileReport = { repos: number; files: number; unchanged: number };

export function trackedFiles(repo: string): string[] {
  return nulFields(ran(repo, ["ls-files", "-z"]), "git ls-files -z").map((path) => join(repo, path));
}

export function indexRepoFiles(db: Database, checkouts: readonly Checkout[], fail: Failure): RepoFileReport {
  const indexUnchanged = db.query<{ one: number }, [string, string | null]>(
    "SELECT 1 AS one FROM checkout WHERE path = ? AND index_stat IS ?",
  );
  const clear = db.prepare("DELETE FROM repo_file WHERE checkout = ?");
  const insert = db.prepare("INSERT INTO repo_file (checkout, path) VALUES (?, ?) ON CONFLICT DO NOTHING");
  const saveIndex = db.prepare<void, [string, string, string | null]>(
    "INSERT INTO checkout (path, repo, index_stat) VALUES (?, ?, ?) ON CONFLICT(path) DO UPDATE SET repo = excluded.repo, index_stat = excluded.index_stat",
  );

  const report: RepoFileReport = { repos: 0, files: 0, unchanged: 0 };
  writeTransaction(db, () => {
    for (const { path, repo, indexStat } of checkouts) {
      if (indexUnchanged.get(path, indexStat)) {
        report.unchanged += 1;
        continue;
      }
      let tracked: string[];
      try {
        tracked = trackedFiles(path);
      } catch (error) {
        fail(path, error);
        continue;
      }
      clear.run(path);
      for (const file of tracked) insert.run(path, file);
      saveIndex.run(path, repo, indexStat);
      report.repos += 1;
      report.files += tracked.length;
    }
  });
  return report;
}
