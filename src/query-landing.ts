import { basename } from "node:path";
import type { GitRunRow } from "./query-signal-record";

export type RunInCheckout = GitRunRow & {
  readonly repo: string;
  readonly ms: number;
  readonly checkout: string;
  readonly slice: string;
};

type Landing = {
  readonly onOrigin: (run: RunInCheckout) => number | null;
  readonly supersededBeforeLanding: (run: RunInCheckout) => boolean;
};

const MAIN = "main";

const HEAD = "HEAD";

const OPTION = "-";

const MERGING: ReadonlySet<GitRunRow["subcommand"]> = new Set(["merge", "rebase", "reset"]);

export const inMainCheckout = (run: Pick<RunInCheckout, "checkout" | "repo">): boolean =>
  run.checkout === run.repo;

function lands(push: RunInCheckout): boolean {
  if (push.target === MAIN) return true;
  return (push.target === null || push.target === HEAD) && inMainCheckout(push);
}

const namesBranch = (target: string | null): target is string =>
  target !== null && target !== MAIN && target !== HEAD && !target.startsWith(OPTION);

function branchesOfWorktrees(runs: readonly RunInCheckout[]): ReadonlyMap<string, ReadonlySet<string>> {
  const branches = new Map<string, Set<string>>();
  for (const run of runs) {
    if (run.subcommand !== "push" || inMainCheckout(run)) continue;
    const branch = run.target === HEAD ? basename(run.checkout) : run.target;
    if (!namesBranch(branch)) continue;
    const named = branches.get(run.checkout) ?? new Set<string>();
    named.add(branch);
    branches.set(run.checkout, named);
  }
  return branches;
}

export function landingOf(runs: readonly RunInCheckout[]): Landing {
  const byRepo = Map.groupBy(runs, (run) => run.repo);
  const branches = branchesOfWorktrees(runs);
  const mergedInto = (merge: RunInCheckout, worktree: string): boolean =>
    merge.target !== null &&
    MERGING.has(merge.subcommand) &&
    inMainCheckout(merge) &&
    (branches.get(worktree)?.has(merge.target) ?? false);
  const carries = (
    push: RunInCheckout,
    commit: RunInCheckout,
    sameRepo: readonly RunInCheckout[],
  ): boolean => {
    if (push.checkout === commit.checkout) return true;
    if (!inMainCheckout(push)) return false;
    return sameRepo.some(
      (merge) => merge.ms >= commit.ms && merge.ms <= push.ms && mergedInto(merge, commit.checkout),
    );
  };
  const onOrigin = (commit: RunInCheckout): number | null => {
    const sameRepo = byRepo.get(commit.repo) ?? [];
    return (
      sameRepo.find(
        (push) =>
          push.subcommand === "push" &&
          push.ms >= commit.ms &&
          lands(push) &&
          carries(push, commit, sameRepo),
      )?.ms ?? null
    );
  };
  return {
    onOrigin,
    supersededBeforeLanding: (commit) => {
      const landed = onOrigin(commit) ?? Number.POSITIVE_INFINITY;
      return (byRepo.get(commit.repo) ?? []).some(
        (later) =>
          later.subcommand === "commit" &&
          later.ms > commit.ms &&
          later.ms <= landed &&
          later.slice === commit.slice,
      );
    },
  };
}
