import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repoWithWorktree } from "./git-fixtures.test-support";
import { probeCheckout } from "./git-probe";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function scratch(): string {
  const made = realpathSync(mkdtempSync(join(tmpdir(), "agent-record-probe-")));
  roots.push(made);
  return made;
}

const headOf = (dir: string): string =>
  Bun.spawnSync(["git", "-C", dir, "rev-parse", "HEAD"]).stdout.toString().trim();

describe("probing a checkout", () => {
  test("names a worktree's repository, its head and the state of its index", () => {
    const { repo, worktree } = repoWithWorktree(scratch());
    const index = statSync(join(repo, ".git", "worktrees", "w", "index"), { bigint: true });

    expect(probeCheckout(worktree)).toEqual({
      path: worktree,
      repo,
      head: headOf(worktree),
      indexStat: `${index.size}:${index.mtimeNs}`,
    });
  });

  test("a repo with no commits and no index has neither a head nor an index state", () => {
    const repo = scratch();
    Bun.spawnSync(["git", "init", "-q", repo]);

    expect(probeCheckout(repo)).toEqual({ path: repo, repo, head: null, indexStat: null });
  });

  test("refuses a checkout git cannot read", () => {
    const broken = scratch();
    writeFileSync(join(broken, ".git"), "gitdir: /nonexistent/agent-record-test\n");

    expect(() => probeCheckout(broken)).toThrow(expect.objectContaining({ code: "git_failed" }));
  });
});
