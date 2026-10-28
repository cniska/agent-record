import { type Cell, type Query, refuseQuery } from "./query-contract";
import { described, repoShown, scoped, skillScope, viewRecord } from "./query-signal-view";
import { type Signal, type SignalEvent, signalNamed } from "./query-signals";
import { unprintableColumn } from "./query-table";

type Grouped = {
  readonly columns: readonly string[];
  readonly key: (event: SignalEvent, labels: ReadonlyMap<string, string>, home: string) => readonly Cell[];
};

const BUILT_IN = {
  week: { columns: ["week"], key: (event) => [weekOf(event.at)] },
  repo: {
    columns: ["week", "repo", "label"],
    key: (event, labels, home) => [
      weekOf(event.at),
      repoShown(event.repo, home),
      event.repo === null ? null : (labels.get(event.repo) ?? null),
    ],
  },
  version: { columns: ["week", "version"], key: (event) => [weekOf(event.at), event.version] },
  rule: { columns: ["week", "rule"], key: (event) => [weekOf(event.at), event.rule] },
} as const satisfies Readonly<Record<string, Grouped>>;

type BuiltIn = keyof typeof BUILT_IN;

const BUILT_INS = Object.keys(BUILT_IN);

const isBuiltIn = (by: string): by is BuiltIn => Object.hasOwn(BUILT_IN, by);

const UNTAGGED = "none";

const taggedBy = (tag: string): Grouped => ({
  columns: ["week", tag],
  key: (event) => [weekOf(event.at), event.tags.get(tag) ?? UNTAGGED],
});

const RATE_COLUMNS = ["value", "count", "of", "kinds"];

const MONDAY_OFFSET = 6;

const DAYS_IN_WEEK = 7;

const DATE_CHARS = 10;

function groupingOf(by: string | undefined, tagKeys: readonly string[]): Grouped {
  if (by === undefined) return BUILT_IN.week;
  if (isBuiltIn(by)) return BUILT_IN[by];
  const tagGroupings = tagKeys.filter(
    (key) => !isBuiltIn(key) && unprintableColumn([...taggedBy(key).columns, ...RATE_COLUMNS]) === null,
  );
  if (tagGroupings.includes(by)) return taggedBy(by);
  throw refuseQuery("unknown_grouping", { by, groupings: [...BUILT_INS, ...tagGroupings] });
}

function weekOf(at: string): string {
  const day = new Date(Date.parse(at));
  day.setUTCDate(day.getUTCDate() - ((day.getUTCDay() + MONDAY_OFFSET) % DAYS_IN_WEEK));
  return day.toISOString().slice(0, DATE_CHARS);
}

function kindsOf(signal: Signal, events: readonly SignalEvent[]): string {
  return [...new Set([...signal.kinds, ...events.map((event) => event.kind)])]
    .map((kind) => ({ kind, count: events.filter((event) => event.kind === kind).length }))
    .filter(({ count }) => count > 0)
    .toSorted((a, b) => b.count - a.count)
    .map(({ kind, count }) => `${kind} ${count}`)
    .join(", ");
}

export const signal: Query<"by" | "skill"> = {
  name: "signal",
  summary:
    "count one friction signal per week, or per week and repo, version, rule or tag, or in the tasks that loaded a skill",
  usage:
    "agent-record query signal <name> [--by <week|repo|version|rule|tag key>] [--skill <name>] [--rows <n>]",
  flags: ["by", "skill"],
  run: (db, ctx) => {
    const chosen = signalNamed(ctx.arg);
    const { timeline, labels } = viewRecord(db);
    const grouping = groupingOf(ctx.flags.by, timeline.tagKeys);
    const scope = skillScope(timeline, ctx.flags.skill);
    const measured = chosen.measure(timeline);
    const events = scoped(scope, measured.events);
    const groups = new Map<string, { readonly key: readonly Cell[]; readonly events: SignalEvent[] }>();
    for (const event of events) {
      const key = grouping.key(event, labels, ctx.home);
      const id = JSON.stringify(key);
      const group = groups.get(id);
      if (group === undefined) groups.set(id, { key, events: [event] });
      else group.events.push(event);
    }
    const rows = [...groups.values()]
      .map(({ key, events: grouped }) => ({
        key,
        size: grouped.length,
        rate: measured.rate(grouped),
        kinds: [kindsOf(chosen, grouped), measured.detail(grouped)]
          .filter((part) => part !== null)
          .join("; "),
      }))
      .toSorted(
        (a, b) =>
          String(b.key[0]).localeCompare(String(a.key[0])) ||
          b.rate.of - a.rate.of ||
          b.rate.count - a.rate.count ||
          b.size - a.size,
      )
      .map(({ key, rate, kinds }) => [...key, rate.value, rate.count, rate.of, kinds]);
    const weeks = new Set(events.map((event) => weekOf(event.at))).size;
    return {
      columns: [...grouping.columns, ...RATE_COLUMNS],
      rows,
      denominator:
        `${described(chosen)}; ${events.length} events over ${weeks} weeks (Monday, UTC)` +
        (scope === null ? "" : `, ${scope.shown}`),
      note: chosen.note,
    };
  },
};
