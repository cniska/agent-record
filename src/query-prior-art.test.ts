import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { SCHEMA_SQL } from "./db-schema";
import { repoWithWorktree } from "./git-fixtures.test-support";
import { ingestCommits } from "./ingest-git";
import { ctx } from "./query.test-support";
import { priorArt } from "./query-prior-art";
import { indexRepoFiles } from "./repo-files";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("dates a file found only through a worktree by the commits of its repository", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-record-prior-art-"));
  roots.push(root);
  const { repo, worktree } = repoWithWorktree(root);
  const db = new Database(":memory:");
  try {
    db.run(SCHEMA_SQL);
    const fail = (path: string, error: unknown) => {
      throw new Error(`${path}: ${String(error)}`);
    };
    ingestCommits(db, [worktree, repo], fail);
    indexRepoFiles(db, [worktree], fail);

    const result = priorArt.run(db, { ...ctx, arg: "a.ts", home: dirname(repo) });
    expect(result.columns).toEqual(["file", "repo", "commits", "days_since", "authors"]);
    expect(result.rows).toEqual([["repo/a.ts", "repo", 1, 0, 1]]);

    indexRepoFiles(db, [repo], fail);
    expect(priorArt.run(db, { ...ctx, arg: "a.ts", home: dirname(repo) }).denominator).toContain(
      "in 1 of 1 repos indexed",
    );
  } finally {
    db.close();
  }
});
