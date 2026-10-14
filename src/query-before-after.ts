import { countFlag, timeFlag } from "./query";
import { type Query, refuseQuery } from "./query-contract";
import { viewRecord } from "./query-signal-view";
import { SIGNALS, type SignalEvent } from "./query-signals";
import { EpochMs } from "./timestamp";

const DEFAULT_DAYS = 14;

const DAY_MS = 86_400_000;

type Found = { readonly sha: string; readonly ts: string };

const iso = (ms: number): string => EpochMs.parse(ms);

const eventsWithin = (events: readonly SignalEvent[], from: number, until: number): readonly SignalEvent[] =>
  events.filter((event) => {
    const at = Date.parse(event.at);
    return at >= from && at < until;
  });

export const beforeAfter: Query<"days" | "from"> = {
  name: "before-after",
  summary: "compare every signal over the days before a commit with the days after it",
  usage: "agent-record query before-after <sha-prefix> [--days <n>] [--from <ts>] [--rows <n>]",
  flags: ["days", "from"],
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
    const newest = timeline.newest === null ? at : Date.parse(timeline.newest);
    const start = from === null ? at : Date.parse(from);
    const end = Math.max(start, Math.min(start + span, newest + 1));
    const rows = SIGNALS.map((chosen) => {
      const events = chosen.events(timeline);
      const before = chosen.rate(eventsWithin(events, at - span, at));
      const after = chosen.rate(eventsWithin(events, start, end));
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
    return {
      columns: ["signal", "value", "before", "after", "before_count", "before_of", "after_count", "after_of"],
      rows,
      denominator:
        `commit ${commit.sha} at ${commit.ts}; before ${iso(at - span)} to ${commit.ts}, ` +
        `after ${iso(start)} to ${iso(end)}`,
      note:
        end - start < span
          ? `The after window is ${Math.round((end - start) / DAY_MS)} of ${days} days so far; compare the rates, not the counts.`
          : null,
    };
  },
};
