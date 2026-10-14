import { countFlag, timeFlag } from "./query";
import { type Query, refuseQuery } from "./query-contract";
import { scoped, skillScope, viewRecord } from "./query-signal-view";
import { SIGNALS } from "./query-signals";
import { versionOf } from "./query-skill-version";
import type { Placed, SkillLoaded } from "./query-timeline";
import { DAY_MS, EpochMs } from "./timestamp";

const DEFAULT_DAYS = 14;

type Found = { readonly sha: string; readonly ts: string };

const within = <Item extends Placed>(items: readonly Item[], from: number, until: number): readonly Item[] =>
  items.filter((item) => {
    const at = Date.parse(item.at);
    return at >= from && at < until;
  });

function versionCounts(loads: readonly SkillLoaded[]): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();
  for (const load of loads) counts.set(versionOf(load), (counts.get(versionOf(load)) ?? 0) + 1);
  return counts;
}

const listed = (counts: ReadonlyMap<string, number>): string =>
  counts.size === 0
    ? "none"
    : [...counts]
        .sort(([, a], [, b]) => b - a)
        .map(([version, count]) => `${version} ${count}`)
        .join(", ");

function installNote(skill: string, before: ReadonlyMap<string, number>, after: ReadonlyMap<string, number>) {
  if (after.size === 0) return `No task of the after window loaded ${skill}.`;
  if (before.size === 0 || [...after.keys()].some((version) => !before.has(version))) return null;
  return `Not installed yet: the after window ran only versions of ${skill} the before window ran.`;
}

export const beforeAfter: Query<"days" | "from" | "skill"> = {
  name: "before-after",
  summary: "compare every signal over the days before a commit with the days after it",
  usage:
    "agent-record query before-after <sha-prefix> [--days <n>] [--from <ts>] [--skill <name>] [--rows <n>]",
  flags: ["days", "from", "skill"],
  run: (db, ctx) => {
    const prefix = ctx.arg.toLowerCase();
    const days = ctx.flags.days === undefined ? DEFAULT_DAYS : countFlag("days", ctx.flags.days);
    const from = ctx.flags.from === undefined ? null : timeFlag("from", ctx.flags.from);
    const found = db
      .query<Found, [string]>("SELECT sha, ts FROM repo_commit WHERE instr(sha, ?) = 1 ORDER BY sha LIMIT 2")
      .all(prefix);
    const [commit, other] = found;
    if (commit === undefined) throw refuseQuery("unknown_commit", { prefix: ctx.arg });
    if (other !== undefined) {
      throw refuseQuery("ambiguous_commit", { prefix: ctx.arg, matches: found.map((f) => f.sha) });
    }
    const at = Date.parse(commit.ts);
    if (from !== null && Date.parse(from) < at) {
      throw refuseQuery("from_before_commit", { from, sha: commit.sha, at: commit.ts });
    }
    const span = days * DAY_MS;
    const { timeline } = viewRecord(db);
    const scope = skillScope(timeline, ctx.flags.skill);
    const newest = timeline.newest === null ? at : Date.parse(timeline.newest);
    const start = from === null ? at : Date.parse(from);
    const end = Math.max(start, Math.min(start + span, newest + 1));
    const rows = SIGNALS.map((chosen) => {
      const measured = chosen.measure(timeline);
      const events = scoped(scope, measured.events);
      const before = measured.rate(within(events, at - span, at));
      const after = measured.rate(within(events, start, end));
      return [
        chosen.name,
        chosen.value,
        before.value,
        after.value,
        before.count,
        before.of,
        after.count,
        after.of,
      ];
    });
    const partial =
      end - start < span
        ? `The after window is ${Math.round((end - start) / DAY_MS)} of ${days} days so far; compare the rates, not the counts.`
        : null;
    const windows =
      `commit ${commit.sha} at ${commit.ts}; before ${EpochMs.parse(at - span)} to ${commit.ts}, ` +
      `after ${EpochMs.parse(start)} to ${EpochMs.parse(end)}`;
    const columns = [
      "signal",
      "value",
      "before",
      "after",
      "before_count",
      "before_of",
      "after_count",
      "after_of",
    ];
    if (scope === null) return { columns, rows, denominator: windows, note: partial };
    const ranBefore = versionCounts(within(scope.loads, at - span, at));
    const ranAfter = versionCounts(within(scope.loads, start, end));
    const notes = [partial, installNote(scope.skill, ranBefore, ranAfter)].filter((note) => note !== null);
    return {
      columns,
      rows,
      denominator: `${windows}; ${scope.shown}, versions before ${listed(ranBefore)}, after ${listed(ranAfter)}`,
      note: notes.length === 0 ? null : notes.join(" "),
    };
  },
};
