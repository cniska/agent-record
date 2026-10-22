import { basename } from "node:path";
import { firstAtOrAfter } from "./query-run-repo";
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

type Times = ReadonlyMap<string, readonly number[]>;

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

const branchOf = (push: RunInCheckout): string | null =>
  push.target === HEAD ? basename(push.checkout) : push.target;

const ascending = (a: number, b: number): number => a - b;

const timesBy = (runs: readonly RunInCheckout[], keyOf: (run: RunInCheckout) => string): Times =>
  new Map(
    [...Map.groupBy(runs, keyOf)].map(([key, group]) => [key, group.map((run) => run.ms).sort(ascending)]),
  );

const firstAtOrAfterIn = (times: Times, key: string, ms: number): number | null => {
  const sorted = times.get(key) ?? [];
  return sorted[firstAtOrAfter(sorted, ms)] ?? null;
};

const inRepo = (repo: string, key: string): string => `${repo}\0${key}`;

function mergeTimesByWorktree(runs: readonly RunInCheckout[]): Times {
  const worktreesByBranch = new Map<string, Set<string>>();
  for (const run of runs) {
    if (run.subcommand !== "push" || inMainCheckout(run)) continue;
    const branch = branchOf(run);
    if (!namesBranch(branch)) continue;
    const worktrees = worktreesByBranch.get(inRepo(run.repo, branch)) ?? new Set<string>();
    worktrees.add(run.checkout);
    worktreesByBranch.set(inRepo(run.repo, branch), worktrees);
  }
  const merges = runs.flatMap((run) => {
    if (!MERGING.has(run.subcommand) || !inMainCheckout(run) || run.target === null) return [];
    return [...(worktreesByBranch.get(inRepo(run.repo, run.target)) ?? [])].map((worktree) => ({
      ...run,
      checkout: worktree,
    }));
  });
  return timesBy(merges, (run) => run.checkout);
}

export function landingOf(runs: readonly RunInCheckout[]): Landing {
  const landingPushes = runs.filter((run) => run.subcommand === "push" && lands(run));
  const pushTimesByCheckout = timesBy(landingPushes, (run) => run.checkout);
  const mergeTimes = mergeTimesByWorktree(runs);
  const commitTimesBySlice = timesBy(
    runs.filter((run) => run.subcommand === "commit"),
    (run) => inRepo(run.repo, run.slice),
  );
  const earliest = (times: readonly (number | null)[]): number | null =>
    times.reduce((found, time) => (time !== null && (found === null || time < found) ? time : found), null);
  const onOrigin = (commit: RunInCheckout): number | null => {
    const ownPush = firstAtOrAfterIn(pushTimesByCheckout, commit.checkout, commit.ms);
    if (inMainCheckout(commit)) return ownPush;
    const merged = firstAtOrAfterIn(mergeTimes, commit.checkout, commit.ms);
    const mainPush = merged === null ? null : firstAtOrAfterIn(pushTimesByCheckout, commit.repo, merged);
    return earliest([ownPush, mainPush]);
  };
  return {
    onOrigin,
    supersededBeforeLanding: (commit) => {
      const landed = onOrigin(commit) ?? Number.POSITIVE_INFINITY;
      const later = firstAtOrAfterIn(commitTimesBySlice, inRepo(commit.repo, commit.slice), commit.ms + 1);
      return later !== null && later <= landed;
    },
  };
}
