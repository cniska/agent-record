import { unreachable } from "./assert";
import type { Counted } from "./ingest-event-kinds";
import { type Escape, escapesOf, type Gated, gateCommits, isAccepted } from "./query-escaped-defects";
import {
  type Blocked,
  blocksOf,
  type Judged,
  judgeDenials,
  type Reviewed,
  repoNamed,
  reviewRounds,
} from "./query-hook-timeline";
import type { Cause } from "./query-interrupt";
import { inMainCheckout, landingOf, type RunInCheckout } from "./query-landing";
import { type Reread, rereadsAfterCompactions } from "./query-lost-context";
import { checkoutFinder, repoFinder } from "./query-run-repo";
import { asksSecondRead } from "./query-second-read";
import type { HookRow, SessionRow, SignalRecord } from "./query-signal-record";
import { type Stretch, stepStretches } from "./query-step-cost";
import {
  type SaidRow,
  saidRows,
  TaskId,
  type TaskKey,
  type TaskStart,
  taskAt,
  taskKeyOf,
  taskStartsOf,
} from "./query-task";
import { EpochMs } from "./timestamp";

export type Placed = {
  readonly at: string;
  readonly task: TaskKey;
  readonly sessionId: string;
  readonly repo: string | null;
  readonly tags: Tags;
};

type Tags = ReadonlyMap<string, string>;

type Interrupt = Placed & { readonly cause: Cause; readonly text: string | null };

type Ask = Placed & { readonly text: string };

type TaskOutcome = Placed & {
  readonly ownerTyped: boolean;
  readonly hookLogged: boolean;
  readonly lastCommitRun: string | null;
  readonly landedAt: string | null;
};

type CommitRun = Placed & {
  readonly onOriginAt: string | null;
  readonly lastOfSession: boolean;
  readonly standsForSlice: boolean;
};

type Kinded<Kind extends string> = Placed & { readonly kind: Kind };

type Compaction = Placed & { readonly rereads: readonly Reread[] };

type AcceptedCommit = Placed & { readonly sha: string };

type Escaped = Placed & {
  readonly cause: Escape["cause"];
  readonly sha: string;
  readonly subject: string;
  readonly earlier: string;
  readonly earlierAt: string;
};

type CountedVerdict = Placed & Counted;

type StepSpent = Placed & Omit<Stretch, "sessionId" | "at">;

export type SkillLoaded = Placed & {
  readonly skill: string;
  readonly bodySha256: string | null;
  readonly install: string | null;
};

export type Timeline = {
  readonly interrupts: readonly Interrupt[];
  readonly secondReadAsks: readonly Ask[];
  readonly tasks: readonly TaskOutcome[];
  readonly commitRuns: readonly CommitRun[];
  readonly steps: readonly StepSpent[];
  readonly denials: readonly Kinded<Judged["kind"]>[];
  readonly reviews: readonly Kinded<Reviewed["kind"]>[];
  readonly countedVerdicts: readonly CountedVerdict[];
  readonly blocks: readonly Kinded<Blocked["kind"]>[];
  readonly skillLoads: readonly SkillLoaded[];
  readonly compactions: readonly Compaction[];
  readonly acceptedCommits: readonly AcceptedCommit[];
  readonly escapes: readonly Escaped[];
  readonly tagKeys: readonly string[];
  readonly newest: string | null;
};

type Run = RunInCheckout & { readonly root: string };

type Pending = {
  readonly sessionId: string;
  readonly at: string;
  readonly cause: Cause;
  readonly text: string | null;
};

const ms = (at: string): number => Date.parse(at);

const iso = (time: number | null): string | null => (time === null ? null : EpochMs.parse(time));

function rootFinder(sessions: ReadonlyMap<string, SessionRow>): (id: string) => string {
  return (id) => {
    const seen = new Set<string>();
    let at = id;
    let parent = sessions.get(at)?.parentId ?? null;
    while (parent !== null && !seen.has(parent)) {
      seen.add(at);
      at = parent;
      parent = sessions.get(at)?.parentId ?? null;
    }
    return at;
  };
}

function tasksByRoot(
  record: SignalRecord,
  said: readonly SaidRow[],
): {
  readonly tasks: ReadonlyMap<string, readonly TaskStart[]>;
  readonly ownerTyped: ReadonlySet<string>;
  readonly pending: readonly Pending[];
} {
  const ownerTyped = new Set<string>();
  const pending: Pending[] = [];
  for (const message of said) {
    switch (message.said.kind) {
      case "command":
        break;
      case "interrupt":
        ownerTyped.add(message.sessionId);
        pending.push({ ...message, cause: message.said.cause });
        break;
      case "task":
      case "within":
        ownerTyped.add(message.sessionId);
        break;
      default:
        unreachable(message.said);
    }
  }
  for (const rejection of record.rejections) pending.push({ ...rejection, cause: "permission", text: null });
  const bySession = Map.groupBy(said, (message) => message.sessionId);
  const openings = new Map(record.openings.map((opening) => [opening.sessionId, opening]));
  const tasks = new Map(
    record.sessions.flatMap((session) =>
      session.parentId === null && session.start !== null
        ? [
            [
              session.id,
              taskStartsOf(
                session.id,
                session.start,
                openings.get(session.id) ?? null,
                bySession.get(session.id) ?? [],
              ),
            ] as const,
          ]
        : [],
    ),
  );
  return { tasks, ownerTyped, pending };
}

export function timelineOf(record: SignalRecord): Timeline {
  const sessions = new Map(record.sessions.map((session) => [session.id, session]));
  const rootOf = rootFinder(sessions);
  const repoOf = repoFinder(record);
  const repoOfRoot = (root: string) => repoOf(sessions.get(root)?.project ?? null);
  const said = saidRows(record.ownerMessages);
  const { tasks: startsByRoot, ownerTyped, pending } = tasksByRoot(record, said);
  const taskKey = (root: string, at: number): TaskKey => {
    const starts = startsByRoot.get(root);
    return taskKeyOf(root, starts === undefined ? TaskId.parse(root) : taskAt(starts, at).id);
  };

  const tagged = new Map<TaskKey, Map<string, string>>();
  for (const tag of record.tags) {
    const key = taskKey(rootOf(tag.sessionId), ms(tag.at));
    const tags = tagged.get(key) ?? new Map<string, string>();
    if (!tags.has(tag.key)) tags.set(tag.key, tag.value);
    tagged.set(key, tags);
  }
  const untagged: Tags = new Map();
  const tagsOf = (key: TaskKey): Tags => tagged.get(key) ?? untagged;
  const inTask = (root: string, at: number): { readonly task: TaskKey; readonly tags: Tags } => {
    const task = taskKey(root, at);
    return { task, tags: tagsOf(task) };
  };

  const checkoutOf = checkoutFinder(record.checkouts);
  const runs: Run[] = record.gitRuns
    .flatMap((run) => {
      const repo = repoOf(run.dir);
      if (repo === null) return [];
      const checkout = checkoutOf(run.dir);
      const root = rootOf(run.sessionId);
      const at = ms(run.at);
      const slice = inMainCheckout({ checkout, repo }) ? taskKey(root, at) : checkout;
      return [{ ...run, repo, checkout, slice, root, ms: at }];
    })
    .toSorted((a, b) => a.ms - b.ms);
  const { onOrigin, supersededBeforeLanding } = landingOf(runs);
  const commits = runs.filter((run) => run.subcommand === "commit");
  const lastOfRoot = new Map(commits.map((run) => [run.root, run]));
  const lastOfTask = new Map(commits.map((run) => [taskKey(run.root, run.ms), run]));

  const interrupts: Interrupt[] = pending.map((waiting) => {
    const root = rootOf(waiting.sessionId);
    return { ...waiting, sessionId: root, repo: repoOfRoot(root), ...inTask(root, ms(waiting.at)) };
  });

  const secondReadAsks: Ask[] = said.flatMap((message) => {
    if (message.said.kind === "command" || !asksSecondRead(message.text)) return [];
    const root = rootOf(message.sessionId);
    return [
      {
        at: message.at,
        sessionId: root,
        repo: repoOfRoot(root),
        ...inTask(root, ms(message.at)),
        text: message.text,
      },
    ];
  });

  const firstHook = record.hookEvents[0]?.at ?? null;
  const hookLogged = (root: string, at: string): boolean =>
    firstHook !== null && sessions.get(root)?.tool === "claude" && ms(at) >= ms(firstHook);

  const keyedTasks = [...startsByRoot.entries()].flatMap(([root, list]) =>
    list.map((prompt) => {
      const key = taskKeyOf(root, prompt.id);
      const last = lastOfTask.get(key) ?? null;
      const task: TaskOutcome = {
        at: prompt.at,
        sessionId: root,
        repo: last === null ? repoOfRoot(root) : last.repo,
        task: key,
        tags: tagsOf(key),
        ownerTyped: ownerTyped.has(root),
        hookLogged: hookLogged(root, prompt.at),
        lastCommitRun: last === null ? null : last.at,
        landedAt: last === null ? null : iso(onOrigin(last)),
      };
      return { key, task };
    }),
  );
  const tasks = keyedTasks.map(({ task }) => task);
  const hookLoggedTasks = new Set(keyedTasks.filter(({ task }) => task.hookLogged).map(({ key }) => key));

  const commitRuns: CommitRun[] = commits.map((run) => ({
    at: run.at,
    sessionId: run.root,
    repo: run.repo,
    ...inTask(run.root, run.ms),
    onOriginAt: iso(onOrigin(run)),
    lastOfSession: lastOfRoot.get(run.root) === run,
    standsForSlice: !supersededBeforeLanding(run),
  }));

  const steps: StepSpent[] = stepStretches(record.sessions, record.responses, record.skillLoads, {
    ownerMessages: record.ownerMessages,
    subagentReturns: record.subagentReturns,
  }).map(({ sessionId, at, ...stretch }) => {
    const root = rootOf(sessionId);
    return { at, sessionId: root, repo: repoOfRoot(root), ...inTask(root, ms(at)), ...stretch };
  });

  const skillLoads: SkillLoaded[] = record.skillLoads.map((load) => {
    const root = rootOf(load.sessionId);
    return {
      at: load.at,
      sessionId: root,
      repo: repoOfRoot(root),
      ...inTask(root, ms(load.at)),
      skill: load.skill,
      bodySha256: load.bodySha256,
      install: load.install,
    };
  });

  const compactions: Compaction[] = rereadsAfterCompactions(
    record.compactions,
    record.compactedSessionReads,
  ).map((compaction) => {
    const root = rootOf(compaction.sessionId);
    return {
      at: compaction.at,
      sessionId: root,
      repo: repoOfRoot(root),
      ...inTask(root, ms(compaction.at)),
      rereads: compaction.rereads,
    };
  });

  const placeGated = ({ commit, allow }: Gated): Placed => {
    const root = rootOf(allow.sessionId);
    return { at: commit.at, sessionId: root, repo: commit.repo, ...inTask(root, ms(allow.at)) };
  };
  const gated = gateCommits(record.commits, record.hookEvents, repoOf);
  const acceptedCommits: AcceptedCommit[] = gated
    .filter(isAccepted)
    .map((g) => ({ ...placeGated(g), sha: g.commit.sha }));
  const escapes: Escaped[] = escapesOf(gated, record.commits, record.commitFiles).map((escaped) => ({
    ...placeGated(escaped.fix),
    cause: escaped.cause,
    sha: escaped.fix.commit.sha,
    subject: escaped.fix.commit.subject,
    earlier: escaped.earlier.sha,
    earlierAt: escaped.earlier.at,
  }));

  const placeRow = (row: HookRow): Placed => {
    const root = rootOf(row.sessionId);
    const named = repoNamed(row);
    return {
      at: row.at,
      sessionId: root,
      repo: named === null ? repoOfRoot(root) : repoOf(named),
      ...inTask(root, ms(row.at)),
    };
  };
  const placeHook = <Kind extends string>({ row, kind }: { row: HookRow; kind: Kind }): Kinded<Kind> => ({
    ...placeRow(row),
    kind,
  });
  const countedVerdicts: CountedVerdict[] = record.hookEvents.flatMap((row) =>
    row.event === "verdict" && row.counted !== null ? [{ ...placeRow(row), ...row.counted }] : [],
  );

  return {
    interrupts,
    secondReadAsks,
    tasks,
    commitRuns,
    steps,
    denials: judgeDenials(record.hookEvents).map(placeHook),
    reviews: reviewRounds(record.hookEvents).map(placeHook),
    countedVerdicts,
    blocks: blocksOf(record.hookEvents)
      .filter(({ row }) => hookLoggedTasks.has(taskKey(rootOf(row.sessionId), ms(row.at))))
      .map(placeHook),
    skillLoads,
    compactions,
    acceptedCommits,
    escapes,
    tagKeys: [...new Set(record.tags.map((tag) => tag.key))].toSorted(),
    newest: record.newest,
  };
}
