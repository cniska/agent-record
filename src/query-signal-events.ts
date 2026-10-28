import type { Query } from "./query-contract";
import { described, repoShown, viewRecord } from "./query-signal-view";
import { type SignalEvent, signalNamed } from "./query-signals";

const TEXT_CHARS = 160;

const tagsShown = (tags: ReadonlyMap<string, string>): string | null =>
  tags.size === 0 ? null : [...tags].map(([key, value]) => `${key}=${value}`).join(", ");

const newestFirst = (events: readonly SignalEvent[]): readonly SignalEvent[] =>
  events.toSorted((a, b) => Date.parse(b.at) - Date.parse(a.at));

const cut = (text: string | null): string | null =>
  text === null ? null : text.slice(0, TEXT_CHARS).replaceAll("\n", " ");

export const signalEvents: Query = {
  name: "signal-events",
  summary: "list what one friction signal counted, newest first, to check it by hand",
  usage: "agent-record query signal-events <name> [--rows <n>]",
  flags: [],
  run: (db, ctx) => {
    const chosen = signalNamed(ctx.arg);
    const events = newestFirst(chosen.measure(viewRecord(db).timeline).events);
    return {
      columns: ["at", "kind", "repo", "tags", "minutes", "session", "text"],
      rows: events.map((event) => [
        event.at,
        event.kind,
        repoShown(event.repo, ctx.home),
        tagsShown(event.tags),
        event.minutes,
        event.sessionId,
        cut(event.text),
      ]),
      denominator: `${described(chosen)}; ${events.length} events`,
      note: `${chosen.note} Text is cut at ${TEXT_CHARS} characters; query thread <session> --at <at> reads around one.`,
    };
  },
};
