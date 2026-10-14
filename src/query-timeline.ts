import { basename, extname } from "node:path";
import { z } from "zod";
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
import type { CheckoutRow, GitRunRow, HookRow, SessionRow, SignalRecord } from "./query-signal-record";
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

type TaskOutcome = Placed & {
  readonly ownerTyped: boolean;
  readonly hookLogged: boolean;
  readonly lastCommitRun: string | null;
  readonly landedAt: string | null;
};

type CommitRun = Placed & { readonly onOriginAt: string | null; readonly lastOfSession: boolean };

type Kinded<Kind extends string> = Placed & { readonly kind: Kind };

export type SkillLoaded = Placed & {
  readonly skill: string;
  readonly sha256: string | null;
  readonly install: string | null;
};

export type Timeline = {
  readonly interrupts: readonly Interrupt[];
  readonly tasks: readonly TaskOutcome[];
  readonly commitRuns: readonly CommitRun[];
  readonly reviewerRuns: readonly Placed[];
  readonly denials: readonly Kinded<Judged["kind"]>[];
  readonly reviews: readonly Kinded<Reviewed["kind"]>[];
  readonly blocks: readonly Kinded<Blocked["kind"]>[];
  readonly skillLoads: readonly SkillLoaded[];
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
  const prompts = new Map<string, Prompt[]>();
  const add = (root: string, at: string) => {
    const prompt = { at, ms: ms(at) };
    const known = prompts.get(root);
    if (known === undefined) prompts.set(root, [prompt]);
    else known.push(prompt);
  };
  for (const session of record.sessions) {
    if (session.parentId === null && session.start !== null) add(session.id, session.start);
  }
  const ownerTyped = new Set<string>();
  const pending: Pending[] = [];
  for (const message of record.ownerMessages) {
    const said = classify(message.text, message.agentBefore);
    if (said.kind === "command") continue;
    ownerTyped.add(message.sessionId);
    if (said.kind === "interrupt") pending.push({ ...message, cause: said.cause });
    else if (message.agentBefore !== null) add(message.sessionId, message.at);
  }
  for (const rejection of record.rejections) pending.push({ ...rejection, cause: "permission", text: null });
  for (const list of prompts.values()) list.sort((a, b) => a.ms - b.ms);
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
  const pushes = new Map<string, number[]>();
  for (const run of runs) {
    if (run.subcommand !== "push") continue;
    const known = pushes.get(run.repo);
    if (known === undefined) pushes.set(run.repo, [run.ms]);
    else known.push(run.ms);
  }
  return (run) => pushes.get(run.repo)?.find((push) => push >= run.ms) ?? null;
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
    if (!session.isReviewer || session.start === null) return [];
    const root = rootOf(session.id);
    return [
      {
        at: session.start,
        sessionId: root,
        repo: repoOfRoot(root),
        ...inTask(root, ms(session.start)),
      },
    ];
  });

  const skillLoads: SkillLoaded[] = record.skillLoads.map((load) => {
    const root = rootOf(load.sessionId);
    return {
      at: load.at,
      sessionId: root,
      repo: repoOfRoot(root),
      ...inTask(root, ms(load.at)),
      skill: load.skill,
      sha256: load.sha256,
      install: load.install,
    };
  });

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
    tasks,
    commitRuns,
    reviewerRuns,
    denials: judgeDenials(record.hookEvents).map(placeHook),
    reviews: reviewRounds(record.hookEvents).map(placeHook),
    blocks: blocksOf(record.hookEvents)
      .filter(({ row }) => hookLoggedTasks.has(taskKey(rootOf(row.sessionId), ms(row.at))))
      .map(placeHook),
    skillLoads,
    newest: record.newest,
  };
}
