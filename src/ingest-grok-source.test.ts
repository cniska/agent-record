import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { openDb } from "./db";
import { NO_WAIT_MS } from "./db-read.test-support";
import type { Env } from "./env";
import { errorCode } from "./error-read";
import { archivedPath, grokUpdate, scratchEnv } from "./fixtures.test-support";
import { listSource, SESSION_SOURCES } from "./ingest-sources";
import { sync } from "./ingest-sync";
import { dbPath, grokSessionsDir } from "./paths";

const PARENT = "018f3b2a-7c3e-7b2a-8f1e-6c0b9a2d4e11";
const CHILD = "018f3b2a-7c3e-7b2a-8f1e-6c0b9a2d4e22";
const ORPHAN = "018f3b2a-7c3e-7b2a-8f1e-6c0b9a2d4e44";
const AT = 1700000000000;
const roots: string[] = [];

function newRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "agent-record-grok-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function event(update: unknown, eventId: string, ms = AT): unknown {
  return grokUpdate(PARENT, update, eventId, ms);
}

function writeSession(
  env: Env,
  id: string,
  lines: unknown[],
  summary: Record<string, unknown>,
  group = "%2FUsers%2Fx%2Fcode%2Fdemo",
): string {
  const dir = join(grokSessionsDir(env), group, id);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "updates.jsonl");
  writeFileSync(path, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
  writeFileSync(join(dir, "summary.json"), JSON.stringify(summary));
  return path;
}

function parentSummary(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    info: { id: PARENT, cwd: "/Users/x/code/demo" },
    generated_title: "import grok",
    current_model_id: "grok-4.7",
    head_branch: "main",
    created_at: "2023-11-14T22:13:20.000Z",
    agent_name: "grok-build",
    ...extra,
  };
}

function seed(env: Env): string {
  const path = writeSession(
    env,
    PARENT,
    [
      event({ sessionUpdate: "user_message_chunk", content: { type: "text", text: "hello" } }, "user-1"),
      event(
        { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "THINKING_SECRET" } },
        "thought-1",
        AT + 1,
      ),
      event(
        {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "working" },
          _meta: { modelId: "grok-4.7" },
        },
        "agent-1",
        AT + 2,
      ),
      event(
        {
          sessionUpdate: "tool_call",
          toolCallId: "call-1",
          rawInput: { target_file: "src/a.ts" },
          _meta: { "x.ai/tool": { name: "read_file" } },
        },
        "tool-1",
        AT + 3,
      ),
      event(
        {
          sessionUpdate: "tool_call_update",
          toolCallId: "call-1",
          status: "completed",
          output: "SECRET_RESULT",
        },
        "tool-1-done",
        AT + 4,
      ),
      event(
        {
          sessionUpdate: "tool_call",
          toolCallId: "call-2",
          rawInput: { command: "echo hi" },
          _meta: { "x.ai/tool": { name: "run_terminal_command" } },
        },
        "tool-2",
        AT + 5,
      ),
      event(
        {
          sessionUpdate: "tool_call_update",
          toolCallId: "call-2",
          status: "failed",
        },
        "tool-2-done",
        AT + 6,
      ),
    ],
    parentSummary(),
  );
  writeFileSync(path, "{\n", { flag: "a" });
  writeSession(
    env,
    CHILD,
    [event({ sessionUpdate: "user_message_chunk", content: { type: "text", text: "child" } }, "child-1")],
    {
      info: { id: CHILD, cwd: "/Users/x/code/demo" },
      parent_session_id: PARENT,
      agent_name: "explore",
      created_at: "2023-11-14T22:13:20.000Z",
    },
  );
  writeSession(
    env,
    ORPHAN,
    [event({ sessionUpdate: "user_message_chunk", content: { type: "text", text: "orphan" } }, "orphan-1")],
    {
      info: { id: ORPHAN, cwd: "/Users/x/code/demo" },
      parent_session_id: "missing-parent",
      created_at: "2023-11-14T22:13:20.000Z",
    },
  );
  return path;
}

const read = (sessionUpdate: string, eventId: string, ms: number) =>
  event(
    {
      sessionUpdate,
      toolCallId: "call-4",
      rawInput: { target_file: "/Users/x/.agents/skills/plan/SKILL.md" },
      _meta: { "x.ai/tool": { name: "read_file" } },
    },
    eventId,
    ms,
  );

describe("grok sessions", () => {
  test("takes the session's first time from its transcript", () => {
    const env = scratchEnv(newRoot());
    writeSession(
      env,
      PARENT,
      [event({ sessionUpdate: "user_message_chunk", content: { type: "text", text: "hello" } }, "user-1")],
      parentSummary({ created_at: "2023-11-14T21:00:00.000Z" }),
    );
    const db = openDb(dbPath(env), { heldRecordWaitMs: NO_WAIT_MS });
    try {
      sync(db, env);
      expect(db.prepare("SELECT ts_first, ts_last FROM session WHERE id = ?").get(PARENT)).toEqual({
        ts_first: "2023-11-14T22:13:20.000Z",
        ts_last: "2023-11-14T22:13:20.000Z",
      });
    } finally {
      db.close();
    }
  });

  test("a call's command and path that arrive in later updates reach its row", () => {
    const env = scratchEnv(newRoot());
    writeSession(
      env,
      PARENT,
      [
        event({ sessionUpdate: "tool_call", toolCallId: "call-3" }, "tool-3"),
        event(
          {
            sessionUpdate: "tool_call_update",
            toolCallId: "call-3",
            status: "in_progress",
            rawInput: { command: "git status" },
          },
          "tool-3-run",
          AT + 1,
        ),
        event(
          {
            sessionUpdate: "tool_call_update",
            toolCallId: "call-3",
            status: "completed",
            locations: [{ path: "a.ts" }],
          },
          "tool-3-done",
          AT + 2,
        ),
      ],
      parentSummary(),
    );
    const db = openDb(dbPath(env), { heldRecordWaitMs: NO_WAIT_MS });
    try {
      sync(db, env);
      expect(
        db
          .prepare(
            "SELECT command, file_path, ts_call, ts_result, src_line_call, src_line_result FROM tool_call",
          )
          .all(),
      ).toEqual([
        {
          command: "git status",
          file_path: "a.ts",
          ts_call: "2023-11-14T22:13:20.000Z",
          ts_result: "2023-11-14T22:13:20.002Z",
          src_line_call: 1,
          src_line_result: 3,
        },
      ]);
      expect(db.prepare("SELECT subcommand FROM git_command").all()).toEqual([{ subcommand: "status" }]);
    } finally {
      db.close();
    }
  });

  test("a read of a skill's SKILL.md named again by its updates is one load, at the call's time", () => {
    const env = scratchEnv(newRoot());
    writeSession(
      env,
      PARENT,
      [read("tool_call", "tool-4", AT), read("tool_call_update", "tool-4-run", AT + 1)],
      parentSummary(),
    );
    const db = openDb(dbPath(env), { heldRecordWaitMs: NO_WAIT_MS });
    try {
      sync(db, env);
      expect(db.prepare("SELECT tool_call_id, ts, skill_name, how FROM skill_load").all()).toEqual([
        { tool_call_id: "call-4", ts: "2023-11-14T22:13:20.000Z", skill_name: "plan", how: "read" },
      ]);
    } finally {
      db.close();
    }
  });

  test("keeps prompts and tool names, and drops thinking and tool results", () => {
    const env = scratchEnv(newRoot());
    const path = seed(env);
    const db = openDb(dbPath(env), { heldRecordWaitMs: NO_WAIT_MS });
    try {
      const report = sync(db, env);
      expect(report.sources.find((source) => source.tool === "grok")).toEqual({ tool: "grok", files: 3 });
      expect(report.dropped).toEqual([{ path: archivedPath("grok", path, env), lines: [8] }]);
      expect(report.orphanSubagents).toEqual<string[]>([ORPHAN]);
      expect(
        db
          .prepare("SELECT id, tool, cwd, title, git_branch, agent_type, parent_id FROM session WHERE id = ?")
          .get(PARENT),
      ).toEqual({
        id: PARENT,
        tool: "grok",
        cwd: "/Users/x/code/demo",
        title: "import grok",
        git_branch: "main",
        agent_type: "grok-build",
        parent_id: null,
      });
      expect(
        db.prepare("SELECT role, text FROM message WHERE session_id = ? ORDER BY ts").all(PARENT),
      ).toEqual([
        { role: "user", text: "hello" },
        { role: "assistant", text: "working" },
      ]);
      expect(
        db
          .prepare(
            "SELECT id, tool_name, file_path, command, is_error FROM tool_call WHERE session_id = ? ORDER BY id",
          )
          .all(PARENT),
      ).toEqual([
        { id: "call-1", tool_name: "read_file", file_path: "src/a.ts", command: null, is_error: null },
        { id: "call-2", tool_name: "run_terminal_command", file_path: null, command: "echo hi", is_error: 1 },
      ]);
      expect(db.prepare("SELECT parent_id, agent_type FROM session WHERE id = ?").get(CHILD)).toEqual({
        parent_id: PARENT,
        agent_type: "explore",
      });
      expect(db.prepare("SELECT parent_id FROM session WHERE id = ?").get(ORPHAN)).toEqual({
        parent_id: null,
      });
      const stored =
        JSON.stringify(db.prepare("SELECT text FROM message").all()) +
        JSON.stringify(db.prepare("SELECT command FROM tool_call").all());
      expect(stored).not.toContain("THINKING_SECRET");
      expect(stored).not.toContain("SECRET_RESULT");
    } finally {
      db.close();
    }
  });

  test("reading the same files again changes nothing", () => {
    const env = scratchEnv(newRoot());
    seed(env);
    const db = openDb(dbPath(env), { heldRecordWaitMs: NO_WAIT_MS });
    try {
      sync(db, env);
      const again = sync(db, env);
      expect(again.filesRead).toBe(0);
      expect(db.prepare("SELECT count(*) AS n FROM message").get()).toEqual({ n: 4 });
    } finally {
      db.close();
    }
  });

  test("names a summary.json that fails its schema as unreadable and lists the session without it", () => {
    const env = scratchEnv(newRoot());
    const path = writeSession(env, ORPHAN, [], { info: { id: 5 }, parent_session_id: PARENT });
    const summary = join(dirname(path), "summary.json");
    const failures: { path: string; error: unknown }[] = [];
    const [spec] = listSource(SESSION_SOURCES.grok, SESSION_SOURCES.grok.root(env), (failed, error) =>
      failures.push({ path: failed, error }),
    );
    expect(spec?.sessionId).toBe<string>(ORPHAN);
    expect(spec?.parentId).toBeNull();
    expect(failures).toEqual([
      {
        path: summary,
        error: expect.objectContaining({
          kind: "refusal",
          code: "sidecar_unreadable",
          meta: { path: summary, detail: "info.id: Invalid input: expected string, received number" },
        }),
      },
    ]);
  });

  test("names a summary.json whose session id is empty as unreadable", () => {
    const env = scratchEnv(newRoot());
    const path = writeSession(env, ORPHAN, [], { info: { id: "" }, parent_session_id: PARENT });
    const summary = join(dirname(path), "summary.json");
    const failures: { path: string; code: unknown }[] = [];
    const [spec] = listSource(SESSION_SOURCES.grok, SESSION_SOURCES.grok.root(env), (failed, error) =>
      failures.push({ path: failed, code: errorCode(error) }),
    );
    expect(spec?.sessionId).toBe<string>(ORPHAN);
    expect(spec?.parentId).toBeNull();
    expect(failures).toEqual([{ path: summary, code: "sidecar_unreadable" }]);
  });

  test("names a summary.json that is not JSON as unreadable", () => {
    const env = scratchEnv(newRoot());
    const path = writeSession(env, ORPHAN, [], {});
    const summary = join(dirname(path), "summary.json");
    writeFileSync(summary, "{ cut");
    const failures: { path: string; code: unknown }[] = [];
    listSource(SESSION_SOURCES.grok, SESSION_SOURCES.grok.root(env), (failed, error) =>
      failures.push({ path: failed, code: errorCode(error) }),
    );
    expect(failures).toEqual([{ path: summary, code: "sidecar_unreadable" }]);
  });

  test("names nothing for a session with no summary.json", () => {
    const env = scratchEnv(newRoot());
    const path = writeSession(env, ORPHAN, [], {});
    rmSync(join(dirname(path), "summary.json"));
    const failures: unknown[] = [];
    const [spec] = listSource(SESSION_SOURCES.grok, SESSION_SOURCES.grok.root(env), (_, error) =>
      failures.push(error),
    );
    expect(spec?.sessionId).toBe<string>(ORPHAN);
    expect(failures).toEqual([]);
  });
});
