import type { CheckoutRow, CommitRow, GitRunRow, SignalRecord } from "./query-signal-record";
import { worktreeAt, worktreeCheckout } from "./worktree";

type DirRepo = { readonly path: string; readonly repo: string };

type Finder = (path: string | null) => string | null;

type Dated = { readonly ms: number; readonly commit: CommitRow };

const AUTHOR_TIME_GRAIN_MS = 1000;

const SUBJECT_EDGES = new Set(['"', "'", "\n"]);

type Covering = (path: string) => DirRepo | null;

function longestCovering(dirs: readonly DirRepo[]): Covering {
  const longestFirst = [...dirs].sort((a, b) => b.path.length - a.path.length);
  return (path) => longestFirst.find((d) => path === d.path || path.startsWith(`${d.path}/`)) ?? null;
}

function holdsSubject(command: string, subject: string): boolean {
  if (subject === "") return false;
  for (let at = command.indexOf(subject); at !== -1; at = command.indexOf(subject, at + 1)) {
    const before = at === 0 ? "\n" : command.charAt(at - 1);
    const after = command.charAt(at + subject.length) || "\n";
    if (SUBJECT_EDGES.has(before) && SUBJECT_EDGES.has(after)) return true;
  }
  return false;
}

export function firstAtOrAfter(times: readonly number[], ms: number): number {
  let low = 0;
  let high = times.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if ((times[mid] ?? Number.POSITIVE_INFINITY) < ms) low = mid + 1;
    else high = mid;
  }
  return low;
}

const onlyOne = (repos: ReadonlySet<string>): string | null => {
  const [repo, other] = repos;
  return repo !== undefined && other === undefined ? repo : null;
};

function repoMadeBy(run: GitRunRow, dated: readonly Dated[], times: readonly number[]): string | null {
  if (run.callAt === null) return null;
  const from = Date.parse(run.callAt) - AUTHOR_TIME_GRAIN_MS;
  const until = Date.parse(run.at) + AUTHOR_TIME_GRAIN_MS;
  const repos = new Set<string>();
  for (
    let i = firstAtOrAfter(times, from), at = dated[i];
    at !== undefined && at.ms <= until;
    at = dated[++i]
  ) {
    if (holdsSubject(run.command, at.commit.subject)) repos.add(at.commit.repo);
  }
  return onlyOne(repos);
}

function committedDirs(
  gitRuns: readonly GitRunRow[],
  commits: readonly CommitRow[],
  covered: Covering,
): readonly DirRepo[] {
  const commitRuns = gitRuns.filter((run) => run.subcommand === "commit");
  const dated = commits.map((commit) => ({ ms: Date.parse(commit.at), commit })).sort((a, b) => a.ms - b.ms);
  const times = dated.map((at) => at.ms);
  const reposByDir = new Map<string, Set<string>>();
  for (const run of commitRuns) {
    if (covered(run.dir) !== null || run.commitsInCall !== 1) continue;
    const repo = repoMadeBy(run, dated, times);
    if (repo === null) continue;
    const repos = reposByDir.get(run.dir) ?? new Set<string>();
    repos.add(repo);
    reposByDir.set(run.dir, repos);
  }
  return [...reposByDir].flatMap(([path, repos]) => {
    const repo = onlyOne(repos);
    return repo === null ? [] : [{ path, repo }];
  });
}

export function repoFinder(record: Pick<SignalRecord, "checkouts" | "gitRuns" | "commits">): Finder {
  const covered = longestCovering(record.checkouts);
  const covering = longestCovering([
    ...record.checkouts,
    ...committedDirs(record.gitRuns, record.commits, covered),
  ]);
  return (path) => (path === null ? null : (covering(path)?.repo ?? null));
}

export function checkoutFinder(checkouts: readonly CheckoutRow[]): (dir: string) => string {
  const covering = longestCovering(checkouts);
  const indexed = new Set(checkouts.map((checkout) => checkout.path));
  return (dir) => {
    const worktree = worktreeAt(dir);
    if (worktree !== null && indexed.has(worktree.project)) return worktreeCheckout(worktree);
    return covering(dir)?.path ?? dir;
  };
}
