import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const OLD_COMMIT_TS = "2020-01-01T00:00:00.000Z";

type RepoWithWorktree = { repo: string; worktree: string };

export function repoWithWorktree(root: string): RepoWithWorktree {
  const repo = join(realpathSync(root), "repo");
  mkdirSync(repo);
  const git = (args: string[], env: Record<string, string> = {}) => {
    const run = Bun.spawnSync(["git", "-C", repo, ...args], { env: { ...process.env, ...env } });
    if (run.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${run.stderr.toString()}`);
  };
  const commit = (file: string, subject: string, env: Record<string, string> = {}) => {
    writeFileSync(join(repo, file), subject);
    git(["add", file]);
    git(
      ["-c", "user.name=T", "-c", "user.email=t@example.com", "commit", "--no-verify", "-q", "-m", subject],
      env,
    );
  };

  git(["init", "-q", "-b", "main"]);
  commit("old.ts", "feat: old", { GIT_AUTHOR_DATE: OLD_COMMIT_TS, GIT_COMMITTER_DATE: OLD_COMMIT_TS });
  commit("a.ts", "feat: a");
  const worktree = join(repo, ".claude", "worktrees", "w");
  git(["worktree", "add", "-q", worktree]);
  return { repo, worktree };
}
