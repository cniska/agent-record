import { afterEach, expect, test } from "bun:test";
import {
  appendFileSync,
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
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
  columnsHolding,
  doctor,
  type Fixture,
  failingRecordWrites,
  failuresInFull,
  faulted,
  filesUnder,
  type Home,
  livePath,
  lockHeldBy,
  type PlantedInsertFailure,
  rebuild,
  refused,
  removeScratchDirs,
  rowsOf,
  runCli,
  runCliOffline,
  SYNC_COMMAND_RESULT,
  schemaVersion,
  scratchDir,
  scratchDirOutsideTemp,
  scratchHome,
  scratchRepo,
  setSchemaVersion,
  succeeded,
  sync,
  withCodexTitle,
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
import { archivedEventLog, eventLogPath, withEventLog } from "./hook-events";

afterEach(removeScratchDirs);

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

test("AC-4 a transcript rewritten keeping its size and modification time holds only its new content after sync", () => {
  const home = withFixtures(scratchHome(), [CLAUDE]);
  const live = livePath(home, CLAUDE);
  const modified = new Date("2026-09-16T12:00:00.000Z");
  utimesSync(live, modified, modified);
  sync(home);
  const { size } = statSync(live);
  writeFileSync(live, readFileSync(live, "utf8").replace('"add the parser"', '"add the PARSER"'));
  utimesSync(live, modified, modified);
  expect({ size: statSync(live).size, mtimeMs: statSync(live).mtimeMs }).toEqual({
    size,
    mtimeMs: modified.getTime(),
  });

  sync(home);
  expect(rowsOf(home, "select text from message where id = 'claude-session-u1'")).toEqual([
    ["add the PARSER"],
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
  writeFileSync(live, readFileSync(live, "utf8").replace('"add the parser"', '"add the PARSER"'));

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
    { path: archivedPath(home, CLAUDE), lines: "10" },
    { path: archivedPath(home, CODEX), lines: "9" },
    { path: archivedPath(home, GROK_UPDATES), lines: "5" },
    { path: archivedPath(home, PI), lines: "5" },
    { path: archivedPath(home, OMP), lines: "5" },
  ]);
  expect(result.failures).toEqual([
    {
      path: unreadable,
      kind: "refusal",
      code: "source_unreadable",
      message: expect.stringContaining(unreadable),
      resolve: `make ${unreadable} readable, then run agent-record sync`,
    },
  ]);
  expect(result.orphanSubagents).toEqual(["orphan@gone-parent"]);
  expect(failuresInFull(home, "sync")).toMatchObject([
    { path: unreadable, error: { kind: "refusal", code: "source_unreadable", meta: { path: unreadable } } },
  ]);
});

test("AC-7 a rebuild over an archived file it cannot read finishes and names the failure, its meta under --full", () => {
  const home = withFixtures(scratchHome(), [CLAUDE, LONG]);
  sync(home);
  const unreadable = archivedPath(home, LONG);
  chmodSync(unreadable, 0o000);
  const plain = rebuild(home).failures;
  const full = failuresInFull(home, "rebuild");
  chmodSync(unreadable, 0o644);
  expect(plain).toEqual([
    {
      path: unreadable,
      kind: "refusal",
      code: "source_unreadable",
      message: expect.stringContaining(unreadable),
      resolve: expect.stringContaining(unreadable),
    },
  ]);
  expect(full).toMatchObject([
    { path: unreadable, error: { kind: "refusal", code: "source_unreadable", meta: { path: unreadable } } },
  ]);
});

test("AC-8 a sync records a session repo's commits, label and files, skips a temp repo, and rereads neither", () => {
  const { home, repo } = homeWithRepo();
  const tempRepo = scratchRepo(join(scratchDir(), "scratch"), "git@github.com:acme/scratch.git", [
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

  expect(result.dropped).toEqual([{ path: archivedPath(home, CODEX_OVERCACHED), lines: "7" }]);
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
    unlinkedSubagents: 0,
    failures: [],
    dropped: [],
    git: { repos: 0, commits: 0, files: 0, unchanged: 1 },
    repoFiles: { repos: 0, files: 0, unchanged: 1 },
    mirror: { state: "mirrored", path: home.mirror, files: 0, bytes: 0 },
    rebuilt: null,
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

function restored(home: Home, backup: string): Home {
  for (const suffix of ["-wal", "-shm"]) rmSync(`${home.record}${suffix}`, { force: true });
  renameSync(backup, home.record);
  return home;
}

test("AC-69 a rebuild, and a sync that rebuilds an older record, name each checkout whose history they could not read, and back up the record first, keeping only the last backup", () => {
  const removed = homeWithRepo();
  sync(removed.home);
  const commits = rowsOf(removed.home, "select count(*) from repo_commit");
  expect(commits).not.toEqual([[0]]);
  const checkout = realpathSync(removed.repo);
  rmSync(removed.repo, { recursive: true });
  const first = rebuild(removed.home);
  expect(first).toMatchObject({
    backup: `${removed.home.record}.agent-record-backup`,
    unreadCheckouts: [checkout],
  });
  const keptAside = join(scratchDir(), "first-backup");
  copyFileSync(first.backup, keptAside);
  const second = rebuild(removed.home);
  expect(second).toMatchObject({
    backup: `${removed.home.record}.agent-record-backup-2`,
    unreadCheckouts: [],
  });
  expect(existsSync(first.backup)).toBe(false);
  const backupCheck = doctor(removed.home, "full").report.checks.find(({ name }) => name === "backup");
  expect({
    state: backupCheck?.state,
    detail: backupCheck?.detail.replace(/, \d+\.\d MB,/, ", <size> MB,"),
  }).toEqual({
    state: "ok",
    detail: `${second.backup}, <size> MB, holds the record from before the last rebuild`,
  });
  expect(rowsOf(restored(removed.home, keptAside), "select count(*) from repo_commit")).toEqual(commits);

  const older = homeWithRepo();
  sync(older.home);
  const sessions = rowsOf(older.home, "select id from session order by id");
  const olderCheckout = realpathSync(older.repo);
  rmSync(older.repo, { recursive: true });
  const current = schemaVersion(older.home);
  setSchemaVersion(older.home, current - 1);
  expect(sync(older.home).rebuilt).toEqual({
    from: current - 1,
    to: current,
    backup: `${older.home.record}.agent-record-backup`,
    unreadCheckouts: [olderCheckout],
  });
  expect(rowsOf(older.home, "select id from session order by id")).toEqual(sessions);
  expect(rowsOf(older.home, "select count(*) from repo_commit")).toEqual([[0]]);
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
test("AC-26 a sync with the network denied succeeds, recording every tool's sessions, a repo's commits and the mirror", () => {
  const { home } = homeWithRepo();
  withFixtures(withICloudDrive(home), EVERY_TOOL);

  const result = succeeded(runCliOffline(home, ["sync"]), "sync", SYNC_COMMAND_RESULT);
  expect(result).toMatchObject({
    failures: [],
    git: { repos: 1, commits: 2 },
    mirror: { state: "mirrored", path: home.mirror },
  });
  expect(rowsOf(home, "select id from session order by id")).toEqual([
    [CODEX_THREAD],
    ["claude-session"],
    ["grok-session"],
    ["omp-session"],
    ["pi-session"],
    ["repo-session"],
  ]);
});
const syncFailingWrites = (home: Home, insert: PlantedInsertFailure): void => {
  const error = failingRecordWrites(home, insert, () => faulted(runCli(home, ["sync"]), "sync"));
  expect(error.code).toBe("command_failed");
};

test("AC-28 a sync whose record write fails after appending to the archive leaves the record unchanged, and the next records the lines once", () => {
  const home = withFixtures(scratchHome(), [CLAUDE]);
  sync(home);
  const before = recordRows(home);
  const recorded = messageTexts(home, "claude-session");
  const at = "2026-09-16T10:30:00.000Z";
  const appended = [
    claudeUserLine("claude-session", "appended-1", at, "first appended"),
    claudeUserLine("claude-session", "appended-2", at, "second appended"),
  ];
  appendFileSync(livePath(home, CLAUDE), `${appended.join("\n")}\n`);

  syncFailingWrites(home, { table: "message", when: "NEW.id = 'appended-2'" });
  expect(readFileSync(archivedPath(home, CLAUDE), "utf8")).toBe(readFileSync(livePath(home, CLAUDE), "utf8"));
  expect(recordRows(home)).toEqual(before);

  sync(home);
  expect(messageTexts(home, "claude-session")).toEqual([
    ...recorded,
    ["appended-1", "first appended"],
    ["appended-2", "second appended"],
  ]);
});

test("AC-28 a sync whose record write fails after replacing a rewritten archive copy leaves the record unchanged, and the next holds only the new content", () => {
  const home = withFixtures(scratchHome(), [LONG]);
  sync(home);
  const before = recordRows(home);
  const rewritten = [0, 1].map((n) =>
    claudeUserLine("long-session", `rewritten-${n}`, `2026-09-17T10:0${n}:00.000Z`, `rewritten step ${n}`),
  );
  writeFileSync(livePath(home, LONG), `${rewritten.join("\n")}\n`);

  syncFailingWrites(home, { table: "message", when: "NEW.id = 'rewritten-1'" });
  expect(readFileSync(archivedPath(home, LONG), "utf8")).toBe(readFileSync(livePath(home, LONG), "utf8"));
  expect(recordRows(home)).toEqual(before);

  sync(home);
  expect(messageTexts(home, "long-session")).toEqual([
    ["rewritten-0", "rewritten step 0"],
    ["rewritten-1", "rewritten step 1"],
  ]);
});

test("AC-28 a sync whose record write fails after keeping a restarted event log as a segment leaves its events unchanged, and the next records each event once", () => {
  const home = withEventLog(scratchHome(), "event-session", [
    { ts: "2026-10-14T10:00:00Z", event: "permission_prompt", tool: "Write" },
    { ts: "2026-10-14T10:01:00Z", event: "permission_prompt", tool: "Edit" },
  ]);
  sync(home);
  const events = "select src_file, src_line, ts, tool from hook_event order by src_file, src_line";
  const before = rowsOf(home, events);
  expect(before).toHaveLength(2);
  rmSync(eventLogPath(home));
  withEventLog(home, "event-session", [
    { ts: "2026-10-14T11:00:00Z", event: "permission_prompt", tool: "Read" },
  ]);

  syncFailingWrites(home, { table: "hook_event", when: "NEW.tool = 'Read'" });
  expect(rowsOf(home, events)).toEqual(before);

  sync(home);
  const log = archivedEventLog(home);
  const segment = join(dirname(log), "events-1.jsonl");
  expect(rowsOf(home, events)).toEqual([
    [segment, 1, "2026-10-14T10:00:00.000Z", "Write"],
    [segment, 2, "2026-10-14T10:01:00.000Z", "Edit"],
    [log, 1, "2026-10-14T11:00:00.000Z", "Read"],
  ]);
});
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
  const report = "## Notes\nnone\n\nOutcome: done";
  const home = withClaudeSessions(scratchHome(), [
    {
      id: "parent",
      cwd: "/Users/x/code/demo",
      steps: [{ owner: "review the parser", at: "2026-09-16T10:00:00Z" }],
      subagents: [
        {
          id: "judge",
          agentType: "acme:checker",
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
    where s.agent_type = 'acme:checker' and m.role = 'assistant' and m.text is not null
    order by m.ts desc limit 1`;

  const said = `Reviewed.\n${report}`;

  sync(home);
  expect(rowsOf(home, lastText)).toEqual([[said]]);
  rebuild(home);
  expect(rowsOf(home, lastText)).toEqual([[said]]);
});

test("AC-59 a checker a worker started is recorded under the worker, and an unlinked subagent is counted", () => {
  const home = withClaudeSessions(scratchHome(), [
    {
      id: "coordinator",
      cwd: "/Users/x/code/demo",
      steps: [
        { owner: "run the task", at: "2026-09-16T10:00:00Z" },
        { spawn: "toolu-worker", at: "2026-09-16T10:01:00Z", done: "2026-09-16T10:09:00Z" },
      ],
      subagents: [
        {
          id: "checker",
          agentType: "acme:checker",
          startedBy: "toolu-checker",
          steps: [{ owner: "judge the diff", at: "2026-09-16T10:03:00Z" }],
        },
        {
          id: "worker",
          agentType: "general-purpose",
          startedBy: "toolu-worker",
          steps: [
            { owner: "build the step", at: "2026-09-16T10:01:01Z" },
            { spawn: "toolu-checker", at: "2026-09-16T10:02:59Z", done: "2026-09-16T10:04:00Z" },
          ],
        },
        {
          id: "older",
          agentType: "Explore",
          steps: [{ owner: "look around", at: "2026-09-16T10:05:00Z" }],
        },
      ],
    },
  ]);
  const parents = "select id, parent_id from session order by id";
  const linked = [
    ["checker@coordinator", "worker@coordinator"],
    ["coordinator", null],
    ["older@coordinator", "coordinator"],
    ["worker@coordinator", "coordinator"],
  ];

  expect(sync(home).unlinkedSubagents).toBe(1);
  expect(rowsOf(home, parents)).toEqual(linked);
  expect(rebuild(home).unlinkedSubagents).toBe(1);
  expect(rowsOf(home, parents)).toEqual(linked);
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

const FAILING = "error-session";
const KEPT_END = 2048;
const cutAround = (text: string): string =>
  `${text.slice(0, KEPT_END)}\n... [${text.length - 2 * KEPT_END} bytes cut] ...\n${text.slice(-KEPT_END)}`;

test("AC-71 a failed or refused call keeps its result's head and tail as its error text, and a call that succeeded keeps none", () => {
  const refusal = `<tool_use_error>InputValidationError: ${"the edit's old_string was not found. ".repeat(150)}</tool_use_error>`;
  const listing = `Exit code 127\n${"src/ingest-parse-claude.ts\n".repeat(300)}zsh: command not found: ===`;
  const codexOutput = `${"compiling crate\n".repeat(400)}error[E0425]: cannot find value \`x\``;
  const home = withClaudeSessions(withFixtures(scratchHome(), [CODEX, GROK, PI]), [
    {
      id: FAILING,
      cwd: "/Users/x/code/demo",
      steps: [
        { owner: "fix the build", at: "2026-10-16T09:00:00.000Z" },
        { errored: "edit the parser", at: "2026-10-16T09:01:00.000Z", output: refusal },
        { errored: "ls -R src; echo ===", at: "2026-10-16T09:02:00.000Z", output: listing },
        { errored: "bun run check", at: "2026-10-16T09:03:00.000Z", output: "Exit code 1\nlint: 2 errors" },
        { bash: "ls", at: "2026-10-16T09:04:00.000Z", done: "2026-10-16T09:04:01.000Z" },
      ],
    },
  ]);
  appendFileSync(
    livePath(home, CODEX),
    `${JSON.stringify({
      type: "event_msg",
      timestamp: "2026-09-16T10:07:00.000Z",
      payload: {
        type: "item_completed",
        item: {
          id: `${CODEX_THREAD}-failed`,
          type: "CommandExecution",
          command: "cargo build",
          status: "failed",
          exit_code: 101,
          stdout: "",
          stderr: codexOutput,
        },
      },
    })}\n`,
  );
  appendFileSync(
    livePath(home, GROK_UPDATES),
    `${JSON.stringify({
      timestamp: 1789553070,
      method: "session/update",
      params: {
        sessionId: "grok-session",
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "grok-failed",
          status: "failed",
          rawInput: { command: "rm -rf build" },
          content: [{ type: "content", content: { type: "text", text: "Denied by permission policy" } }],
        },
        _meta: { eventId: "g-failed", agentTimestampMs: 1789553070000 },
      },
    })}\n`,
  );
  appendFileSync(
    livePath(home, GROK_UPDATES),
    `${JSON.stringify({
      timestamp: 1789553071,
      method: "session/update",
      params: {
        sessionId: "grok-session",
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "grok-exited",
          status: "completed",
          rawInput: { command: "bun test" },
          rawOutput: { type: "Bash", exit_code: 1 },
          content: [{ type: "content", content: { type: "text", text: "1 fail" } }],
        },
        _meta: { eventId: "g-exited", agentTimestampMs: 1789553071000 },
      },
    })}\n`,
  );
  appendFileSync(
    livePath(home, PI),
    `${JSON.stringify({
      type: "message",
      id: "pi-failed-result",
      timestamp: "2026-09-16T10:04:30.000Z",
      message: {
        role: "toolResult",
        toolCallId: "pi-failed",
        toolName: "bash",
        isError: true,
        content: [{ type: "text", text: "boom\n\nCommand exited with code 4" }],
      },
    })}\n`,
  );
  const errorTexts = `select id, error_text from tool_call
    where session_id in ('${FAILING}', '${CODEX_THREAD}') order by session_id desc, src_line_call`;
  const otherTexts =
    "select id, error_text from tool_call where session_id in ('grok-session', 'pi-session') order by id";
  const expected = [
    [`${FAILING}-1-tool`, cutAround(refusal)],
    [`${FAILING}-2-tool`, cutAround(listing)],
    [`${FAILING}-3-tool`, "Exit code 1\nlint: 2 errors"],
    [`${FAILING}-4-tool`, null],
    [`${CODEX_THREAD}-c1`, null],
    [`${CODEX_THREAD}-c2`, null],
    [`${CODEX_THREAD}-failed`, cutAround(codexOutput)],
  ];
  const others = [
    ["g-call-1", null],
    ["grok-exited", "1 fail"],
    ["grok-failed", "Denied by permission policy"],
    ["pi-failed", "boom\n\nCommand exited with code 4"],
    ["pi-session-call1", null],
  ];

  sync(home);
  const rows = rowsOf(home, errorTexts);
  expect(rows).toEqual(expected);
  expect(String(rows[0]?.[1])).toStartWith("<tool_use_error>InputValidationError: ");
  expect(String(rows[1]?.[1])).toEndWith("zsh: command not found: ===");
  expect(String(rows[6]?.[1])).toEndWith("error[E0425]: cannot find value `x`");
  expect(rowsOf(home, otherTexts)).toEqual(others);
  rebuild(home);
  expect(rowsOf(home, errorTexts)).toEqual(expected);
  expect(rowsOf(home, otherTexts)).toEqual(others);
});

test("AC-72 a secret-shaped string in a failed call's result is redacted from its error text", () => {
  const key = "sk-ant-api03-test-not-a-real-key-0000000";
  const token = `ghp_${"x".repeat(36)}`;
  const home = withClaudeSessions(scratchHome(), [
    {
      id: FAILING,
      cwd: "/Users/x/code/demo",
      steps: [
        { owner: "publish it", at: "2026-10-16T09:00:00.000Z" },
        {
          errored: "npm publish",
          at: "2026-10-16T09:01:00.000Z",
          output: `Exit code 1\nANTHROPIC_API_KEY=${key}\nAuthorization: token ${token}\nnpm error 401 Unauthorized`,
        },
      ],
    },
  ]);

  sync(home);
  expect(rowsOf(home, `select error_text from tool_call where session_id = '${FAILING}'`)).toEqual([
    [
      "Exit code 1\nANTHROPIC_API_KEY=[REDACTED]\nAuthorization: token [REDACTED]\nnpm error 401 Unauthorized",
    ],
  ]);
});

test("AC-75 a value given to a name ending in _TOKEN or _SECRET is masked in every table the record holds", () => {
  const token = "CLAUDE_CODE_MESSAGING_TOKEN=0123456789abcdef0123456789abcdef";
  const secret = "NPM_PUBLISH_SECRET=test-secret-value";
  const titled = withCodexTitle(withFixtures(scratchHome(), [CODEX]), CODEX_THREAD, `Set ${secret}`);
  const home = withClaudeSessions(titled, [
    {
      id: FAILING,
      cwd: "/Users/x/code/demo",
      steps: [
        { owner: `run it with ${token} and ${secret} set`, at: "2026-10-16T09:00:00.000Z" },
        {
          bash: `${token} ${secret} bun run publish`,
          at: "2026-10-16T09:01:00.000Z",
          done: "2026-10-16T09:01:01.000Z",
        },
        {
          errored: "env | grep SECRET",
          at: "2026-10-16T09:02:00.000Z",
          output: `Exit code 1\n${secret}\n${token}`,
        },
        { rejected: "cat .env", at: "2026-10-16T09:03:00.000Z", feedback: `no, it holds ${secret}` },
      ],
    },
  ]);

  sync(home);
  expect(columnsHolding(home, "0123456789abcdef0123456789abcdef")).toEqual([]);
  expect(columnsHolding(home, "test-secret-value")).toEqual([]);
  expect(
    rowsOf(
      home,
      `select text from message where session_id = '${FAILING}' and role = 'user' and text like 'run it%'`,
    ),
  ).toEqual([["run it with CLAUDE_CODE_MESSAGING_TOKEN=[REDACTED] and NPM_PUBLISH_SECRET=[REDACTED] set"]]);
  expect(
    rowsOf(home, `select command, error_text from tool_call where session_id = '${FAILING}' order by id`),
  ).toEqual([
    ["CLAUDE_CODE_MESSAGING_TOKEN=[REDACTED] NPM_PUBLISH_SECRET=[REDACTED] bun run publish", null],
    [
      "env | grep SECRET",
      "Exit code 1\nNPM_PUBLISH_SECRET=[REDACTED]\nCLAUDE_CODE_MESSAGING_TOKEN=[REDACTED]",
    ],
    ["cat .env", null],
  ]);
  expect(
    rowsOf(
      home,
      `select user_feedback from message where session_id = '${FAILING}' and user_feedback is not null`,
    ),
  ).toEqual([["no, it holds NPM_PUBLISH_SECRET=[REDACTED]"]]);
  expect(rowsOf(home, `select title from session where id = '${CODEX_THREAD}'`)).toEqual([
    ["Set NPM_PUBLISH_SECRET=[REDACTED]"],
  ]);
});

test("AC-73 a call's duration is the one its tool reports, or else runs from the call to its result", () => {
  const home = withClaudeSessions(withFixtures(scratchHome(), [CODEX, GROK, PI]), [
    {
      id: FAILING,
      cwd: "/Users/x/code/demo",
      steps: [
        { owner: "run the tests", at: "2026-10-16T09:00:00.000Z" },
        { bash: "bun test", at: "2026-10-16T09:01:00.000Z", done: "2026-10-16T09:01:01.500Z" },
        { pending: "bun run acceptance", at: "2026-10-16T09:02:00.000Z" },
      ],
    },
  ]);
  appendFileSync(
    livePath(home, CODEX),
    `${JSON.stringify({
      type: "event_msg",
      timestamp: "2026-09-16T10:07:00.000Z",
      payload: {
        type: "item_completed",
        item: {
          id: `${CODEX_THREAD}-timed`,
          type: "CommandExecution",
          command: "cargo test",
          status: "completed",
          exit_code: 0,
          duration: { secs: 2, nanos: 500000000 },
        },
      },
    })}\n`,
  );
  const durations = `select id, duration_ms from tool_call
    where session_id in ('${FAILING}', '${CODEX_THREAD}', 'grok-session', 'pi-session') order by id`;
  const expected = [
    [`${CODEX_THREAD}-c1`, null],
    [`${CODEX_THREAD}-c2`, null],
    [`${CODEX_THREAD}-timed`, 2500],
    [`${FAILING}-1-tool`, 1500],
    [`${FAILING}-2-tool`, null],
    ["g-call-1", 60000],
    ["pi-session-call1", 60000],
  ];

  sync(home);
  expect(rowsOf(home, durations)).toEqual(expected);
  rebuild(home);
  expect(rowsOf(home, durations)).toEqual(expected);
});
