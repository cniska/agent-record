import { refuseQuery } from "./query-contract";
import {
  BLOCK_SOURCES,
  isFalseStop,
  JUDGEMENTS,
  type Judgement,
  PENDING,
  REVIEW_KINDS,
} from "./query-hook-timeline";
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
  note:
    "This counts reviewer subagents started and reaches back past the hook event log; review-returns counts " +
    "the verdicts.",
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

const falseStops = signalOf<Judgement>({
  name: "false-stops",
  value: "share of judged gate stops the work got past with nothing a gate checks changed",
  note:
    "A stop is a gate denial, an agent's retry of the same denial counted once; an auto-mode denial is not " +
    "one. A commit-gate stop is false when the same agent later committed in its repo with no review between; " +
    "one carrying a fingerprint is upheld. A verdict-gate stop is never false: it is unfixed when the reviewer " +
    "ended on the gate's allow. A stop with nothing after it in its session is pending. An owner override " +
    "leaves no line, so its stop is judged by what the agent did next. The hook event log starts when the " +
    "plugin first wrote it.",
  kinds: JUDGEMENTS,
  events: (timeline) => timeline.denials.map((denial) => event(denial, denial.kind)),
  rate: (count, events) => {
    const judged = events.length - count(PENDING);
    const falseStopCount = events.filter((judgedEvent) => isFalseStop(judgedEvent.kind)).length;
    return { value: ratio(falseStopCount, judged), count: falseStopCount, of: judged };
  },
});

const reviewReturns = signalOf({
  name: "review-returns",
  value: "return verdicts per reviewed commit",
  note:
    "A reviewed commit is a commit-gate allow after an accept for its repo in its session; its returns are " +
    "the returns since that session's previous allow there. The hook event log starts when the plugin " +
    "first wrote it; review-loops reaches back further.",
  kinds: REVIEW_KINDS,
  events: (timeline) => timeline.reviews.map((review) => event(review, review.kind)),
  rate: (count) => ({
    value: ratio(count("return"), count("reviewed commit")),
    count: count("return"),
    of: count("reviewed commit"),
  }),
});

const blocks = signalOf({
  name: "blocks",
  value: "blocks per task, by source",
  note:
    "A block is a permission prompt, an auto-mode denial, or a commit-gate or verdict-gate denial. Blocks " +
    "and tasks are those of the Claude Code tasks given since the first hook event.",
  kinds: ["task", ...BLOCK_SOURCES],
  events: (timeline) => [
    ...timeline.blocks.map((block) => event(block, block.kind)),
    ...timeline.tasks.filter((task) => task.hookLogged).map((task) => event(task, "task")),
  ],
  rate: (count) => {
    const blocked = BLOCK_SOURCES.reduce((sum, source) => sum + count(source), 0);
    return { value: ratio(blocked, count("task")), count: blocked, of: count("task") };
  },
});

export const SIGNALS: readonly Signal[] = [
  ownerInterrupts,
  timeToLand,
  strandedWork,
  reviewLoops,
  falseStops,
  reviewReturns,
  blocks,
];

export function signalNamed(name: string): Signal {
  const signal = SIGNALS.find((candidate) => candidate.name === name);
  if (signal === undefined)
    throw refuseQuery("unknown_signal", { name, signals: SIGNALS.map((s) => s.name) });
  return signal;
}
