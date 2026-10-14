import type { Database } from "bun:sqlite";
import { invariant } from "./assert";
import { SAID, select, timeFlag } from "./query";
import { type Query, refuseQuery } from "./query-contract";
import { rowsToRead } from "./query-row-cap";
import type { Timestamp } from "./timestamp";

const TRANSCRIPT_READING_CHARS = 240;

const TOOL_OUTCOME = `CASE
  WHEN is_interrupted = 1 THEN ' → interrupted'
  WHEN exit_code IS NOT NULL AND exit_code <> 0 THEN ' → exit ' || exit_code
  WHEN is_error = 1 THEN ' → error'
  ELSE '' END`;

const TIMELINE = `WITH timeline AS (
  SELECT m.ts,
         CASE WHEN m.denial_kind IS NOT NULL THEN 'denied' ELSE 'said' END AS kind,
         CASE WHEN m.denial_kind IS NOT NULL THEN 2 ELSE 0 END AS rank,
         m.src_line AS line,
         m.role, coalesce(m.attribution_skill, '') AS skill,
         CASE WHEN m.denial_kind IS NOT NULL
              THEN 'denied (' || m.denial_kind || ')' || coalesce(': ' || m.user_feedback, '')
              ELSE m.text END AS text
  FROM message m
  WHERE m.session_id = ?1 AND (m.denial_kind IS NOT NULL OR (m.text IS NOT NULL AND ${SAID}))
  UNION ALL
  SELECT coalesce(ts_call, ts_result), 'tool', 1, src_line_call,
         'tool', coalesce(attribution_skill, ''),
         coalesce(tool_name, '(unnamed)') || coalesce(': ' || coalesce(command, file_path), '') || ${TOOL_OUTCOME}
  FROM tool_call WHERE session_id = ?1
)`;

const IN_ORDER = "ORDER BY ts, rank, line";

const SHOWN = `SELECT ts AS at, role, skill,
                      replace(substr(text, 1, ${TRANSCRIPT_READING_CHARS}), char(10), ' ') AS text`;

type Counts = {
  readonly said: number;
  readonly denied: number;
  readonly tool: number;
  readonly untimed: number;
  readonly upTo: number;
  readonly after: number;
};

function countsOf(db: Database, id: string, at: string | null): Counts {
  const counts = db
    .query<Counts, [string, string | null]>(
      `${TIMELINE} SELECT
         count(*) FILTER (WHERE kind = 'said') AS said,
         count(*) FILTER (WHERE kind = 'denied') AS denied,
         count(*) FILTER (WHERE kind = 'tool' AND ts IS NOT NULL) AS tool,
         count(*) FILTER (WHERE kind = 'tool' AND ts IS NULL) AS untimed,
         count(*) FILTER (WHERE ts <= ?2) AS upTo,
         count(*) FILTER (WHERE ts > ?2) AS after
       FROM timeline`,
    )
    .get(id, at);
  invariant(counts !== null, "a count returns one row");
  return counts;
}

function passageTime(at: string | undefined): Timestamp | null {
  return at === undefined ? null : timeFlag("at", at);
}

function unshown(earlier: number, later: number): string {
  if (earlier === 0 && later === 0) return "";
  return `; ${earlier} earlier and ${later} later rows not shown, --rows <n> to widen`;
}

export const thread: Query<"at"> = {
  name: "thread",
  summary: "read one session's exchange and the tool calls in it, or the stretch around a timestamp",
  usage: "agent-record query thread <id-prefix> [--at <ts>] [--rows <n>]",
  flags: ["at"],
  run: (db, ctx) => {
    const prefix = ctx.arg;
    const at = passageTime(ctx.flags.at);
    const found = db
      .query<{ id: string }, [string]>(
        "SELECT id FROM session WHERE instr(lower(id), lower(?)) = 1 ORDER BY id LIMIT 2",
      )
      .all(prefix);
    if (found.length > 1) {
      throw refuseQuery("ambiguous_session", { prefix, matches: found.map((session) => session.id) });
    }
    const whole = (id: string) =>
      select(db, `${TIMELINE} ${SHOWN} FROM timeline WHERE ts IS NOT NULL ${IN_ORDER} LIMIT ?2`, [
        id,
        rowsToRead(ctx.maxRows),
      ]);
    const [match] = found;
    if (!match) {
      return { denominator: "0 sessions", ...whole(""), note: `no session starts with ${prefix}` };
    }
    const { id } = match;
    const counts = countsOf(db, id, at);
    const before = Math.ceil(ctx.maxRows / 2);
    const after = ctx.maxRows - before;
    const result = at
      ? select(
          db,
          `${TIMELINE} ${SHOWN} FROM (
             SELECT * FROM (SELECT * FROM timeline WHERE ts <= ?2 ORDER BY ts DESC, rank DESC, line DESC LIMIT ?3)
             UNION ALL
             SELECT * FROM (SELECT * FROM timeline WHERE ts > ?2 ${IN_ORDER} LIMIT ?4)
           ) ${IN_ORDER}`,
          [id, at, before, after],
        )
      : whole(id);
    const totals = `${counts.said} messages anyone said, ${counts.denied} denials and ${counts.tool} tool calls`;
    return {
      denominator:
        `session ${id}: ${totals}` +
        (at
          ? `, centered on ${at}` +
            unshown(Math.max(0, counts.upTo - before), Math.max(0, counts.after - after))
          : "") +
        (counts.untimed > 0 ? `; ${counts.untimed} tool calls with no time are not shown` : ""),
      ...result,
      note:
        result.rows.length === 0
          ? "nothing was said or done in this session outside injected text"
          : `Text is cut at ${TRANSCRIPT_READING_CHARS} characters. A tool row names its command or file and how it ` +
            "ended, not its result. Skill bodies and injected reminders are not here.",
    };
  },
};
