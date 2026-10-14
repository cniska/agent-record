import { afterEach, expect, test } from "bun:test";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statfsSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { withClaudeSessions } from "./claude-sessions";
import {
  archivedPath,
  type Fixture,
  filesUnder,
  type Home,
  livePath,
  lockHeldBy,
  rebuild,
  refused,
  removeScratch,
  rowsOf,
  runCli,
  scratchDirOutsideTemp,
  scratchHome,
  scratchRepo,
  scratchTempDir,
  sync,
  withFixtures,
  withICloudDrive,
} from "./cli";
import {
  CLAUDE,
  CODEX,
  CODEX_OVERCACHED,
  CODEX_ROLLOUT,
  CODEX_THREAD,
  GROK,
  GROK_UPDATES,
  LONG,
  OMP,
  ORPHAN,
  PI,
  REPO_SESSION,
  TEMP_REPO_SESSION,
} from "./fixture-names";

afterEach(removeScratch);

const LARGE: Fixture = "claude/-Users-x-code-demo/large-session.jsonl";
const LARGE_LINE_BYTES = 1 << 20;
const LARGE_LINES = 64;
const CLONE_SHARE_BOUND = 4;

const freeBytes = (dir: string): number => {
  const { bavail, bsize } = statfsSync(dir);
  return bavail * bsize;
};

const EVERY_TOOL: readonly Fixture[] = [CLAUDE, CODEX, GROK, PI, OMP];
const EVERY_TOOL_TRANSCRIPT: readonly Fixture[] = [CLAUDE, CODEX, GROK_UPDATES, PI, OMP];

const REPO_COMMITS = [
  { subject: "feat: add the parser", file: "src/parser.ts", at: "2026-09-15T10:00:00Z" },
  { subject: "fix(cli): exit 1 on refusal", file: "src/cli.ts", at: "2026-09-15T11:00:00Z" },
];

const SESSION_SUMMARY = `select s.id, s.tool, s.cwd, s.git_branch, s.cli_version, s.ts_first, s.ts_last, s.title,
    (select count(*) from message m where m.session_id = s.id) as messages,
    (select count(*) from turn t where t.session_id = s.id) as turns,
    (select coalesce(sum(input_tokens + cache_read_tokens + cache_write_tokens + output_tokens), 0)
       from usage u where u.session_id = s.id) as tokens,
    (select count(*) from tool_call c where c.session_id = s.id) as tool_calls,
    (select group_concat(subcommand || '@' || coalesce(dir, '?'), ' ') from
       (select g.subcommand, g.dir from git_command g join tool_call c on c.id = g.tool_call_id
        where c.session_id = s.id order by c.id, g.position)) as git,
    (select group_concat(skill_name || ':' || how, ' ') from skill_load k where k.session_id = s.id) as skills
  from session s order by s.id`;

const messageTexts = (home: Home, session: string) =>
  rowsOf(home, `select id, text from message where session_id = '${session}' order by src_line, id`);

const claudeUserLine = (sessionId: string, uuid: string, at: string, text: string): string =>
  JSON.stringify({
    type: "user",
    sessionId,
    uuid,
    cwd: "/Users/x/code/demo",
    timestamp: at,
    message: { role: "user", content: text },
  });

const homeWithRepo = (): { home: Home; repo: string } => {
  const home = scratchHome();
  const repo = scratchRepo(join(scratchDirOutsideTemp(), "app"), "git@github.com:acme/app.git", REPO_COMMITS);
  withFixtures(home, [REPO_SESSION], repo);
  return { home, repo };
};

test("AC-1 a sync records every tool's sessions with their facts, turns, tokens, tool calls and skill loads", () => {
  const home = withFixtures(scratchHome(), EVERY_TOOL);
  sync(home);

  for (const fixture of EVERY_TOOL_TRANSCRIPT)
    expect(readFileSync(archivedPath(home, fixture), "utf8")).toBe(
      readFileSync(livePath(home, fixture), "utf8"),
    );
  const demo = "/Users/x/code/demo";
  const start = "2026-09-16T10:01:00.000Z";
  expect(rowsOf(home, SESSION_SUMMARY)).toEqual([
    [
      CODEX_THREAD,
      "codex",
      demo,
      "main",
      "0.154.0",
      start,
      "2026-09-16T10:08:00.000Z",
      null,
      2,
      1,
      2100,
      2,
      "log@/Users/x/code/demo",
      "review:read",
    ],
    [
      "claude-session",
      "claude",
      demo,
      "main",
      "2.1.260",
      start,
      "2026-09-16T10:06:00.000Z",
      "Add the parser",
      6,
      1,
      2460,
      2,
      "add@/Users/x/code/demo commit@/Users/x/code/demo",
      "build:model",
    ],
    [
      "grok-session",
      "grok",
      demo,
      "main",
      null,
      start,
      "2026-09-16T10:04:00.000Z",
      "Add the parser",
      2,
      0,
      0,
      1,
      "diff@/Users/x/code/demo",
      null,
    ],
    [
      "omp-session",
      "omp",
      demo,
      null,
      null,
      start,
      "2026-09-16T10:04:00.000Z",
      null,
      2,
      0,
      1047,
      1,
      "push@/Users/x/code/demo",
      null,
    ],
    [
      "pi-session",
      "pi",
      demo,
      null,
      null,
      start,
      "2026-09-16T10:04:00.000Z",
      null,
      2,
      0,
      1047,
      1,
      "push@/Users/x/code/demo",
      null,
    ],
  ]);
});

test("AC-2 a second sync adds only the complete lines appended since the first", () => {
  const home = withFixtures(scratchHome(), [CLAUDE]);
  sync(home);
  const before = messageTexts(home, "claude-session");
  const at = "2026-09-16T10:30:00.000Z";
  const appended = [
    claudeUserLine("claude-session", "appended-1", at, "first appended"),
    claudeUserLine("claude-session", "appended-2", at, "second appended"),
  ];
  appendFileSync(livePath(home, CLAUDE), appended.join("\n"));

  sync(home);
  expect(messageTexts(home, "claude-session")).toEqual([...before, ["appended-1", "first appended"]]);

  appendFileSync(livePath(home, CLAUDE), "\n");
  sync(home);
  expect(messageTexts(home, "claude-session")).toEqual([
    ...before,
    ["appended-1", "first appended"],
    ["appended-2", "second appended"],
  ]);
});

test("AC-3 a session whose tool file is deleted stays in the record through sync and rebuild", () => {
  const home = withFixtures(scratchHome(), [CLAUDE]);
  sync(home);
  const recorded = messageTexts(home, "claude-session");
  expect(recorded).toHaveLength(6);

  rmSync(livePath(home, CLAUDE));
  sync(home);
  expect(messageTexts(home, "claude-session")).toEqual(recorded);
  rebuild(home);
  expect(messageTexts(home, "claude-session")).toEqual(recorded);
});

test("AC-4 a transcript rewritten shorter holds only its new content after sync", () => {
  const home = withFixtures(scratchHome(), [LONG]);
  sync(home);
  expect(messageTexts(home, "long-session")).toHaveLength(45);

  const rewritten = [0, 1, 2].map((n) =>
    claudeUserLine("long-session", `rewritten-${n}`, `2026-09-17T10:0${n}:00.000Z`, `rewritten step ${n}`),
  );
  writeFileSync(livePath(home, LONG), `${rewritten.join("\n")}\n`);
  sync(home);

  expect(messageTexts(home, "long-session")).toEqual([
    ["rewritten-0", "rewritten step 0"],
    ["rewritten-1", "rewritten step 1"],
    ["rewritten-2", "rewritten step 2"],
  ]);
});

test("AC-5 a Codex rollout moved into archived_sessions stays one archive copy and one session", () => {
  const home = withFixtures(scratchHome(), [CODEX]);
  sync(home);
  const archivedSessions = join(home.root, ".codex", "archived_sessions");
  mkdirSync(archivedSessions);
  renameSync(livePath(home, CODEX), join(archivedSessions, CODEX_ROLLOUT));
  sync(home);

  expect(filesUnder(join(home.archive, "codex"))).toEqual([join("archived_sessions", CODEX_ROLLOUT)]);
  expect(
    rowsOf(home, "select id, (select count(*) from message m where m.session_id = s.id) from session s"),
  ).toEqual([[CODEX_THREAD, 2]]);
});

test("AC-6 a rebuild reads the archive, not a tool file changed since it was archived", () => {
  const home = withFixtures(scratchHome(), [CLAUDE]);
  sync(home);
  const live = livePath(home, CLAUDE);
  const archivedStamp = statSync(live);
  writeFileSync(live, readFileSync(live, "utf8").replace('"add the parser"', '"add the PARSER"'));
  utimesSync(live, archivedStamp.atime, archivedStamp.mtime);

  rebuild(home);
  expect(rowsOf(home, "select text from message where id = 'claude-session-u1'")).toEqual([
    ["add the parser"],
  ]);
});

test("AC-7 a sync over a malformed line from each tool, an unreadable file and an orphan finishes and names each", () => {
  const home = withFixtures(scratchHome(), [...EVERY_TOOL, LONG, ORPHAN]);
  for (const fixture of EVERY_TOOL_TRANSCRIPT) appendFileSync(livePath(home, fixture), "{not json\n");
  const unreadable = livePath(home, LONG);
  chmodSync(unreadable, 0o000);

  const result = sync(home);
  expect(result.dropped).toEqual([
    { path: archivedPath(home, CLAUDE), lines: [10] },
    { path: archivedPath(home, CODEX), lines: [9] },
    { path: archivedPath(home, GROK_UPDATES), lines: [5] },
    { path: archivedPath(home, PI), lines: [5] },
    { path: archivedPath(home, OMP), lines: [5] },
  ]);
  expect(result.failures).toMatchObject([
    {
      path: unreadable,
      error: {
        kind: "refusal",
        code: "source_unreadable",
        resolve: `make ${unreadable} readable, then run agent-record sync`,
      },
    },
  ]);
  expect(result.orphanSubagents).toEqual(["orphan@gone-parent"]);
});

test("AC-8 a sync records a session repo's commits, label and files, skips a temp repo, and rereads neither", () => {
  const { home, repo } = homeWithRepo();
  const tempRepo = scratchRepo(join(scratchTempDir(), "scratch"), "git@github.com:acme/scratch.git", [
    { subject: "chore: scratch", file: "notes.md", at: "2026-09-15T12:00:00Z" },
  ]);
  withFixtures(home, [TEMP_REPO_SESSION], tempRepo);

  expect(sync(home)).toMatchObject({
    git: { repos: 1, commits: 2, files: 2, unchanged: 0 },
    repoFiles: { repos: 1, files: 2, unchanged: 0 },
  });
  expect(rowsOf(home, "select repo, label, subject, kind from repo_commit order by ts")).toEqual([
    [repo, "acme/app", "feat: add the parser", "feat"],
    [repo, "acme/app", "fix(cli): exit 1 on refusal", "fix"],
  ]);
  expect(rowsOf(home, "select path from commit_file order by path")).toEqual([
    [join(repo, "src", "cli.ts")],
    [join(repo, "src", "parser.ts")],
  ]);
  expect(rowsOf(home, "select checkout, path from repo_file order by path")).toEqual([
    [repo, join(repo, "src", "cli.ts")],
    [repo, join(repo, "src", "parser.ts")],
  ]);

  expect(sync(home)).toMatchObject({
    git: { repos: 0, commits: 0, files: 0, unchanged: 1 },
    repoFiles: { repos: 0, files: 0, unchanged: 1 },
  });
});

const RECORD_TABLE_ORDER = {
  session: "id",
  message: "id",
  turn: "session_id, turn_id",
  compaction: "src_file, src_line",
  usage: "response_id",
  tool_call: "id",
  git_command: "tool_call_id, position",
  skill_load: "session_id, anchor_id, skill_name, how",
} as const;

const recordRows = (home: Home) =>
  Object.entries(RECORD_TABLE_ORDER).map(([table, order]) => ({
    table,
    rows: rowsOf(home, `select * from ${table} order by ${order}`),
  }));

test("AC-9 a rebuild yields the rows the sync wrote", () => {
  const home = withFixtures(scratchHome(), [...EVERY_TOOL, ORPHAN]);
  sync(home);
  const synced = recordRows(home);
  expect(synced.filter(({ rows }) => rows.length === 0).map(({ table }) => table)).toEqual([]);

  rebuild(home);
  expect(recordRows(home)).toEqual(synced);
});

test("AC-25 a Codex token record with more cached input than input is reported as a dropped line", () => {
  const home = withFixtures(scratchHome(), [CODEX_OVERCACHED]);
  const result = sync(home);

  expect(result.dropped).toEqual([{ path: archivedPath(home, CODEX_OVERCACHED), lines: [7] }]);
  expect(rowsOf(home, "select count(*) from usage")).toEqual([[0]]);
});

test("AC-27 a sync with nothing changed reads no file, archives no bytes and finds every checkout unchanged", () => {
  const { home } = homeWithRepo();
  withFixtures(withICloudDrive(home), EVERY_TOOL);
  sync(home);

  expect(sync(home)).toEqual({
    archive: { files: 0, bytes: 0 },
    sources: [
      { tool: "claude", files: 2 },
      { tool: "codex", files: 1 },
      { tool: "grok", files: 1 },
      { tool: "pi", files: 1 },
      { tool: "omp", files: 1 },
    ],
    eventLogs: 0,
    filesRead: 0,
    orphanSubagents: [],
    failures: [],
    dropped: [],
    git: { repos: 0, commits: 0, files: 0, unchanged: 1 },
    repoFiles: { repos: 0, files: 0, unchanged: 1 },
    mirror: { state: "mirrored", path: home.mirror, files: 0, bytes: 0 },
  });
});

test("AC-31 a sync keeps a deleted repo's commits and a rebuild has none", () => {
  const { home, repo } = homeWithRepo();
  sync(home);
  const subjects = "select subject from repo_commit order by ts";
  const recorded = [["feat: add the parser"], ["fix(cli): exit 1 on refusal"]];
  expect(rowsOf(home, subjects)).toEqual(recorded);

  rmSync(repo, { recursive: true });
  sync(home);
  expect(rowsOf(home, subjects)).toEqual(recorded);
  rebuild(home);
  expect(rowsOf(home, subjects)).toEqual([]);
});

test("AC-22 a second sync is refused naming the lock holder, and a lock from an ended process is taken", () => {
  const home = withFixtures(scratchHome(), [CLAUDE]);
  const lock = lockHeldBy(home, process.pid);
  const error = refused(runCli(home, ["sync"]), "sync");
  expect({ code: error.code, meta: error.meta, resolve: error.resolve }).toEqual({
    code: "lock_held",
    meta: { path: lock, pid: process.pid },
    resolve: `run this again once process ${process.pid} has ended`,
  });
  expect(existsSync(home.record)).toBe(false);

  const ended = Bun.spawnSync(["true"]).pid;
  lockHeldBy(home, ended);
  sync(home);
  expect(rowsOf(home, "select id from session")).toEqual([["claude-session"]]);
  expect(existsSync(lock)).toBe(false);
});
test.todo("AC-26 a sync succeeds with the network unavailable", () => {});
test.todo("AC-28 a sync whose record write fails after archiving leaves the record unchanged, and the next records the file once", () => {});
test("AC-30 a fresh archive copy of a large file takes far less free space than its size", () => {
  const home = scratchHome();
  const live = livePath(home, LARGE);
  mkdirSync(dirname(live), { recursive: true });
  const filler = "x".repeat(LARGE_LINE_BYTES);
  const line = `${JSON.stringify({ type: "file-history-snapshot", messageId: "large", snapshot: filler })}\n`;
  writeFileSync(live, line.repeat(LARGE_LINES));
  const size = statSync(live).size;

  const freeBefore = freeBytes(home.root);
  sync(home);
  const taken = freeBefore - freeBytes(home.root);

  expect(readFileSync(archivedPath(home, LARGE)).equals(readFileSync(live))).toBe(true);
  expect(taken).toBeLessThan(size / CLONE_SHARE_BOUND);
});

test("AC-52 a subagent's hand-back report is its last message text, through sync and rebuild", () => {
  const report = "## Fix\nnone\n\nRepo: /Users/x/code/demo\nVerdict: accept";
  const home = withClaudeSessions(scratchHome(), [
    {
      id: "parent",
      cwd: "/Users/x/code/demo",
      steps: [{ owner: "review the parser", at: "2026-09-16T10:00:00Z" }],
      subagents: [
        {
          id: "judge",
          agentType: "acme:reviewer",
          steps: [
            { owner: "judge the diff", at: "2026-09-16T10:01:00Z" },
            { read: "/Users/x/code/demo/src/parser.ts", at: "2026-09-16T10:02:00Z" },
            { handback: report, at: "2026-09-16T10:03:00Z" },
          ],
        },
      ],
    },
  ]);
  const lastText = `select m.text from message m join session s on s.id = m.session_id
    where s.agent_type = 'acme:reviewer' and m.role = 'assistant' and m.text is not null
    order by m.ts desc limit 1`;

  const said = `Reviewed.\n${report}`;

  sync(home);
  expect(rowsOf(home, lastText)).toEqual([[said]]);
  rebuild(home);
  expect(rowsOf(home, lastText)).toEqual([[said]]);
});

test("AC-53 a shell call's exit code is recorded from every tool that writes one, through sync and rebuild", () => {
  const home = withFixtures(scratchHome(), EVERY_TOOL);
  const at = "2026-09-16T10:04:30.000Z";
  const failedResult = (id: string, text: string, details: object | null = null) => ({
    type: "message",
    id,
    timestamp: at,
    message: {
      role: "toolResult",
      toolCallId: id,
      toolName: "bash",
      isError: true,
      content: [{ type: "text", text }],
      details,
    },
  });
  const appended: readonly (readonly [Fixture, object])[] = [
    [
      CLAUDE,
      {
        type: "user",
        sessionId: "claude-session",
        uuid: "claude-session-failed",
        cwd: "/Users/x/code/demo",
        timestamp: at,
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "claude-failed",
              content: "Exit code 2\nboom",
              is_error: true,
            },
          ],
        },
      },
    ],
    [
      GROK_UPDATES,
      {
        timestamp: 1789553070,
        method: "session/update",
        params: {
          sessionId: "grok-session",
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId: "grok-failed",
            status: "completed",
            rawOutput: { type: "Bash", exit_code: 3 },
          },
          _meta: { eventId: "g-failed", agentTimestampMs: 1789553070000 },
        },
      },
    ],
    [
      GROK_UPDATES,
      {
        timestamp: 1789553071,
        method: "session/update",
        params: {
          sessionId: "grok-session",
          update: { sessionUpdate: "tool_call_update", toolCallId: "grok-failed", status: "completed" },
          _meta: { eventId: "g-failed-again", agentTimestampMs: 1789553071000 },
        },
      },
    ],
    [PI, failedResult("pi-failed", "boom\n\nCommand exited with code 4")],
    [OMP, failedResult("omp-failed", "boom", { exitCode: 5 })],
  ];
  for (const [fixture, line] of appended)
    appendFileSync(livePath(home, fixture), `${JSON.stringify(line)}\n`);
  const exitCodes = "select id, exit_code from tool_call where exit_code is not null order by id";
  const expected = [
    [`${CODEX_THREAD}-c1`, 0],
    [`${CODEX_THREAD}-c2`, 0],
    ["claude-failed", 2],
    ["grok-failed", 3],
    ["omp-failed", 5],
    ["pi-failed", 4],
  ];

  sync(home);
  expect(rowsOf(home, exitCodes)).toEqual(expected);
  rebuild(home);
  expect(rowsOf(home, exitCodes)).toEqual(expected);
});
