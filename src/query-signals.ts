import { refuseQuery } from "./query-contract";
import { CAUSES } from "./query-interrupt";
import type { Placed, Timeline } from "./query-timeline";

export type SignalEvent<Kind extends string = string> = Placed & {
  readonly kind: Kind;
  readonly minutes: number | null;
  readonly text: string | null;
};

type Rate = { readonly value: number | null; readonly count: number; readonly of: number };

export type Signal = {
  readonly name: string;
  readonly value: string;
  readonly note: string;
  readonly kinds: readonly string[];
  readonly events: (timeline: Timeline) => readonly SignalEvent[];
  readonly rate: (events: readonly SignalEvent[]) => Rate;
};

type Definition<Kind extends string> = Omit<Signal, "kinds" | "events" | "rate"> & {
  readonly kinds: readonly Kind[];
  readonly events: (timeline: Timeline) => readonly SignalEvent<NoInfer<Kind>>[];
  readonly rate: (count: (kind: NoInfer<Kind>) => number, events: readonly SignalEvent[]) => Rate;
};

const HOUR_MS = 3_600_000;

const MINUTE_MS = 60_000;

const RATE_DECIMALS = 100;

function signalOf<Kind extends string>(definition: Definition<Kind>): Signal {
  return {
    ...definition,
    rate: (events) => definition.rate((kind) => events.filter((event) => event.kind === kind).length, events),
  };
}

const minutesBetween = (from: string, to: string): number =>
  Math.round((Date.parse(to) - Date.parse(from)) / MINUTE_MS);

const ratio = (count: number, of: number): number | null =>
  of === 0 ? null : Math.round((count / of) * RATE_DECIMALS) / RATE_DECIMALS;

function median(values: readonly number[]): number | null {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const upper = sorted[middle];
  if (upper === undefined) return null;
  const lower = sorted[middle - 1];
  return sorted.length % 2 === 1 || lower === undefined ? upper : Math.round((lower + upper) / 2);
}

function event<Kind extends string>(
  placed: Placed,
  kind: Kind,
  minutes: number | null = null,
  text: string | null = null,
): SignalEvent<Kind> {
  return {
    at: placed.at,
    sessionId: placed.sessionId,
    repo: placed.repo,
    route: placed.route,
    kind,
    minutes,
    text,
  };
}

const ownerInterrupts = signalOf({
  name: "owner-interrupts",
  value: "interrupts per task the owner typed in",
  note:
    "An interrupt is told from a task by a heuristic: the interrupted marker, a question mark near the end of what " +
    "the agent last said, an opening push-back word, or a short go-ahead.",
  kinds: ["task", ...CAUSES],
  events: (timeline) => [
    ...timeline.interrupts.map((interrupt) => event(interrupt, interrupt.cause, null, interrupt.text)),
    ...timeline.tasks.filter((task) => task.ownerTyped).map((task) => event(task, "task")),
  ],
  rate: (count) => {
    const interrupts = CAUSES.reduce((sum, cause) => sum + count(cause), 0);
    return { value: ratio(interrupts, count("task")), count: interrupts, of: count("task") };
  },
});

const timeToLand = signalOf({
  name: "time-to-land",
  value: "median minutes from a task prompt to its last commit run on origin",
  note: "On origin means a later push run in the same repo, from any session; a push run by hand is not seen.",
  kinds: ["landed", "not landed"] as const,
  events: (timeline) =>
    timeline.tasks.flatMap((task): readonly SignalEvent<"landed" | "not landed">[] => {
      if (task.lastCommitRun === null) return [];
      if (task.landedAt === null) return [event(task, "not landed")];
      return [event(task, "landed", minutesBetween(task.at, task.landedAt))];
    }),
  rate: (count, events) => ({
    value: median(events.flatMap((e) => (e.kind === "landed" && e.minutes !== null ? [e.minutes] : []))),
    count: count("landed"),
    of: count("landed") + count("not landed"),
  }),
});

const strandedWork = signalOf({
  name: "stranded-work",
  value: "share of commit runs not on origin within the hour",
  note:
    "Only commit runs an hour older than the newest message count. Ended unpushed stands in for a session " +
    "archived with unpushed commits.",
  kinds: ["pushed", "stranded", "ended unpushed"] as const,
  events: (timeline) =>
    timeline.commitRuns.flatMap((run): readonly SignalEvent<"pushed" | "stranded" | "ended unpushed">[] => {
      if (timeline.newest === null || Date.parse(timeline.newest) - Date.parse(run.at) <= HOUR_MS) return [];
      if (run.onOriginAt === null) return [event(run, run.lastOfSession ? "ended unpushed" : "stranded")];
      const pushedAfter = Date.parse(run.onOriginAt) - Date.parse(run.at);
      return [
        event(run, pushedAfter <= HOUR_MS ? "pushed" : "stranded", minutesBetween(run.at, run.onOriginAt)),
      ];
    }),
  rate: (count) => {
    const stranded = count("stranded") + count("ended unpushed");
    const of = stranded + count("pushed");
    return { value: ratio(stranded, of), count: stranded, of };
  },
});

const reviewLoops = signalOf({
  name: "review-loops",
  value: "reviewer runs per commit run",
  note: "Verdicts and rounds to accept wait on the hook event log; this counts reviewer subagents started.",
  kinds: ["reviewer run", "commit run"] as const,
  events: (timeline) => [
    ...timeline.reviewerRuns.map((run) => event(run, "reviewer run")),
    ...timeline.commitRuns.map((run) => event(run, "commit run")),
  ],
  rate: (count) => ({
    value: ratio(count("reviewer run"), count("commit run")),
    count: count("reviewer run"),
    of: count("commit run"),
  }),
});

export const SIGNALS: readonly Signal[] = [ownerInterrupts, timeToLand, strandedWork, reviewLoops];

export function signalNamed(name: string): Signal {
  const signal = SIGNALS.find((candidate) => candidate.name === name);
  if (signal === undefined)
    throw refuseQuery("unknown_signal", { name, signals: SIGNALS.map((s) => s.name) });
  return signal;
}
