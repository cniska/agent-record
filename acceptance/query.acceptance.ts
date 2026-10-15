import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import { z } from "zod";
import { withClaudeSessions } from "./claude-sessions";
import {
  type Home,
  holdingRecord,
  QUERY_RESULT,
  refused,
  removeScratch,
  runCli,
  scratchDirOutsideTemp,
  scratchHome,
  scratchRepo,
  scratchWorktree,
  succeeded,
  sync,
  syncedHome,
  USAGE_ENTRY,
  withFixtures,
} from "./cli";
import { CLAUDE, CODEX, CODEX_OVERCACHED, LONG, REPO_SESSION, WORKTREE_SESSION } from "./fixture-names";
import { gate, verdict, withEventLog } from "./hook-events";

afterEach(removeScratch);

const query = (home: Home, args: readonly string[]) =>
  succeeded(runCli(home, ["query", ...args]), "query", QUERY_RESULT);

const syncedFixtureHome = (): Home => syncedHome(withFixtures(scratchHome(), [LONG]));

test("AC-13 query list names every query with its usage and summary", () => {
  const result = succeeded(
    runCli(scratchHome(), ["query", "list"]),
    "query",
    z.strictObject({ queries: z.array(USAGE_ENTRY) }),
  );
  expect(result.queries.map(({ name, usage }) => ({ name, usage }))).toEqual([
    { name: "prior-art", usage: 'agent-record query prior-art "<path fragment>" [--rows <n>]' },
    { name: "search", usage: 'agent-record query search "<words>" [--rows <n>]' },
    { name: "thread", usage: "agent-record query thread <id-prefix> [--at <ts>] [--rows <n>]" },
    { name: "tasks", usage: "agent-record query tasks <id-prefix> [--rows <n>]" },
    { name: "trace", usage: "agent-record query trace <id-prefix> [--task <id-prefix>] [--rows <n>]" },
    {
      name: "signal",
      usage:
        "agent-record query signal <name> [--by <week|repo|version|rule|tag key>] [--skill <name>] [--rows <n>]",
    },
    { name: "signal-events", usage: "agent-record query signal-events <name> [--rows <n>]" },
    {
      name: "before-after",
      usage:
        "agent-record query before-after <sha-prefix> [--days <n>] [--from <ts>] [--skill <name>] [--rows <n>]",
    },
  ]);
  for (const { summary } of result.queries) expect(summary).not.toBe("");
});

test("AC-13 an unknown query is refused naming query list", () => {
  const error = refused(runCli(scratchHome(), ["query", "nope", "x"]), "query");
  expect({ code: error.code, resolve: error.resolve }).toEqual({
    code: "unknown_query",
    resolve: "agent-record query list",
  });
});

test("AC-13 --rows 0 is refused as not a count", () => {
  const error = refused(runCli(scratchHome(), ["query", "thread", "long-session", "--rows", "0"]), "query");
  expect(error.code).toBe("not_a_count");
});

test("AC-13 a query with more rows than the default prints the default count and the more note", () => {
  const home = syncedFixtureHome();
  const cut = query(home, ["thread", "long-session"]);
  expect({ rows: cut.rows.length, more: cut.more }).toEqual({
    rows: 40,
    more: "more rows than 40; --rows <n> to widen",
  });
  expect(cut.denominator).not.toBe("");

  const widened = query(home, ["thread", "long-session", "--rows", "45"]);
  expect({ rows: widened.rows.length, more: widened.more }).toEqual({ rows: 45, more: null });
});

test("AC-17 sql answers a SELECT with columns and rows in a query's shape", () => {
  const result = succeeded(
    runCli(syncedHome(), ["sql", "select 1 as n, 'x' as s, null as z"]),
    "sql",
    QUERY_RESULT,
  );
  expect({ columns: result.columns, rows: result.rows, more: result.more }).toEqual({
    columns: ["n", "s", "z"],
    rows: [[1, "x", null]],
    more: null,
  });
});

test("AC-17 sql refuses a write, leaving the record unchanged", () => {
  const home = syncedFixtureHome();
  const count = ["sql", "select count(*) as n from session"];
  const before = succeeded(runCli(home, count), "sql", QUERY_RESULT).rows;
  expect(before).not.toEqual([[0]]);
  const error = refused(
    runCli(home, ["sql", "insert into session (id, tool) select id || '-copy', tool from session"]),
    "sql",
  );
  expect(error.code).toBe("sql_writes");
  expect(succeeded(runCli(home, count), "sql", QUERY_RESULT).rows).toEqual(before);
});

test("AC-17 sql refuses a syntax error with SQLite's reason", () => {
  const error = refused(runCli(syncedHome(), ["sql", "selec"]), "sql");
  expect({ code: error.code, detail: error.meta.detail }).toEqual({
    code: "sql_invalid",
    detail: 'near "selec": syntax error',
  });
  expect(error.message).toContain('near "selec": syntax error');
});

test("AC-17 sql refuses a column named twice, naming the column", () => {
  const error = refused(runCli(syncedHome(), ["sql", "select 1 as a, 2 as a"]), "sql");
  expect({ code: error.code, column: error.meta.column }).toEqual({
    code: "sql_columns_repeated",
    column: "a",
  });
});

test("AC-17 sql refuses a blob, naming hex()", () => {
  const error = refused(runCli(syncedHome(), ["sql", "select x'00' as b"]), "sql");
  expect({ code: error.code, resolve: error.resolve }).toEqual({
    code: "sql_blob",
    resolve: "select hex(b) instead",
  });
});

test("AC-14 search ranks said messages by matched words, skips skill bodies, names unmatched and dropped words, and a hit opens in thread", () => {
  const home = syncedHome(withFixtures(scratchHome(), [CLAUDE]));
  const absent = Array.from({ length: 14 }, (_, n) => `absent${n}`);
  const result = query(home, ["search", ["add", "parser", "build", "Base", ...absent].join(" ")]);

  expect(result).toEqual({
    denominator:
      "keywords over 3 of 6 messages that carry text anyone said; ranked by how many of the 16 terms matched, " +
      "ties broken by relevance then recency. Only the first 16 words were searched; 2 more were dropped. " +
      `These terms matched nothing anyone said: Base, ${absent.slice(0, 12).join(", ")}. ` +
      "`agent-record query thread <session> --at <at>` reads the exchange a hit sits in.",
    columns: ["session", "at", "role", "project", "terms", "text"],
    rows: [
      [
        "claude-session",
        "2026-09-16T10:01:00.000Z",
        "user",
        "/Users/x/code/demo",
        "2/16",
        "[add] the [parser]",
      ],
      [
        "claude-session",
        "2026-09-16T10:02:00.000Z",
        "assistant",
        "/Users/x/code/demo",
        "1/16",
        "Loading the [build] skill.",
      ],
    ],
    more: null,
    note: null,
  });

  const [session, at] = result.rows[0] ?? [];
  const hit = query(home, ["thread", String(session), "--at", String(at), "--rows", "1"]);
  expect(hit.rows).toEqual([["2026-09-16T10:01:00.000Z", "user", "", "add the parser"]]);
});

test("AC-15 thread reads a session whole or around a time with the counts outside, refuses an ambiguous prefix and answers an unknown one empty", () => {
  const home = syncedHome(withFixtures(scratchHome(), [LONG, CODEX, CODEX_OVERCACHED]));
  const step = (n: number) => [
    `2026-09-16T10:${String(n).padStart(2, "0")}:00.000Z`,
    "user",
    "",
    `parser step ${n}`,
  ];

  const whole = query(home, ["thread", "long", "--rows", "45"]);
  expect({ columns: whole.columns, rows: whole.rows, more: whole.more }).toEqual({
    columns: ["at", "role", "skill", "text"],
    rows: Array.from({ length: 45 }, (_, n) => step(n)),
    more: null,
  });
  expect(whole.denominator).toBe("session long-session: 45 messages anyone said, 0 denials and 0 tool calls");

  const around = query(home, ["thread", "long", "--at", "2026-09-16T10:20:00.000Z", "--rows", "4"]);
  expect({ rows: around.rows, denominator: around.denominator }).toEqual({
    rows: [step(19), step(20), step(21), step(22)],
    denominator:
      "session long-session: 45 messages anyone said, 0 denials and 0 tool calls, centered on " +
      "2026-09-16T10:20:00.000Z; 19 earlier and 22 later rows not shown, --rows <n> to widen",
  });

  const ambiguous = refused(runCli(home, ["query", "thread", "0199a000"]), "query");
  expect({ code: ambiguous.code, matches: ambiguous.meta.matches }).toEqual({
    code: "ambiguous_session",
    matches: ["0199a000-0000-7000-8000-000000000001", "0199a000-0000-7000-8000-000000000002"],
  });

  const unknown = query(home, ["thread", "nosuch"]);
  expect({ denominator: unknown.denominator, rows: unknown.rows, note: unknown.note }).toEqual({
    denominator: "0 sessions",
    rows: [],
    note: "no session starts with nosuch",
  });
});

test("AC-16 prior-art folds worktrees onto their checkout, newest first, and says when it ranked only some", () => {
  const repo = scratchRepo(join(scratchDirOutsideTemp(), "app"), "git@github.com:acme/app.git", [
    { subject: "feat: add the a parser", file: "src/parse-a.ts", at: "2026-09-10T10:00:00Z" },
    { subject: "feat: add the b parser", file: "src/parse-b.ts", at: "2026-09-11T10:00:00Z" },
    { subject: "feat: add the c parser", file: "src/parse-c.ts", at: "2026-09-12T10:00:00Z" },
    { subject: "feat: add the d parser", file: "src/parse-d.ts", at: "2026-09-13T10:00:00Z" },
  ]);
  const worktree = join(repo, ".claude", "worktrees", "side");
  scratchWorktree(repo, worktree, {
    subject: "feat: add the e parser",
    file: "src/parse-e.ts",
    at: "2026-09-14T10:00:00Z",
  });
  const home = withFixtures(withFixtures(scratchHome(), [REPO_SESSION], repo), [WORKTREE_SESSION], worktree);
  sync(home);

  const result = query(home, ["prior-art", "src/parse-"]);
  expect(result.rows.map(([file, where, commits, , authors]) => [file, where, commits, authors])).toEqual([
    [join(repo, "src", "parse-e.ts"), "acme/app", 1, 1],
    [join(repo, "src", "parse-d.ts"), "acme/app", 1, 1],
    [join(repo, "src", "parse-c.ts"), "acme/app", 1, 1],
  ]);
  expect(result.denominator).toBe(
    '5 tracked files match "src/parse-", in 1 of 1 checkouts indexed; the 3 most recently touched under each where are ranked',
  );
});
test("AC-23 a query answers beside a writer and is refused as busy under an exclusive lock", () => {
  const home = syncedFixtureHome();
  const args = ["search", "parser"];
  const answered = query(home, args);

  expect(holdingRecord(home, "write", () => query(home, args))).toEqual(answered);
  const error = holdingRecord(home, "exclusive", () => refused(runCli(home, ["query", ...args]), "query"));
  expect({ kind: error.kind, code: error.code, meta: error.meta, resolve: error.resolve }).toEqual({
    kind: "refusal",
    code: "record_busy",
    meta: { path: home.record },
    resolve: "run this again; if it keeps failing, close whatever holds the file",
  });
});

const TRACED = "/Users/x/code/demo";

const KIT = "/Users/x/.claude/plugins/cache/acme/kit/1.0.0/skills";

const tracedHome = (): Home =>
  withEventLog(
    withClaudeSessions(scratchHome(), [
      {
        id: "coordinator",
        cwd: TRACED,
        steps: [
          { owner: "<command-name>/run</command-name>", at: "2026-09-16T10:00:00Z" },
          { spawn: "toolu-worker", at: "2026-09-16T10:01:00Z", done: "2026-09-16T10:20:00Z" },
          { spawn: "toolu-watcher", at: "2026-09-16T10:09:00Z", done: "2026-09-16T10:09:01Z" },
          { agent: "Both are running.", at: "2026-09-16T10:20:30Z" },
          { owner: "now write the docs", at: "2026-09-16T10:30:00Z" },
          { bash: "ls docs", at: "2026-09-16T10:30:10Z", done: "2026-09-16T10:30:11Z" },
        ],
        subagents: [
          {
            id: "worker",
            agentType: "general-purpose",
            startedBy: "toolu-worker",
            steps: [
              { owner: "build the step", at: "2026-09-16T10:01:01Z" },
              {
                skill: "acme:build",
                at: "2026-09-16T10:01:10Z",
                done: "2026-09-16T10:01:11Z",
                dir: `${KIT}/build`,
                body: "Build it.",
              },
              { read: `${KIT}/build/references/slices.md`, at: "2026-09-16T10:01:20Z" },
              {
                agent: "building",
                at: "2026-09-16T10:01:30Z",
                usage: {
                  input_tokens: 10,
                  cache_read_input_tokens: 2000,
                  cache_creation_input_tokens: 300,
                  output_tokens: 40,
                },
              },
              { compacted: "2026-09-16T10:02:00Z" },
              { rejected: "rm -rf build", at: "2026-09-16T10:02:30Z" },
              {
                spawn: "toolu-checker",
                at: "2026-09-16T10:03:00Z",
                done: "2026-09-16T10:05:00Z",
                failed: true,
              },
              {
                bash: "git commit -m 'feat: add the step'",
                at: "2026-09-16T10:05:30Z",
                done: "2026-09-16T10:05:31Z",
              },
              {
                bash: "git add -A && git commit -m 'feat: add the step'",
                at: "2026-09-16T10:06:00Z",
                done: "2026-09-16T10:06:01Z",
              },
              { bash: "git push", at: "2026-09-16T10:07:00Z", done: "2026-09-16T10:07:02Z" },
              { agent: "landed", at: "2026-09-16T10:08:00Z" },
            ],
          },
          {
            id: "checker",
            agentType: "acme:checker",
            startedBy: "toolu-checker",
            steps: [
              { owner: "judge the diff", at: "2026-09-16T10:03:01Z" },
              { preload: "acme:judge", at: "2026-09-16T10:03:01Z", dir: `${KIT}/judge`, body: "Judge it." },
              { agent: "Verdict: accept", at: "2026-09-16T10:04:00Z" },
            ],
          },
          {
            id: "watcher",
            agentType: "Explore",
            startedBy: "toolu-watcher",
            steps: [
              { owner: "watch the build", at: "2026-09-16T10:09:02Z" },
              { hostRefused: `${TRACED}/build.log`, at: "2026-09-16T10:09:10Z" },
              { pending: "sleep 600", at: "2026-09-16T10:09:30Z" },
            ],
          },
        ],
      },
    ]),
    "coordinator",
    [
      verdict("2026-09-16T10:04:00Z", { agent: "checker", verdict: "accept", repo: TRACED }),
      gate("2026-09-16T10:05:30Z", { agent: "worker", decision: "deny", reason: "changed_since_accept" }),
      gate("2026-09-16T10:06:00Z", { agent: "worker", decision: "allow", reason: "accepted" }),
    ],
  );

test("AC-61 trace prints a worker's steps and the checker it started, one JSON line per step, a running one with no end", () => {
  const home = tracedHome();
  sync(home);

  const result = query(home, ["trace", "coord", "--task", "coordinator-0", "--rows", "100"]);
  const lines = result.rows.map(([line]) => JSON.parse(String(line)));
  const shape = (line: Record<string, unknown>) => {
    const outcome = z
      .object({ kind: z.string(), code: z.string().optional() })
      .optional()
      .parse(line.outcome);
    return [
      String(line.session).split("@")[0],
      line.seq,
      line.step,
      line.phase,
      outcome?.code ?? outcome?.kind ?? "-",
    ];
  };
  const first = "coordinator-0-prompt";
  const worker = { session: "worker@coordinator", parent: "coordinator", task: first };

  expect(result.denominator).toBe(
    `task ${first} of session coordinator, from 2026-09-16T10:00:00.000Z, and the 3 subagents started in it: 21 steps, 2 still running`,
  );
  expect(lines.map(shape)).toEqual([
    ["coordinator", 1, "agent", "started", "-"],
    ["coordinator", 2, "tool", "started", "-"],
    ["worker", 1, "agent", "started", "-"],
    ["worker", 2, "tool", "started", "-"],
    ["worker", 3, "skill", "started", "-"],
    ["worker", 4, "skill", "ended", "ok"],
    ["worker", 5, "tool", "ended", "ok"],
    ["worker", 6, "tool", "started", "-"],
    ["worker", 7, "tool", "ended", "ok"],
    ["worker", 8, "compact", "started", "-"],
    ["worker", 9, "compact", "ended", "ok"],
    ["worker", 10, "tool", "started", "-"],
    ["worker", 11, "tool", "ended", "user-rejected"],
    ["worker", 12, "tool", "started", "-"],
    ["checker", 1, "agent", "started", "-"],
    ["checker", 2, "skill", "started", "-"],
    ["checker", 3, "skill", "ended", "ok"],
    ["checker", 4, "verdict", "started", "-"],
    ["checker", 5, "verdict", "ended", "ok"],
    ["checker", 6, "agent", "ended", "failed"],
    ["worker", 13, "tool", "ended", "failed"],
    ["worker", 14, "tool", "started", "-"],
    ["worker", 15, "gate", "started", "-"],
    ["worker", 16, "gate", "ended", "changed_since_accept"],
    ["worker", 17, "tool", "ended", "ok"],
    ["worker", 18, "tool", "started", "-"],
    ["worker", 19, "gate", "started", "-"],
    ["worker", 20, "gate", "ended", "ok"],
    ["worker", 21, "tool", "ended", "ok"],
    ["worker", 22, "tool", "started", "-"],
    ["worker", 23, "tool", "ended", "ok"],
    ["worker", 24, "agent", "ended", "ok"],
    ["coordinator", 3, "tool", "started", "-"],
    ["coordinator", 4, "tool", "ended", "ok"],
    ["watcher", 1, "agent", "started", "-"],
    ["watcher", 2, "tool", "started", "-"],
    ["watcher", 3, "tool", "ended", "host"],
    ["watcher", 4, "tool", "started", "-"],
    ["coordinator", 5, "tool", "ended", "ok"],
    ["coordinator", 6, "agent", "ended", "ok"],
  ]);
  expect(lines.slice(3, 5)).toEqual([
    {
      at: "2026-09-16T10:01:10.000Z",
      ...worker,
      seq: 2,
      step: "tool",
      phase: "started",
      call: "coordinator-worker-1-tool",
      name: "Skill",
      target: "acme:build",
      git: null,
    },
    {
      at: "2026-09-16T10:01:10.000Z",
      ...worker,
      seq: 3,
      step: "skill",
      phase: "started",
      name: "build",
      how: "model",
      call: "coordinator-worker-1-tool",
    },
  ]);
  expect(lines[7]).toMatchObject({
    seq: 6,
    step: "tool",
    name: "Read",
    target: `${KIT}/build/references/slices.md`,
  });
  expect(lines[11]).toMatchObject({ seq: 10, step: "tool", name: "Bash", target: null });
  expect(lines[15]).toMatchObject({
    session: "checker@coordinator",
    seq: 2,
    step: "skill",
    phase: "started",
    name: "judge",
    how: "preload",
    call: null,
  });
  expect(lines[14]).toEqual({
    at: "2026-09-16T10:03:01.000Z",
    session: "checker@coordinator",
    parent: "worker@coordinator",
    task: first,
    seq: 1,
    step: "agent",
    phase: "started",
    agentType: "acme:checker",
    model: null,
  });
  expect(lines[18]).toEqual({
    at: "2026-09-16T10:04:00.000Z",
    session: "checker@coordinator",
    parent: "worker@coordinator",
    task: first,
    seq: 5,
    step: "verdict",
    phase: "ended",
    ms: 0,
    outcome: { kind: "ok" },
    verdict: "accept",
  });
  expect(lines[19]).toEqual({
    at: "2026-09-16T10:04:00.000Z",
    session: "checker@coordinator",
    parent: "worker@coordinator",
    task: first,
    seq: 6,
    step: "agent",
    phase: "ended",
    ms: 59000,
    outcome: { kind: "failed", error: "error" },
    inputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 0,
  });
  expect(lines[12]).toEqual({
    at: "2026-09-16T10:02:30.000Z",
    ...worker,
    seq: 11,
    step: "tool",
    phase: "ended",
    ms: 0,
    outcome: { kind: "refused", code: "user-rejected" },
    call: "coordinator-worker-5-tool",
    name: "Bash",
  });
  expect(lines[5]).toMatchObject({ seq: 4, step: "skill", phase: "ended", name: "build" });
  expect(lines[23]).toEqual({
    at: "2026-09-16T10:05:30.000Z",
    ...worker,
    seq: 16,
    step: "gate",
    phase: "ended",
    ms: 0,
    outcome: { kind: "refused", code: "changed_since_accept" },
  });
  expect(lines[29]).toEqual({
    at: "2026-09-16T10:07:00.000Z",
    ...worker,
    seq: 22,
    step: "tool",
    phase: "started",
    call: "coordinator-worker-9-tool",
    name: "Bash",
    target: null,
    git: ["push"],
  });
  expect(lines.filter((line) => Array.isArray(line.git)).map((line) => [line.seq, line.git])).toEqual([
    [14, ["commit"]],
    [18, ["add", "commit"]],
    [22, ["push"]],
  ]);
  expect(lines[31]).toEqual({
    at: "2026-09-16T10:08:00.000Z",
    ...worker,
    seq: 24,
    step: "agent",
    phase: "ended",
    ms: 419000,
    outcome: { kind: "ok" },
    inputTokens: 10,
    cacheReadTokens: 2000,
    cacheWriteTokens: 300,
    outputTokens: 40,
  });
  expect(lines.at(-1)).toMatchObject({
    at: "2026-09-16T10:20:30.000Z",
    session: "coordinator",
    step: "agent",
  });

  const later = "coordinator-4-prompt";
  const listed = query(home, ["tasks", "coord"]);
  expect({ denominator: listed.denominator, rows: listed.rows }).toEqual({
    denominator: "2 tasks of session coordinator",
    rows: [
      [first, "2026-09-16T10:00:00.000Z", "<command-name>/run</command-name>"],
      [later, "2026-09-16T10:30:00.000Z", "now write the docs"],
    ],
  });
  const latest = query(home, ["trace", "coord"]);
  expect(latest.denominator).toBe(
    `task ${later} of session coordinator, from 2026-09-16T10:30:00.000Z, and the 0 subagents started in it: 2 steps, 0 still running`,
  );
  const root = { session: "coordinator", parent: null, task: later };
  expect(latest.rows.map(([line]) => JSON.parse(String(line)))).toEqual([
    {
      at: "2026-09-16T10:30:00.000Z",
      ...root,
      seq: 1,
      step: "agent",
      phase: "started",
      agentType: null,
      model: null,
    },
    {
      at: "2026-09-16T10:30:10.000Z",
      ...root,
      seq: 2,
      step: "tool",
      phase: "started",
      call: "coordinator-5-tool",
      name: "Bash",
      target: null,
      git: null,
    },
    {
      at: "2026-09-16T10:30:11.000Z",
      ...root,
      seq: 3,
      step: "tool",
      phase: "ended",
      ms: 1000,
      outcome: { kind: "ok" },
      call: "coordinator-5-tool",
      name: "Bash",
    },
    {
      at: "2026-09-16T10:30:11.000Z",
      ...root,
      seq: 4,
      step: "agent",
      phase: "ended",
      ms: 11000,
      outcome: { kind: "ok" },
      inputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 0,
    },
  ]);
  const subagent = query(home, ["trace", "worker", "--rows", "100"]);
  expect(subagent.denominator).toBe(
    `session worker@coordinator and the 1 subagents under it, in task ${first} of coordinator: 15 steps, 0 still running`,
  );
  expect(new Set(subagent.rows.map(([line]) => JSON.parse(String(line)).task))).toEqual(new Set([first]));
  expect(query(home, ["trace", "agent-worker", "--rows", "100"])).toEqual(subagent);
  const refusal = (args: readonly string[]) => {
    const error = refused(runCli(home, ["query", "trace", ...args]), "query");
    return { code: error.code, meta: error.meta };
  };
  expect(refusal(["coord", "--task", "nosuch"])).toEqual({
    code: "unknown_task",
    meta: { session: "coordinator", prefix: "nosuch", tasks: [first, later] },
  });
  expect(refusal(["coord", "--task", "coordinator-"])).toEqual({
    code: "ambiguous_task",
    meta: { session: "coordinator", prefix: "coordinator-", matches: [first, later] },
  });
  expect(refusal(["worker", "--task", first])).toEqual({
    code: "task_of_subagent",
    meta: { session: "worker@coordinator" },
  });

  const nested = withClaudeSessions(scratchHome(), [
    {
      id: "lead",
      cwd: TRACED,
      steps: [
        { owner: "draft the plan", at: "2026-09-16T10:00:00Z" },
        { spawn: "toolu-drafter", at: "2026-09-16T10:01:00Z", done: "2026-09-16T10:40:00Z" },
        { agent: "Drafting.", at: "2026-09-16T10:02:00Z" },
        { owner: "and then the tests", at: "2026-09-16T10:30:00Z" },
      ],
      subagents: [
        {
          id: "drafter",
          agentType: "general-purpose",
          startedBy: "toolu-drafter",
          steps: [
            { owner: "draft it", at: "2026-09-16T10:01:01Z" },
            { spawn: "toolu-helper", at: "2026-09-16T10:35:00Z", done: "2026-09-16T10:36:00Z" },
          ],
        },
        {
          id: "helper",
          agentType: "Explore",
          startedBy: "toolu-helper",
          steps: [
            { owner: "find the notes", at: "2026-09-16T10:35:01Z" },
            { agent: "Found.", at: "2026-09-16T10:35:30Z" },
          ],
        },
      ],
    },
  ]);
  sync(nested);
  expect(query(nested, ["trace", "helper"]).denominator).toBe(
    "session helper@lead and the 0 subagents under it, in task lead-0-prompt of lead: 1 steps, 0 still running",
  );

  const unknown = query(home, ["trace", "nobody"]);
  expect({ rows: unknown.rows, note: unknown.note }).toEqual({
    rows: [],
    note: "no session starts with nobody",
  });
  const error = refused(runCli(home, ["query", "trace", "w"]), "query");
  expect({ code: error.code, meta: error.meta }).toEqual({
    code: "ambiguous_session",
    meta: { query: "trace", prefix: "w", matches: ["watcher@coordinator", "worker@coordinator"] },
  });
});
