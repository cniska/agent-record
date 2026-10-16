import { afterEach, expect, test } from "bun:test";
import { withClaudeSessions } from "./claude-sessions";
import { type Home, removeScratch, rowsOf, scratchHome, sync, withFixtures } from "./cli";
import { CLAUDE, CODEX_COLUMNS, GROK_COLUMNS, OMP_COLUMNS, PI_COLUMNS } from "./fixture-names";

afterEach(removeScratch);

const EVERY_SOURCE = ["claude", "codex", "grok", "omp", "pi"] as const;
const BUT_GROK = ["claude", "codex", "omp", "pi"] as const;
const SCHEMA_TOOLS = /\btool\s+TEXT NOT NULL CHECK \(tool IN \(([^)]*)\)\)/;

function toolsTheRecordReads(home: Home): string[] {
  const sql = rowsOf(home, "select sql from sqlite_master where name = 'session'")[0]?.[0];
  const listed = SCHEMA_TOOLS.exec(String(sql))?.[1] ?? "";
  return listed
    .split(",")
    .map((tool) => tool.trim().replaceAll("'", ""))
    .sort();
}

const ROWS_BY_SOURCE: Readonly<Record<string, string>> = {
  message: "message t join session s on s.id = t.session_id",
  usage: "usage t join session s on s.id = t.session_id",
  turn: "turn t join session s on s.id = t.session_id",
  tool_call: "tool_call t join session s on s.id = t.session_id",
  git_command:
    "git_command t join tool_call c on c.id = t.tool_call_id join session s on s.id = c.session_id",
  skill_load: "skill_load t join session s on s.id = t.session_id",
  compaction: "compaction t join session s on s.id = t.session_id",
};

const FILLED_BY: Readonly<Record<string, readonly string[]>> = {
  "message.id": EVERY_SOURCE,
  "message.session_id": EVERY_SOURCE,
  "message.ts": EVERY_SOURCE,
  "message.role": EVERY_SOURCE,
  "message.model": EVERY_SOURCE,
  "message.turn_id": ["claude", "codex"],
  "message.prompt_source": ["claude", "codex"],
  "message.origin_kind": ["claude"],
  "message.is_meta": ["claude"],
  "message.is_skill_body": ["claude"],
  "message.attribution_skill": ["claude"],
  "message.slash_command": ["claude"],
  "message.denial_kind": ["claude"],
  "message.user_feedback": ["claude"],
  "message.denial_reason": ["claude"],
  "message.text": EVERY_SOURCE,
  "message.text_chars": EVERY_SOURCE,
  "message.src_file": EVERY_SOURCE,
  "message.src_line": EVERY_SOURCE,
  "message.extra": ["claude", "codex"],
  "usage.response_id": BUT_GROK,
  "usage.session_id": BUT_GROK,
  "usage.message_id": ["claude", "omp", "pi"],
  "usage.ts": BUT_GROK,
  "usage.model": BUT_GROK,
  "usage.input_tokens": BUT_GROK,
  "usage.cache_read_tokens": BUT_GROK,
  "usage.cache_write_tokens": BUT_GROK,
  "usage.output_tokens": BUT_GROK,
  "usage.attribution_skill": ["claude"],
  "turn.session_id": ["claude", "codex"],
  "turn.turn_id": ["claude", "codex"],
  "turn.ts_start": ["claude", "codex"],
  "turn.ts_end": ["claude", "codex"],
  "turn.duration_ms": ["claude", "codex"],
  "turn.message_count": ["claude"],
  "turn.status": ["claude", "codex"],
  "turn.model": ["codex"],
  "turn.time_to_first_token_ms": ["codex"],
  "tool_call.id": EVERY_SOURCE,
  "tool_call.session_id": EVERY_SOURCE,
  "tool_call.message_id": ["claude", "omp", "pi"],
  "tool_call.model": BUT_GROK,
  "tool_call.attribution_skill": ["claude"],
  "tool_call.ts_call": EVERY_SOURCE,
  "tool_call.ts_result": EVERY_SOURCE,
  "tool_call.tool_name": EVERY_SOURCE,
  "tool_call.skill_name": ["claude"],
  "tool_call.file_path": EVERY_SOURCE,
  "tool_call.command": EVERY_SOURCE,
  "tool_call.is_error": EVERY_SOURCE,
  "tool_call.is_interrupted": ["claude"],
  "tool_call.host_refused": ["claude"],
  "tool_call.exit_code": EVERY_SOURCE,
  "tool_call.duration_ms": EVERY_SOURCE,
  "tool_call.result_bytes": EVERY_SOURCE,
  "tool_call.error_text": EVERY_SOURCE,
  "tool_call.src_file": EVERY_SOURCE,
  "tool_call.src_line_call": EVERY_SOURCE,
  "tool_call.src_line_result": EVERY_SOURCE,
  "git_command.tool_call_id": EVERY_SOURCE,
  "git_command.position": EVERY_SOURCE,
  "git_command.subcommand": EVERY_SOURCE,
  "git_command.dir": EVERY_SOURCE,
  "skill_load.session_id": EVERY_SOURCE,
  "skill_load.message_id": ["claude"],
  "skill_load.tool_call_id": EVERY_SOURCE,
  "skill_load.ts": EVERY_SOURCE,
  "skill_load.model": BUT_GROK,
  "skill_load.skill_name": EVERY_SOURCE,
  "skill_load.how": EVERY_SOURCE,
  "skill_load.body_chars": ["claude"],
  "skill_load.body_sha256": ["claude"],
  "skill_load.skill_path": ["claude"],
  "skill_load.install": ["claude"],
  "compaction.session_id": ["claude"],
  "compaction.ts": ["claude"],
  "compaction.src_file": ["claude"],
  "compaction.src_line": ["claude"],
};

function everySourceSession(): Home {
  return withClaudeSessions(
    withFixtures(scratchHome(), [CLAUDE, CODEX_COLUMNS, GROK_COLUMNS, PI_COLUMNS, OMP_COLUMNS]),
    [
      {
        id: "claude-columns",
        cwd: "/Users/x/code/demo",
        steps: [
          { owner: "<command-name>/review</command-name>", at: "2026-09-16T11:00:00.000Z" },
          { queued: "and the docs", at: "2026-09-16T11:00:30.000Z", from: "owner" },
          {
            agent: "Reading the parser.",
            at: "2026-09-16T11:01:00.000Z",
            usage: {
              input_tokens: 5,
              cache_read_input_tokens: 10,
              cache_creation_input_tokens: 2,
              output_tokens: 3,
            },
          },
          {
            skill: "build",
            at: "2026-09-16T11:01:10.000Z",
            dir: "/Users/x/.claude/plugins/cache/acme/acme-skills/1.2.0/skills/build",
            body: "# Build",
          },
          {
            preload: "plan",
            at: "2026-09-16T11:01:20.000Z",
            dir: "/Users/x/.claude/skills/plan",
            body: "# Plan",
          },
          { read: "/Users/x/code/demo/src/parser.ts", at: "2026-09-16T11:02:00.000Z" },
          { bash: "git status", at: "2026-09-16T11:03:00.000Z", done: "2026-09-16T11:03:01.000Z" },
          { errored: "bun run check", at: "2026-09-16T11:04:00.000Z", output: "Exit code 1\nlint: 2 errors" },
          { rejected: "rm -rf build", at: "2026-09-16T11:05:00.000Z", feedback: "keep the build" },
          { hostRefused: "/Users/x/code/demo/src/parser.ts", at: "2026-09-16T11:06:00.000Z" },
          { compacted: "2026-09-16T11:07:00.000Z" },
          { pending: "bun run acceptance", at: "2026-09-16T11:08:00.000Z" },
        ],
      },
    ],
  );
}

function filledBy(home: Home): Record<string, readonly string[]> {
  const filled: Record<string, string[]> = {};
  for (const [table, rows] of Object.entries(ROWS_BY_SOURCE)) {
    const described = rowsOf(home, `select name, dflt_value from pragma_table_info('${table}') order by cid`);
    const columns = described.map(([name]) => String(name));
    for (const column of columns) filled[`${table}.${column}`] = [];
    const counts = described
      .map(([name, unset]) => (unset === null ? `count(t.${name})` : `count(nullif(t.${name}, ${unset}))`))
      .join(", ");
    for (const [source, ...filledRows] of rowsOf(
      home,
      `select s.tool, ${counts} from ${rows} group by s.tool order by s.tool`,
    )) {
      columns.forEach((column, index) => {
        if (Number(filledRows[index]) > 0) filled[`${table}.${column}`]?.push(String(source));
      });
    }
  }
  return filled;
}

test("AC-74 each per-call and per-event column is filled for exactly the sources the record reads it from", () => {
  const home = everySourceSession();

  sync(home);

  expect(toolsTheRecordReads(home)).toEqual([...EVERY_SOURCE]);
  expect(rowsOf(home, "select distinct tool from session order by tool").map(([tool]) => tool)).toEqual([
    ...EVERY_SOURCE,
  ]);
  expect(filledBy(home)).toEqual(FILLED_BY);
});
