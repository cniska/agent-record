import { FINDING_KINDS } from "./ingest-event-kinds";
import { refuseQuery } from "./query-contract";
import { ESCAPE_CAUSES, ESCAPE_REACH_DAYS, GATE_REACH_MINUTES } from "./query-escaped-defects";
import {
  BLOCK_SOURCES,
  isFalseStop,
  JUDGEMENTS,
  type Judgement,
  PENDING,
  REVIEW_KINDS,
} from "./query-hook-timeline";
import { CAUSES } from "./query-interrupt";
import { HASH_SHOWN, UNKNOWN_PART, versionOf } from "./query-skill-version";
import type { Placed, Timeline } from "./query-timeline";
import { HOUR_MS, MINUTE_MS } from "./timestamp";

export type SignalEvent<Kind extends string = string> = Placed & {
  readonly kind: Kind;
  readonly minutes: number | null;
  readonly text: string | null;
  readonly version: string | null;
  readonly rule: string | null;
};

type Rate = { readonly value: number | null; readonly count: number; readonly of: number };

type Measured = {
  readonly events: readonly SignalEvent[];
  readonly rate: (subset: readonly SignalEvent[]) => Rate;
  readonly detail: (subset: readonly SignalEvent[]) => string | null;
};

export type Signal = {
  readonly name: string;
  readonly value: string;
  readonly note: string;
  readonly kinds: readonly string[];
  readonly measure: (timeline: Timeline) => Measured;
};

type Definition<Kind extends string, Details extends object> = Omit<Signal, "kinds" | "measure"> & {
  readonly kinds: readonly Kind[];
  readonly events: (timeline: Timeline) => readonly (SignalEvent<NoInfer<Kind>> & NoInfer<Details>)[];
  readonly rate: (
    count: (kind: NoInfer<Kind>) => number,
    events: readonly (SignalEvent & NoInfer<Details>)[],
  ) => Rate;
  readonly detail?: (events: readonly (SignalEvent & NoInfer<Details>)[]) => string | null;
};

const RATE_DECIMALS = 100;

const SHA_SHOWN = 8;

function signalOf<Kind extends string, Details extends object = Record<never, never>>(
  definition: Definition<Kind, Details>,
): Signal {
  const { events: eventsOf, rate, detail, ...described } = definition;
  return {
    ...described,
    measure: (timeline) => {
      const events = eventsOf(timeline);
      const kept = (subset: readonly SignalEvent[]) => {
        const members = new Set<SignalEvent>(subset);
        return events.filter((event) => members.has(event));
      };
      return {
        events,
        rate: (subset) => {
          const picked = kept(subset);
          return rate((kind) => picked.filter((event) => event.kind === kind).length, picked);
        },
        detail: (subset) => (detail === undefined ? null : detail(kept(subset))),
      };
    },
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
    task: placed.task,
    sessionId: placed.sessionId,
    repo: placed.repo,
    tags: placed.tags,
    kind,
    minutes,
    text,
    version: null,
    rule: null,
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
  value: "median minutes from a task prompt to its last commit run on origin/main",
  note:
    "On origin/main means a later push run in the same repo, from any session, that lands: a push to main from " +
    "any checkout, or a bare or HEAD push from the repo's main checkout, carrying the runs of its own checkout " +
    "and, after a main-checkout merge, rebase or reset naming a worktree's branch, that worktree's. A worktree's " +
    "branch is the one its push names, or the worktree's name when it pushes HEAD. A task whose branch was " +
    "pushed but never landed is not landed. A push run by hand, a pull request merge and a default branch not " +
    "named main are not seen.",
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
  value:
    "share of judged commit runs, one standing for a slice's commits, not on origin/main within the hour",
  note:
    "A judged commit run is one no later commit run of its slice, a worktree or a task in the main checkout, " +
    "follows before it lands on origin/main (see time-to-land for what lands); the earlier ones land with it. " +
    "Only commit runs an hour older than the newest message count. Ended unlanded stands in for a session " +
    "archived with its last slice not on origin/main. A worktree's branch is the one its push names, or the " +
    "worktree's name when it pushes HEAD.",
  kinds: ["landed", "stranded", "ended unlanded"] as const,
  events: (timeline) =>
    timeline.commitRuns.flatMap((run): readonly SignalEvent<"landed" | "stranded" | "ended unlanded">[] => {
      if (!run.standsForSlice) return [];
      if (timeline.newest === null || Date.parse(timeline.newest) - Date.parse(run.at) <= HOUR_MS) return [];
      if (run.onOriginAt === null) return [event(run, run.lastOfSession ? "ended unlanded" : "stranded")];
      const landedAfter = Date.parse(run.onOriginAt) - Date.parse(run.at);
      return [
        event(run, landedAfter <= HOUR_MS ? "landed" : "stranded", minutesBetween(run.at, run.onOriginAt)),
      ];
    }),
  rate: (count) => {
    const stranded = count("stranded") + count("ended unlanded");
    const of = stranded + count("landed");
    return { value: ratio(stranded, of), count: stranded, of };
  },
});

const CITED = "cited";

const reviewFindings = signalOf({
  name: "review-findings",
  value: "findings per verdict that counted its findings",
  note:
    "A verdict line counts here only when it carries its findings, so a verdict before its workflow counted " +
    "them is not seen. Each finding counts by its kind, each conflict once. --by rule puts each rule a finding " +
    `cites in that rule's row, as ${CITED}; findings and verdicts fall in no rule.`,
  kinds: ["verdict", ...FINDING_KINDS, "conflict", CITED],
  events: (timeline) =>
    timeline.countedVerdicts.flatMap((counted) => [
      event(counted, "verdict"),
      ...FINDING_KINDS.flatMap((kind) =>
        Array.from({ length: counted.findings[kind] }, () => event(counted, kind)),
      ),
      ...Array.from({ length: counted.conflicts }, () => event(counted, "conflict")),
      ...counted.rules.map((rule) => ({ ...event(counted, CITED, null, rule), rule })),
    ]),
  rate: (count) => {
    const findings = FINDING_KINDS.reduce((sum, kind) => sum + count(kind), 0);
    return { value: ratio(findings, count("verdict")), count: findings, of: count("verdict") };
  },
});

const falseStops = signalOf<Judgement>({
  name: "false-stops",
  value: "share of judged gate stops the work got past with nothing a gate checks changed",
  note:
    "A stop is a gate denial, an agent's retry of the same denial counted once; an auto-mode denial is not " +
    "one. A commit-gate stop is false when the same agent later committed in its repo with no review between; " +
    "one carrying a fingerprint is upheld. A verdict-gate stop is never false: it is unfixed when the agent " +
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
    "first wrote it.",
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

const skillUsage = signalOf<string>({
  name: "skill-usage",
  value: "skill loads per task, each named by its skill and version",
  note:
    `A version is the first ${HASH_SHOWN} characters of the skill body's hash and the plugin install it was ` +
    `loaded from, ${UNKNOWN_PART} where the load carried no body or came from outside the plugin cache. ` +
    "A load counts in its top-level " +
    "session's task, a subagent's preload too.",
  kinds: ["task"],
  events: (timeline) => [
    ...timeline.skillLoads.map((load) => {
      const version = `${load.skill} ${versionOf(load)}`;
      return { ...event(load, version), version };
    }),
    ...timeline.tasks.map((task) => event(task, "task")),
  ],
  rate: (count, events) => {
    const loads = events.length - count("task");
    return { value: ratio(loads, count("task")), count: loads, of: count("task") };
  },
});

const lostContext = signalOf({
  name: "lost-context",
  value: "files read again after a compaction per compaction",
  note:
    "A re-read is a file the session read before a compaction, since the one before it, and read again after " +
    "it, before the next; each file counts once per compaction. Only Claude Code's compactions count: Codex " +
    "reads files through the shell, which keeps no path, and the other tools mark none.",
  kinds: ["compaction", "re-read"] as const,
  events: (timeline) =>
    timeline.compactions.flatMap((compaction): readonly SignalEvent<"compaction" | "re-read">[] => [
      event(compaction, "compaction"),
      ...compaction.rereads.map((reread) =>
        event(compaction, "re-read", minutesBetween(compaction.at, reread.at), reread.path),
      ),
    ]),
  rate: (count) => ({
    value: ratio(count("re-read"), count("compaction")),
    count: count("re-read"),
    of: count("compaction"),
  }),
});

const escapedDefects = signalOf({
  name: "escaped-defects",
  value: "fix commits that point back at an earlier commit per accepted commit",
  note:
    `A commit counts when a commit-gate allow in its repo came at most ${GATE_REACH_MINUTES} minutes before it; ` +
    "an accepted commit is one whose allow was accepted. A fix escaped when its subject names an earlier commit, " +
    `or when the latest accepted feat, fix, refactor or perf commit in the ${ESCAPE_REACH_DAYS} days before it that shares a file, ` +
    "tests and root Markdown aside, came from another agent. Read the events: a fix that adds a rule counts too.",
  kinds: ["accepted commit", ...ESCAPE_CAUSES],
  events: (timeline) => [
    ...timeline.acceptedCommits.map((commit) =>
      event(commit, "accepted commit", null, commit.sha.slice(0, SHA_SHOWN)),
    ),
    ...timeline.escapes.map((escaped) =>
      event(
        escaped,
        escaped.cause,
        minutesBetween(escaped.earlierAt, escaped.at),
        `${escaped.sha.slice(0, SHA_SHOWN)} ${escaped.subject} <- ${escaped.earlier.slice(0, SHA_SHOWN)}`,
      ),
    ),
  ],
  rate: (count) => {
    const escaped = ESCAPE_CAUSES.reduce((sum, cause) => sum + count(cause), 0);
    return { value: ratio(escaped, count("accepted commit")), count: escaped, of: count("accepted commit") };
  },
});

const TENTHS = 10;

const STEPS_SHOWN = 5;

const tenths = (value: number): number => Math.round(value * TENTHS) / TENTHS;

const perCommit = (total: number, of: number): number | null => (of === 0 ? null : Math.round(total / of));

type StepSpend = { readonly output: number; readonly input: number; readonly accepted: number };

type StepEvent = SignalEvent & StepSpend;

const acceptedOf = (events: readonly StepEvent[]): number =>
  [...new Map(events.map((e) => [e.task, e.accepted])).values()].reduce((sum, n) => sum + n, 0);

const summed = (events: readonly StepEvent[]) =>
  events.reduce(
    (sum, e) => ({
      output: sum.output + e.output,
      input: sum.input + e.input,
      minutes: sum.minutes + (e.minutes ?? 0),
    }),
    { output: 0, input: 0, minutes: 0 },
  );

const stepCost = signalOf<string, StepSpend>({
  name: "step-cost",
  value: "input tokens with cache reads and writes per accepted commit, over every step of every loop",
  note:
    "A step is a subagent's namespaced agent type after its colon, or else the skill the session loaded last, " +
    "preloads aside, and before its first a subagent's agent type or none. " +
    "Each response costs its output and its input with cache reads and writes, and its minutes since the later " +
    "of the session's previous response, its start, the owner's last message and a subagent's last return " +
    "there, so a wait on the owner or a subagent counts in neither. An event is a stretch of one session's " +
    "responses on one step. Steps in one task share its accepted commits, those escaped-defects counts. " +
    "Subagent transcripts record too little output, so input is the value.",
  kinds: [],
  events: (timeline) => {
    const accepted = new Map<string, number>();
    for (const commit of timeline.acceptedCommits)
      accepted.set(commit.task, (accepted.get(commit.task) ?? 0) + 1);
    return timeline.steps.map((step) => ({
      ...event(
        step,
        step.step,
        tenths(step.minutes),
        `output ${step.output}, input ${step.input}, ${step.version ?? UNKNOWN_PART}`,
      ),
      version: step.version,
      output: step.output,
      input: step.input,
      accepted: accepted.get(step.task) ?? 0,
    }));
  },
  rate: (_count, events) => {
    const of = acceptedOf(events);
    const input = summed(events).input;
    return { value: perCommit(input, of), count: input, of };
  },
  detail: (events) => {
    if (events.length === 0) return null;
    const of = acceptedOf(events);
    const total = summed(events);
    const tasks = new Set(events.map((e) => e.task)).size;
    const steps = [...Map.groupBy(events, (e) => e.kind)]
      .map(([step, list]) => ({ step, input: summed(list).input }))
      .sort((a, b) => b.input - a.input)
      .slice(0, STEPS_SHOWN)
      .map(({ step, input }) => `${step} ${perCommit(input, of)}`)
      .join(", ");
    return (
      `per accepted commit output ${perCommit(total.output, of)}, minutes ${of === 0 ? null : tenths(total.minutes / of)}; ` +
      `per task over ${tasks} tasks input ${Math.round(total.input / tasks)}, output ${Math.round(total.output / tasks)}, ` +
      `minutes ${tenths(total.minutes / tasks)}; most input per accepted commit: ${steps}`
    );
  },
});

const secondReadAsks = signalOf({
  name: "second-read-asks",
  value: "asks for another model's read per task the owner typed in",
  note:
    "An ask is an owner message, pasted blocks and a pasted Markdown document aside, that asks for Fable, a " +
    "second opinion, a second read or a stronger model: an ask, have, get or similar verb before Fable, Fable " +
    "followed by to, should, agrees, design, plan, review or similar, what Fable thinks, or the phrase itself.",
  kinds: ["task", "ask"] as const,
  events: (timeline) => [
    ...timeline.secondReadAsks.map((ask) => event(ask, "ask", null, ask.text)),
    ...timeline.tasks.filter((task) => task.ownerTyped).map((task) => event(task, "task")),
  ],
  rate: (count) => ({ value: ratio(count("ask"), count("task")), count: count("ask"), of: count("task") }),
});

export const SIGNALS: readonly Signal[] = [
  ownerInterrupts,
  timeToLand,
  strandedWork,
  reviewFindings,
  falseStops,
  reviewReturns,
  blocks,
  skillUsage,
  lostContext,
  escapedDefects,
  stepCost,
  secondReadAsks,
];

export function signalNamed(name: string): Signal {
  const signal = SIGNALS.find((candidate) => candidate.name === name);
  if (signal === undefined)
    throw refuseQuery("unknown_signal", { name, signals: SIGNALS.map((s) => s.name) });
  return signal;
}
