import { type Cell, type Query, refuseQuery } from "./query-contract";
import { described, repoShown, viewRecord } from "./query-signal-view";
import { type Signal, type SignalEvent, signalNamed } from "./query-signals";

type Grouped = {
  readonly columns: readonly string[];
  readonly key: (event: SignalEvent, labels: ReadonlyMap<string, string>, home: string) => readonly Cell[];
};

const GROUPED_BY = {
  week: { columns: ["week"], key: (event) => [weekOf(event.at)] },
  repo: {
    columns: ["week", "repo", "label"],
    key: (event, labels, home) => [
      weekOf(event.at),
      repoShown(event.repo, home),
      event.repo === null ? null : (labels.get(event.repo) ?? null),
    ],
  },
  route: { columns: ["week", "route"], key: (event) => [weekOf(event.at), event.route] },
} as const satisfies Readonly<Record<string, Grouped>>;

type Grouping = keyof typeof GROUPED_BY;

const GROUPINGS = Object.keys(GROUPED_BY);

const isGrouping = (by: string): by is Grouping => Object.hasOwn(GROUPED_BY, by);

const RATE_COLUMNS = ["value", "count", "of", "kinds"];

const MONDAY_OFFSET = 6;

const DAYS_IN_WEEK = 7;

const DATE_CHARS = 10;

function groupingOf(by: string | undefined): Grouping {
  if (by === undefined) return "week";
  if (!isGrouping(by)) throw refuseQuery("unknown_grouping", { by, groupings: GROUPINGS });
  return by;
}

function weekOf(at: string): string {
  const day = new Date(Date.parse(at));
  day.setUTCDate(day.getUTCDate() - ((day.getUTCDay() + MONDAY_OFFSET) % DAYS_IN_WEEK));
  return day.toISOString().slice(0, DATE_CHARS);
}

function kindsOf(signal: Signal, events: readonly SignalEvent[]): string {
  return signal.kinds
    .map((kind) => ({ kind, count: events.filter((event) => event.kind === kind).length }))
    .filter(({ count }) => count > 0)
    .sort((a, b) => b.count - a.count)
    .map(({ kind, count }) => `${kind} ${count}`)
    .join(", ");
}

export const signal: Query<"by"> = {
  name: "signal",
  summary: "count one friction signal per week, or per week and repo or route",
  usage: "agent-record query signal <name> [--by <week|repo|route>] [--rows <n>]",
  flags: ["by"],
  run: (db, ctx) => {
    const chosen = signalNamed(ctx.arg);
    const by = groupingOf(ctx.flags.by);
    const { timeline, labels } = viewRecord(db);
    const events = chosen.events(timeline);
    const groups = new Map<string, { readonly key: readonly Cell[]; readonly events: SignalEvent[] }>();
    for (const event of events) {
      const key = GROUPED_BY[by].key(event, labels, ctx.home);
      const id = JSON.stringify(key);
      const group = groups.get(id);
      if (group === undefined) groups.set(id, { key, events: [event] });
      else group.events.push(event);
    }
    const rows = [...groups.values()]
      .map(({ key, events: grouped }) => ({
        key,
        rate: chosen.rate(grouped),
        kinds: kindsOf(chosen, grouped),
      }))
      .sort((a, b) => String(b.key[0]).localeCompare(String(a.key[0])) || b.rate.of - a.rate.of)
      .map(({ key, rate, kinds }) => [...key, rate.value, rate.count, rate.of, kinds]);
    const weeks = new Set(events.map((event) => weekOf(event.at))).size;
    return {
      columns: [...GROUPED_BY[by].columns, ...RATE_COLUMNS],
      rows,
      denominator: `${described(chosen)}; ${events.length} events over ${weeks} weeks (Monday, UTC)`,
      note: chosen.note,
    };
  },
};
