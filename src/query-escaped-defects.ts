import { dirname } from "node:path";
import { isCommitAllow } from "./query-hook-timeline";
import type { CommitFileRow, CommitRow, GateRow, HookRow } from "./query-signal-record";

export const ESCAPE_CAUSES = ["names commit", "shared file"] as const;

type Cause = (typeof ESCAPE_CAUSES)[number];

export type Gated = { readonly commit: CommitRow; readonly allow: GateRow };

export type Escape = { readonly fix: Gated; readonly earlier: CommitRow; readonly cause: Cause };

export const GATE_REACH_MINUTES = 15;

export const ESCAPE_REACH_DAYS = 2;

const GATE_REACH_MS = GATE_REACH_MINUTES * 60_000;

const DAY_MS = 86_400_000;

const FIX = "fix";

const ACCEPTED = "accepted";

const BEHAVIOR_KINDS: ReadonlySet<string> = new Set(["feat", "fix", "refactor", "perf"]);

const NAMED_SHA = /\b[0-9a-f]{7,40}\b/g;

const ROOT_DOC = ".md";

const TEST_FILE = /\.(test|spec)\.[^/]+$|\/(tests?|acceptance)\//;

const ms = (at: string): number => Date.parse(at);

const changeKey = (commit: CommitRow): string => JSON.stringify([commit.repo, commit.subject, commit.at]);

export function gateCommits(
  commits: readonly CommitRow[],
  hookEvents: readonly HookRow[],
  repoOf: (path: string | null) => string | null,
): readonly Gated[] {
  const repoBySha = new Map(commits.map((commit) => [commit.sha, commit.repo]));
  const allows = hookEvents.filter(isCommitAllow).flatMap((allow) => {
    const repo = repoOf(allow.repo) ?? (allow.head === null ? null : (repoBySha.get(allow.head) ?? null));
    return repo === null ? [] : [{ allow, repo, at: ms(allow.at) }];
  });
  const first = allows[0]?.at ?? Number.POSITIVE_INFINITY;
  const seen = new Set<string>();
  return commits.flatMap((commit) => {
    const at = ms(commit.at);
    if (at < first || seen.has(changeKey(commit))) return [];
    seen.add(changeKey(commit));
    const gate = allows.findLast(
      (allow) => allow.repo === commit.repo && allow.at <= at && at - allow.at <= GATE_REACH_MS,
    );
    if (gate === undefined) return [];
    return [{ commit, allow: gate.allow }];
  });
}

const canShare = (path: string, repo: string): boolean =>
  !(dirname(path) === repo && path.endsWith(ROOT_DOC)) && !TEST_FILE.test(path.slice(repo.length));

export const isAccepted = (gated: Gated): boolean => gated.allow.reason === ACCEPTED;

const committer = (allow: GateRow): string => allow.agent ?? allow.sessionId;

function namedEarlier(fix: CommitRow, commits: readonly CommitRow[]): CommitRow | null {
  const named = [...fix.subject.matchAll(NAMED_SHA)].map(([sha]) => sha);
  return (
    commits.find(
      (commit) =>
        commit.repo === fix.repo &&
        ms(commit.at) < ms(fix.at) &&
        named.some((sha) => commit.sha.startsWith(sha)),
    ) ?? null
  );
}

export function escapesOf(
  gated: readonly Gated[],
  commits: readonly CommitRow[],
  commitFiles: readonly CommitFileRow[],
): readonly Escape[] {
  const filesOf = Map.groupBy(commitFiles, (file) => file.sha);
  const touched = (commit: CommitRow): ReadonlySet<string> =>
    new Set(
      (filesOf.get(commit.sha) ?? []).map((file) => file.path).filter((path) => canShare(path, commit.repo)),
    );
  const accepted = gated.filter((g) => isAccepted(g) && BEHAVIOR_KINDS.has(g.commit.kind ?? ""));
  return gated.flatMap((fix): readonly Escape[] => {
    const at = ms(fix.commit.at);
    if (fix.commit.kind !== FIX) return [];
    const named = namedEarlier(fix.commit, commits);
    if (named !== null) return [{ fix, earlier: named, cause: "names commit" }];
    const paths = touched(fix.commit);
    const shared = accepted.findLast(
      ({ commit }) =>
        commit.repo === fix.commit.repo &&
        ms(commit.at) < at &&
        at - ms(commit.at) <= ESCAPE_REACH_DAYS * DAY_MS &&
        [...touched(commit)].some((path) => paths.has(path)),
    );
    if (shared === undefined || committer(shared.allow) === committer(fix.allow)) return [];
    return [{ fix, earlier: shared.commit, cause: "shared file" }];
  });
}
