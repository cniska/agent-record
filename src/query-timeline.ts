import { basename, extname } from "node:path";
import { z } from "zod";
import { unreachable } from "./assert";
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
import { type Cause, classify } from "./query-interrupt";
import { type Reread, rereadsAfterCompactions } from "./query-lost-context";
import { asksSecondRead } from "./query-second-read";
import type { CheckoutRow, GitRunRow, HookRow, SessionRow, SignalRecord } from "./query-signal-record";
import { namedKind, type Stretch, stepStretches } from "./query-step-cost";
import { EpochMs } from "./timestamp";

const NO_ROUTE = "none";

const TaskKey = z.string().brand<"TaskKey">();

export type TaskKey = z.infer<typeof TaskKey>;

export type Placed = {
  readonly at: string;
  readonly task: TaskKey;
  readonly sessionId: string;
  readonly repo: string | null;
  readonly route: string;
};

type Interrupt = Placed & { readonly cause: Cause; readonly text: string | null };

type Ask = Placed & { readonly text: string };

type TaskOutcome = Placed & {
  readonly ownerTyped: boolean;
  readonly hookLogged: boolean;
  readonly lastCommitRun: string | null;
  readonly landedAt: string | null;
};

type CommitRun = Placed & { readonly onOriginAt: string | null; readonly lastOfSession: boolean };

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
  readonly reviewerRuns: readonly Placed[];
  readonly steps: readonly StepSpent[];
  readonly denials: readonly Kinded<Judged["kind"]>[];
  readonly reviews: readonly Kinded<Reviewed["kind"]>[];
  readonly blocks: readonly Kinded<Blocked["kind"]>[];
  readonly skillLoads: readonly SkillLoaded[];
  readonly compactions: readonly Compaction[];
  readonly acceptedCommits: readonly AcceptedCommit[];
  readonly escapes: readonly Escaped[];
  readonly newest: string | null;
};

type Prompt = { readonly at: string; readonly ms: number };

type Run = GitRunRow & { readonly repo: string; readonly root: string; readonly ms: number };

type Pending = {
  readonly sessionId: string;
  readonly at: string;
  readonly cause: Cause;
  readonly text: string | null;
};

const ms = (at: string): number => Date.parse(at);

const iso = (time: number | null): string | null => (time === null ? null : EpochMs.parse(time));

function repoFinder(checkouts: readonly CheckoutRow[]): (path: string | null) => string | null {
  const longestFirst = [...checkouts].sort((a, b) => b.path.length - a.path.length);
  return (path) => {
    if (path === null) return null;
    return longestFirst.find((c) => path === c.path || path.startsWith(`${c.path}/`))?.repo ?? null;
  };
}

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

function promptsByRoot(record: SignalRecord): {
  readonly prompts: ReadonlyMap<string, readonly Prompt[]>;
  readonly ownerTyped: ReadonlySet<string>;
  readonly pending: readonly Pending[];
} {
  const starts: { readonly root: string; readonly at: string }[] = record.sessions.flatMap((session) =>
    session.parentId === null && session.start !== null ? [{ root: session.id, at: session.start }] : [],
  );
  const ownerTyped = new Set<string>();
  const pending: Pending[] = [];
  for (const message of record.ownerMessages) {
    const said = classify(message.text, message.agentBefore, message.midTurn);
    switch (said.kind) {
      case "command":
        break;
      case "interrupt":
        ownerTyped.add(message.sessionId);
        pending.push({ ...message, cause: said.cause });
        break;
      case "task":
        ownerTyped.add(message.sessionId);
        if (message.agentBefore !== null) starts.push({ root: message.sessionId, at: message.at });
        break;
      case "within":
        ownerTyped.add(message.sessionId);
        break;
      default:
        unreachable(said);
    }
  }
  for (const rejection of record.rejections) pending.push({ ...rejection, cause: "permission", text: null });
  const prompts = new Map(
    [...Map.groupBy(starts, (start) => start.root)].map(([root, list]) => [
      root,
      list.map(({ at }) => ({ at, ms: ms(at) })).sort((a, b) => a.ms - b.ms),
    ]),
  );
  return { prompts, ownerTyped, pending };
}

function taskIndex(prompts: readonly Prompt[], at: number): number {
  let found = 0;
  prompts.forEach((prompt, index) => {
    if (prompt.ms <= at) found = index;
  });
  return found;
}

function pushesByRepo(runs: readonly Run[]): (run: Run) => number | null {
  const pushes = Map.groupBy(
    runs.filter((run) => run.subcommand === "push"),
    (run) => run.repo,
  );
  return (run) => pushes.get(run.repo)?.find((push) => push.ms >= run.ms)?.ms ?? null;
}

export function timelineOf(record: SignalRecord): Timeline {
  const sessions = new Map(record.sessions.map((session) => [session.id, session]));
  const rootOf = rootFinder(sessions);
  const repoOf = repoFinder(record.checkouts);
  const repoOfRoot = (root: string) => repoOf(sessions.get(root)?.project ?? null);
  const { prompts, ownerTyped, pending } = promptsByRoot(record);
  const keyOf = (root: string, index: number): TaskKey => TaskKey.parse(`${root}#${index}`);
  const taskKey = (root: string, at: number): TaskKey => keyOf(root, taskIndex(prompts.get(root) ?? [], at));

  const routes = new Map<TaskKey, string>();
  for (const read of record.routeReads) {
    const key = taskKey(rootOf(read.sessionId), ms(read.at));
    if (!routes.has(key)) routes.set(key, basename(read.path, extname(read.path)));
  }
  const routeOf = (key: TaskKey): string => routes.get(key) ?? NO_ROUTE;
  const inTask = (root: string, at: number): { readonly task: TaskKey; readonly route: string } => {
    const task = taskKey(root, at);
    return { task, route: routeOf(task) };
  };

  const runs: Run[] = record.gitRuns
    .flatMap((run) => {
      const repo = repoOf(run.dir);
      return repo === null ? [] : [{ ...run, repo, root: rootOf(run.sessionId), ms: ms(run.at) }];
    })
    .sort((a, b) => a.ms - b.ms);
  const onOrigin = pushesByRepo(runs);
  const commits = runs.filter((run) => run.subcommand === "commit");
  const lastOfRoot = new Map(commits.map((run) => [run.root, run]));
  const lastOfTask = new Map(commits.map((run) => [taskKey(run.root, run.ms), run]));

  const interrupts: Interrupt[] = pending.map((said) => {
    const root = rootOf(said.sessionId);
    return { ...said, sessionId: root, repo: repoOfRoot(root), ...inTask(root, ms(said.at)) };
  });

  const secondReadAsks: Ask[] = record.ownerMessages.flatMap((message) => {
    if (
      classify(message.text, message.agentBefore, message.midTurn).kind === "command" ||
      !asksSecondRead(message.text)
    )
      return [];
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

  const keyedTasks = [...prompts.entries()].flatMap(([root, list]) =>
    list.map((prompt, index) => {
      const key = keyOf(root, index);
      const last = lastOfTask.get(key) ?? null;
      const task: TaskOutcome = {
        at: prompt.at,
        sessionId: root,
        repo: last === null ? repoOfRoot(root) : last.repo,
        task: key,
        route: routeOf(key),
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
  }));

  const reviewerRuns: Placed[] = record.sessions.flatMap((session) => {
    if (namedKind(session) !== "reviewer" || session.start === null) return [];
    const root = rootOf(session.id);
    return [
      { at: session.start, sessionId: root, repo: repoOfRoot(root), ...inTask(root, ms(session.start)) },
    ];
  });

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

  const placeHook = <Kind extends string>({ row, kind }: { row: HookRow; kind: Kind }): Kinded<Kind> => {
    const root = rootOf(row.sessionId);
    const named = repoNamed(row);
    return {
      at: row.at,
      sessionId: root,
      repo: named === null ? repoOfRoot(root) : repoOf(named),
      ...inTask(root, ms(row.at)),
      kind,
    };
  };

  return {
    interrupts,
    secondReadAsks,
    tasks,
    commitRuns,
    reviewerRuns,
    steps,
    denials: judgeDenials(record.hookEvents).map(placeHook),
    reviews: reviewRounds(record.hookEvents).map(placeHook),
    blocks: blocksOf(record.hookEvents)
      .filter(({ row }) => hookLoggedTasks.has(taskKey(rootOf(row.sessionId), ms(row.at))))
      .map(placeHook),
    skillLoads,
    compactions,
    acceptedCommits,
    escapes,
    newest: record.newest,
  };
}
