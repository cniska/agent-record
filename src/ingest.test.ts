import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { openDb } from "./db";
import {
  archivedPath,
  asUnprivileged,
  bytesThroughLine,
  claudeTranscriptLines,
  codexRolloutLines,
  fullBytes,
  scratchEnv,
  withoutTimestamp,
  writeClaudeTranscript,
  writeCodexRollout,
  writePrefix,
} from "./fixtures.test-support";
import { rebuild, sync } from "./ingest-sync";
import { archiveDir, claudeProjectsDir, codexDir, dbPath, type Env } from "./paths";

const SESSION = "11111111-2222-3333-4444-555555555555";
const THREAD = "01a0a651-086e-7150-8650-cef0f4025a58";
const roots: string[] = [];

function newRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "agent-record-test-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function run(env: Env): Database {
  const db = openDb(dbPath(env));
  sync(db, env);
  return db;
}

function snapshot(db: Database, root: string) {
  const strip = (rows: Record<string, unknown>[]): Record<string, unknown>[] =>
    rows.map((r) => ({
      ...r,
      src_file: typeof r.src_file === "string" ? r.src_file.replace(root, "") : r.src_file,
    }));
  return {
    sessions: db
      .prepare<Record<string, unknown>, []>(
        `SELECT id, tool, parent_id, agent_type, cwd, project, git_branch, cli_version, entrypoint,
                ts_first, ts_last, title FROM session ORDER BY id`,
      )
      .all(),
    messages: strip(
      db
        .prepare<Record<string, unknown>, []>(
          `SELECT id, session_id, role, model, ts, text, text_chars, src_file, src_line,
                  is_meta, is_skill_body, denial_kind, user_feedback FROM message ORDER BY id`,
        )
        .all(),
    ),
    usage: db
      .prepare<Record<string, unknown>, []>(
        `SELECT response_id, session_id, message_id, model, input_tokens, cache_read_tokens,
                cache_write_tokens, output_tokens FROM usage ORDER BY response_id`,
      )
      .all(),
    turns: db
      .prepare<Record<string, unknown>, []>(
        `SELECT session_id, turn_id, ts_start, ts_end, duration_ms, message_count, status, model,
                time_to_first_token_ms FROM turn ORDER BY session_id, turn_id`,
      )
      .all(),
  };
}

describe("ingest", () => {
  test("deduplicates usage on the message id, so tokens are not counted per content block", () => {
    const root = newRoot();
    const env = scratchEnv(root);
    writeClaudeTranscript(env, "-Users-x-code-demo", SESSION);
    const db = run(env);
    try {
      expect(db.prepare("SELECT count(*) AS n FROM usage").get()).toEqual({ n: 1 });
      expect(db.prepare("SELECT sum(output_tokens) AS n FROM usage").get()).toEqual({ n: 50 });
    } finally {
      db.close();
    }
  });

  test("joins the content blocks of one response into a single message", () => {
    const root = newRoot();
    const env = scratchEnv(root);
    writeClaudeTranscript(env, "-Users-x-code-demo", SESSION);
    const db = run(env);
    try {
      const row = db.prepare<{ text: string }, []>("SELECT text FROM message WHERE id = 'msg-1'").get();
      expect(row?.text).toBe("First half.\nSecond half.");
    } finally {
      db.close();
    }
  });

  test("never stores tool results, file contents or thinking", () => {
    const root = newRoot();
    const env = scratchEnv(root);
    writeClaudeTranscript(env, "-Users-x-code-demo", SESSION);
    const db = run(env);
    try {
      const all = JSON.stringify(snapshot(db, root));
      expect(all).not.toContain("SECRET FILE CONTENTS");
      expect(all).not.toContain("SECRET REASONING");
    } finally {
      db.close();
    }
  });

  test("records turn timing from both tools", () => {
    const root = newRoot();
    const env = scratchEnv(root);
    writeClaudeTranscript(env, "-Users-x-code-demo", SESSION);
    writeCodexRollout(env, "sessions", THREAD);
    const db = run(env);
    try {
      expect(
        db
          .prepare(
            "SELECT turn_id, duration_ms, message_count, status FROM turn WHERE turn_id = 'turn-1' AND session_id = ?",
          )
          .get(SESSION),
      ).toEqual({
        turn_id: "turn-1",
        duration_ms: 7193,
        message_count: 13,
        status: "completed",
      });
      expect(
        db
          .prepare("SELECT status, duration_ms, model FROM turn WHERE session_id = ? ORDER BY turn_id")
          .all(THREAD),
      ).toEqual([
        { status: "completed", duration_ms: 151652, model: "gpt-5.6-luna" },
        { status: "interrupted", duration_ms: 8128, model: "gpt-5.6-sol" },
      ]);
    } finally {
      db.close();
    }
  });

  test("keeps the assistant reply that rides along with a completed Codex turn out of the database", () => {
    const root = newRoot();
    const env = scratchEnv(root);
    writeCodexRollout(env, "sessions", THREAD);
    const db = run(env);
    try {
      const dump = db
        .prepare<{ t: string }, []>("SELECT group_concat(coalesce(text,'')) AS t FROM message")
        .get();
      expect(JSON.stringify(snapshot(db, root))).not.toContain("SECRET AGENT MESSAGE");
      expect(dump?.t).not.toContain("SECRET AGENT MESSAGE");
    } finally {
      db.close();
    }
  });

  test("joins a tool call to its result, which arrive as separate records", () => {
    const root = newRoot();
    const env = scratchEnv(root);
    writeClaudeTranscript(env, "-Users-x-code-demo", SESSION);
    const db = run(env);
    try {
      expect(
        db
          .prepare(
            "SELECT tool_name, command, is_error, ts_call IS NOT NULL AS called, ts_result IS NOT NULL AS resulted, result_bytes FROM tool_call WHERE id = 'toolu-1'",
          )
          .get(),
      ).toEqual({
        tool_name: "Bash",
        command: "ls",
        is_error: 0,
        called: 1,
        resulted: 1,
        result_bytes: 40,
      });
    } finally {
      db.close();
    }
  });

  test("measures what a tool returned without storing any of it", () => {
    const root = newRoot();
    const env = scratchEnv(root);
    writeClaudeTranscript(env, "-Users-x-code-demo", SESSION);
    const db = run(env);
    try {
      const dump = JSON.stringify(db.prepare<Record<string, unknown>, []>("SELECT * FROM tool_call").all());
      expect(dump).not.toContain("SECRET FILE CONTENTS");
      expect(
        db.prepare("SELECT result_bytes, src_line_result FROM tool_call WHERE id = 'toolu-1'").get(),
      ).toMatchObject({ result_bytes: 40 });
    } finally {
      db.close();
    }
  });

  test("records Codex exit codes and durations, which Claude does not report", () => {
    const root = newRoot();
    const env = scratchEnv(root);
    writeCodexRollout(env, "sessions", THREAD);
    writeClaudeTranscript(env, "-Users-x-code-demo", SESSION);
    const db = run(env);
    try {
      const claude = db
        .prepare("SELECT count(*) AS n FROM tool_call WHERE session_id = ? AND exit_code IS NOT NULL")
        .get(SESSION);
      expect(claude).toEqual({ n: 0 });
    } finally {
      db.close();
    }
  });

  test("re-syncing an unchanged corpus changes nothing", () => {
    const root = newRoot();
    const env = scratchEnv(root);
    writeClaudeTranscript(env, "-Users-x-code-demo", SESSION);
    writeCodexRollout(env, "sessions", THREAD);
    const db = run(env);
    try {
      const before = snapshot(db, root);
      sync(db, env);
      sync(db, env);
      expect(snapshot(db, root)).toEqual(before);
    } finally {
      db.close();
    }
  });

  test("reading a file in two chunks matches reading it once, even cut mid-line", () => {
    const lines = claudeTranscriptLines(SESSION);
    const cut = bytesThroughLine(lines, 2) + 40;

    const oneRoot = newRoot();
    const oneEnv = scratchEnv(oneRoot);
    writeClaudeTranscript(oneEnv, "-Users-x-code-demo", SESSION);
    const oneDb = run(oneEnv);
    const expected = snapshot(oneDb, oneRoot);
    oneDb.close();

    const incRoot = newRoot();
    const incEnv = scratchEnv(incRoot);
    const path = join(claudeProjectsDir(incEnv), "-Users-x-code-demo", `${SESSION}.jsonl`);
    writePrefix(path, lines, cut);
    const incDb = run(incEnv);
    writePrefix(path, lines, fullBytes(lines));
    sync(incDb, incEnv);
    try {
      expect(snapshot(incDb, incRoot)).toEqual(expected);
    } finally {
      incDb.close();
    }
  });

  test("a chunk boundary inside one response's content blocks matches reading it once", () => {
    const lines = claudeTranscriptLines(SESSION);
    const cut = bytesThroughLine(lines, 2);

    const oneRoot = newRoot();
    const oneEnv = scratchEnv(oneRoot);
    writeClaudeTranscript(oneEnv, "-Users-x-code-demo", SESSION);
    const oneDb = run(oneEnv);
    const expected = snapshot(oneDb, oneRoot);
    oneDb.close();

    const incRoot = newRoot();
    const incEnv = scratchEnv(incRoot);
    const path = join(claudeProjectsDir(incEnv), "-Users-x-code-demo", `${SESSION}.jsonl`);
    writePrefix(path, lines, cut);
    const incDb = run(incEnv);
    expect(
      incDb.prepare<{ text: string }, []>("SELECT text FROM message WHERE id = 'msg-1'").get()?.text,
    ).toBe("First half.");
    writePrefix(path, lines, fullBytes(lines));
    sync(incDb, incEnv);
    try {
      expect(snapshot(incDb, incRoot)).toEqual(expected);
    } finally {
      incDb.close();
    }
  });

  test("a file that shrank is re-read from the start rather than left inconsistent", () => {
    const lines = claudeTranscriptLines(SESSION);

    const oneRoot = newRoot();
    const oneEnv = scratchEnv(oneRoot);
    writeClaudeTranscript(oneEnv, "-Users-x-code-demo", SESSION);
    const oneDb = run(oneEnv);
    const expected = snapshot(oneDb, oneRoot);
    oneDb.close();

    const root = newRoot();
    const env = scratchEnv(root);
    const path = join(claudeProjectsDir(env), "-Users-x-code-demo", `${SESSION}.jsonl`);
    writePrefix(path, lines, fullBytes(lines));
    const db = run(env);
    writePrefix(path, lines, bytesThroughLine(lines, 1));
    sync(db, env);
    writePrefix(path, lines, fullBytes(lines));
    sync(db, env);
    try {
      expect(snapshot(db, root)).toEqual(expected);
    } finally {
      db.close();
    }
  });

  const sidecarLines = [
    { type: "custom-title", customTitle: "Side", sessionId: SESSION },
    { type: "last-prompt", lastPrompt: "Go on.", sessionId: SESSION },
  ];

  function writeTwoFileSession(env: Env, transcriptLines: number, sidecarCount: number): void {
    const lines = claudeTranscriptLines(SESSION);
    writePrefix(
      join(claudeProjectsDir(env), "-Users-x-code-demo", `${SESSION}.jsonl`),
      lines,
      bytesThroughLine(lines, transcriptLines - 1),
    );
    writePrefix(
      join(claudeProjectsDir(env), "-Users-x-code-demo--claude-worktrees-w", `${SESSION}.jsonl`),
      sidecarLines,
      bytesThroughLine(sidecarLines, sidecarCount - 1),
    );
  }

  test("reads two coexisting files of one session once each, keeping every row", () => {
    const root = newRoot();
    const env = scratchEnv(root);
    writeTwoFileSession(env, claudeTranscriptLines(SESSION).length, sidecarLines.length);
    const db = run(env);
    try {
      const before = snapshot(db, root);
      const second = sync(db, env);
      expect(second.failures).toEqual([]);
      expect(second.filesRead).toBe(0);
      expect(snapshot(db, root)).toEqual(before);
      expect(before.messages.length).toBeGreaterThan(0);
      expect(db.prepare("SELECT count(*) AS n FROM source_file").get()).toEqual({ n: 2 });
    } finally {
      db.close();
    }
  });

  for (const shrunk of ["transcript", "sidecar"] as const) {
    test(`re-reads every file of a session in one sync when its ${shrunk} shrank`, () => {
      const full = claudeTranscriptLines(SESSION).length;
      const after: [number, number] = shrunk === "transcript" ? [2, sidecarLines.length] : [full, 1];

      const oneRoot = newRoot();
      const oneEnv = scratchEnv(oneRoot);
      writeTwoFileSession(oneEnv, ...after);
      const oneDb = run(oneEnv);
      const expected = snapshot(oneDb, oneRoot);
      oneDb.close();

      const root = newRoot();
      const env = scratchEnv(root);
      writeTwoFileSession(env, full, sidecarLines.length);
      const db = run(env);
      writeTwoFileSession(env, ...after);
      try {
        expect(sync(db, env).failures).toEqual([]);
        expect(snapshot(db, root)).toEqual(expected);
      } finally {
        db.close();
      }
    });
  }

  test("a rollout Codex archives keeps one source row and is not read twice", () => {
    const root = newRoot();
    const env = scratchEnv(root);
    const from = writeCodexRollout(env, "sessions", THREAD);
    const db = run(env);
    try {
      const before = snapshot(db, root);

      const to = join(codexDir(env), "archived_sessions", basename(from));
      mkdirSync(dirname(to), { recursive: true });
      renameSync(from, to);
      expect(sync(db, env).failures).toEqual([]);

      const after = snapshot(db, root);
      expect(after.messages.map((m) => m.text)).toEqual(before.messages.map((m) => m.text));
      expect(db.prepare("SELECT count(*) AS n FROM source_file").get()).toEqual({ n: 1 });
      const src = db.prepare<{ src_file: string }, []>("SELECT src_file FROM message LIMIT 1").get();
      expect(src?.src_file).toContain("archived_sessions");
    } finally {
      db.close();
    }
  });

  test("reads a new file of a session from the start when an older one under another name is gone", () => {
    const root = newRoot();
    const env = scratchEnv(root);
    const from = writeCodexRollout(env, "sessions", THREAD);
    const db = run(env);
    try {
      const to = join(dirname(from), `rollout-2026-09-16T11-00-00-${THREAD}.jsonl`);
      renameSync(from, to);
      const report = sync(db, env);
      expect(report.failures).toEqual([]);
      expect(report.filesRead).toBe(1);
      expect(
        db
          .prepare<{ bytes_ingested: number }, [string]>(
            "SELECT bytes_ingested FROM source_file WHERE path = ?",
          )
          .get(archivedPath("codex", to, env)),
      ).toEqual({ bytes_ingested: fullBytes(codexRolloutLines(THREAD, { withIds: true })) });
    } finally {
      db.close();
    }
  });

  test("points a message read again from a file under another name at that file's line", () => {
    const lines = codexRolloutLines(THREAD, { withIds: true });
    const shifted = [lines[0], lines[1], ...lines.slice(1)];
    const writeShifted = (env: Env): void =>
      writePrefix(
        join(codexDir(env), "sessions", "2026", "09", "16", `rollout-2026-09-16T11-00-00-${THREAD}.jsonl`),
        shifted,
        fullBytes(shifted),
      );

    const freshRoot = newRoot();
    const freshEnv = scratchEnv(freshRoot);
    writeShifted(freshEnv);
    const freshDb = run(freshEnv);
    const expected = snapshot(freshDb, freshRoot).messages;
    freshDb.close();

    const root = newRoot();
    const env = scratchEnv(root);
    const from = writeCodexRollout(env, "sessions", THREAD);
    const db = run(env);
    try {
      rmSync(from);
      writeShifted(env);
      expect(sync(db, env).failures).toEqual([]);
      expect(snapshot(db, root).messages).toEqual(expected);
    } finally {
      db.close();
    }
  });

  test("titles a Codex session from the thread Codex keeps, while Codex is not running", () => {
    const root = newRoot();
    const env = scratchEnv(root);
    writeCodexRollout(env, "sessions", THREAD);
    const statePath = join(codexDir(env), "state_5.sqlite");
    const state = new Database(statePath);
    state.run("PRAGMA journal_mode = WAL");
    state.run("CREATE TABLE threads (id TEXT, title TEXT)");
    state.run("INSERT INTO threads VALUES (?, ?)", [THREAD, "Read the slice"]);
    state.close();
    rmSync(`${statePath}-wal`, { force: true });
    rmSync(`${statePath}-shm`, { force: true });

    const db = openDb(dbPath(env));
    try {
      expect(sync(db, env).failures).toEqual([]);
      expect(db.prepare("SELECT title FROM session WHERE id = ?").get(THREAD)).toEqual({
        title: "Read the slice",
      });
    } finally {
      db.close();
    }
  });

  test("names a Codex thread store it cannot read as a failure and still reads the rollouts", () => {
    const root = newRoot();
    const env = scratchEnv(root);
    writeCodexRollout(env, "sessions", THREAD);
    const livePath = join(codexDir(env), "state_5.sqlite");
    const statePath = archivedPath("codex", livePath, env);
    const state = new Database(livePath);
    state.run("CREATE TABLE threads (id TEXT, name TEXT)");
    state.close();

    const db = openDb(dbPath(env));
    try {
      expect(sync(db, env).failures).toEqual([
        {
          path: statePath,
          error: {
            kind: "refusal",
            code: "titles_unreadable",
            message: `cannot read Codex thread titles from ${statePath}: no such column: title; its sessions are recorded untitled`,
            meta: { path: statePath, detail: "no such column: title" },
            resolve: `if ${statePath} is unreadable, make it readable and run agent-record sync; if the detail names a missing table or column, Codex changed its thread store: hand this to the owner to update agent-record, and leave the file in place`,
          },
        },
      ]);
      expect(db.prepare("SELECT count(*) AS n FROM session WHERE id = ?").get(THREAD)).toEqual({ n: 1 });
    } finally {
      db.close();
    }
  });

  test("names a session file it cannot read as a refusal and still reads the others", () => {
    const root = newRoot();
    const env = scratchEnv(root);
    const locked = writeClaudeTranscript(env, "-Users-x-code-demo", SESSION);
    writeCodexRollout(env, "sessions", THREAD);
    chmodSync(locked, 0o000);

    const db = openDb(dbPath(env));
    try {
      expect(asUnprivileged(env, () => sync(db, env)).failures).toEqual([
        {
          path: locked,
          error: expect.objectContaining({
            kind: "refusal",
            code: "source_unreadable",
            meta: { path: locked, detail: expect.stringContaining("EACCES") },
          }),
        },
      ]);
      expect(db.prepare("SELECT count(*) AS n FROM session WHERE id = ?").get(SESSION)).toEqual({ n: 0 });
      expect(db.prepare("SELECT count(*) AS n FROM session WHERE id = ?").get(THREAD)).toEqual({ n: 1 });
    } finally {
      db.close();
    }
  });

  test("stops on a fault while recording a session rather than listing it as a failure", () => {
    const root = newRoot();
    const env = scratchEnv(root);
    writeClaudeTranscript(env, "-Users-x-code-demo", SESSION);

    const db = openDb(dbPath(env));
    try {
      db.run(
        "CREATE TEMP TRIGGER refuse_message BEFORE INSERT ON message BEGIN SELECT RAISE(ABORT, 'no'); END",
      );
      expect(() => sync(db, env)).toThrow("no");
    } finally {
      db.close();
    }
  });

  test("reads past a line that is not JSON and names it in the report", () => {
    const root = newRoot();
    const env = scratchEnv(root);
    const path = join(claudeProjectsDir(env), "-Users-x-code-demo", `${SESSION}.jsonl`);
    const good = claudeTranscriptLines(SESSION).map((l) => JSON.stringify(l));
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${[good[0], "{ truncated", ...good.slice(1)].join("\n")}\n`);

    const db = openDb(dbPath(env));
    try {
      const report = sync(db, env);
      expect(report.dropped).toEqual([{ path: archivedPath("claude", path, env), lines: [2] }]);
      expect(report.failures).toEqual([]);
      expect(db.prepare("SELECT count(*) AS n FROM message").get()).not.toEqual({ n: 0 });
      expect(sync(db, env).dropped).toEqual([]);
    } finally {
      db.close();
    }
  });

  test("refuses a transcript line with no timestamp, keeping the message's real time", () => {
    const root = newRoot();
    const env = scratchEnv(root);
    const path = join(claudeProjectsDir(env), "-Users-x-code-demo", `${SESSION}.jsonl`);
    const lines = claudeTranscriptLines(SESSION).map((line, index) => {
      if (index !== 3) return JSON.stringify(line);
      return withoutTimestamp(line);
    });
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${lines.join("\n")}\n`);

    const db = openDb(dbPath(env));
    try {
      const report = sync(db, env);
      expect(db.prepare("SELECT ts FROM message WHERE id = 'msg-1'").get()).toEqual({
        ts: "2026-09-16T10:02:00.000Z",
      });
      expect(report.dropped).toEqual([{ path: archivedPath("claude", path, env), lines: [4] }]);
      expect(db.prepare("SELECT count(*) AS n FROM message WHERE ts = ''").get()).toEqual({ n: 0 });
    } finally {
      db.close();
    }
  });

  test("addresses a pre-August Codex message by thread and line", () => {
    const root = newRoot();
    const env = scratchEnv(root);
    const legacy = codexRolloutLines(THREAD, { withIds: false });
    const path = join(codexDir(env), "sessions", `rollout-2026-02-05T19-43-37-${THREAD}.jsonl`);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${legacy.map((l) => JSON.stringify(l)).join("\n")}\n`);
    const db = run(env);
    try {
      expect(db.prepare("SELECT count(*) AS n FROM message").get()).toEqual({ n: 3 });
    } finally {
      db.close();
    }
  });

  test("links a subagent to the session that spawned it", () => {
    const root = newRoot();
    const env = scratchEnv(root);
    writeClaudeTranscript(env, "-Users-x-code-demo", SESSION);
    const agentDir = join(claudeProjectsDir(env), "-Users-x-code-demo", SESSION, "subagents");
    mkdirSync(agentDir, { recursive: true });
    const agentId = "a1111111111111111";
    writeFileSync(
      join(agentDir, `agent-${agentId}.jsonl`),
      `${claudeTranscriptLines(SESSION)
        .map((l) => JSON.stringify(l))
        .join("\n")}\n`,
    );
    writeFileSync(
      join(agentDir, `agent-${agentId}.meta.json`),
      JSON.stringify({ agentType: "Explore", toolUseId: "toolu-9", spawnDepth: 1 }),
    );
    const db = run(env);
    try {
      expect(
        db.prepare("SELECT parent_id, agent_type FROM session WHERE id = ?").get(`${agentId}@${SESSION}`),
      ).toEqual({ parent_id: SESSION, agent_type: "Explore" });
    } finally {
      db.close();
    }
  });

  test("names a subagent meta file whose agentType is not a string, and records the subagent untyped", () => {
    const root = newRoot();
    const env = scratchEnv(root);
    writeClaudeTranscript(env, "-Users-x-code-demo", SESSION);
    const agentDir = join(claudeProjectsDir(env), "-Users-x-code-demo", SESSION, "subagents");
    mkdirSync(agentDir, { recursive: true });
    const agentId = "a1111111111111111";
    writeFileSync(
      join(agentDir, `agent-${agentId}.jsonl`),
      `${claudeTranscriptLines(SESSION)
        .map((l) => JSON.stringify(l))
        .join("\n")}\n`,
    );
    const liveMeta = join(agentDir, `agent-${agentId}.meta.json`);
    writeFileSync(liveMeta, JSON.stringify({ agentType: 5 }));
    const meta = archivedPath("claude", liveMeta, env);
    const db = openDb(dbPath(env));
    try {
      expect(sync(db, env).failures).toEqual([
        {
          path: meta,
          error: {
            kind: "refusal",
            code: "sidecar_unreadable",
            message: `cannot read ${meta}: agentType: Invalid input: expected string, received number; its session is recorded without it`,
            meta: { path: meta, detail: "agentType: Invalid input: expected string, received number" },
            resolve: `if ${meta} is unreadable, make it readable and run agent-record sync; if the detail names a field or a JSON error, the tool changed its format: hand this to the owner to update agent-record, and leave the file in place`,
          },
        },
      ]);
      expect(
        db.prepare("SELECT parent_id, agent_type FROM session WHERE id = ?").get(`${agentId}@${SESSION}`),
      ).toEqual({ parent_id: SESSION, agent_type: null });
    } finally {
      db.close();
    }
  });

  test("re-reads a shrunk transcript whose session spawned a subagent, keeping the subagent's link", () => {
    const root = newRoot();
    const env = scratchEnv(root);
    const path = writeClaudeTranscript(env, "-Users-x-code-demo", SESSION);
    const agentDir = join(claudeProjectsDir(env), "-Users-x-code-demo", SESSION, "subagents");
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(
      join(agentDir, "agent-a1111111111111111.jsonl"),
      `${claudeTranscriptLines(SESSION)
        .map((l) => JSON.stringify(l).replace(/"(msg|toolu|u|a)-/g, '"agent-$1-'))
        .join("\n")}\n`,
    );
    run(env).close();
    const kept = claudeTranscriptLines(SESSION).slice(0, 2);
    writeFileSync(path, `${kept.map((l) => JSON.stringify(l)).join("\n")}\n`);

    const db = openDb(dbPath(env));
    try {
      expect(sync(db, env).failures).toEqual([]);
      expect(sync(db, env).failures).toEqual([]);
      const reread = db
        .prepare<{ n: number }, [string]>("SELECT count(*) AS n FROM message WHERE session_id = ?")
        .get(SESSION)?.n;
      const fresh = openDb(join(root, "fresh.db"));
      const expected = (() => {
        const other = scratchEnv(join(root, "fresh"));
        writeFileSync(
          writeClaudeTranscript(other, "-Users-x-code-demo", SESSION),
          `${kept.map((l) => JSON.stringify(l)).join("\n")}\n`,
        );
        sync(fresh, other);
        return fresh
          .prepare<{ n: number }, [string]>("SELECT count(*) AS n FROM message WHERE session_id = ?")
          .get(SESSION)?.n;
      })();
      fresh.close();
      expect(reread).toBe(expected);
      expect(
        db.prepare("SELECT parent_id FROM session WHERE id = ?").get(`a1111111111111111@${SESSION}`),
      ).toEqual({ parent_id: SESSION });
    } finally {
      db.close();
    }
  });

  test("keeps two subagents that share an agent id apart", () => {
    const root = newRoot();
    const env = scratchEnv(root);
    const other = "99999999-8888-7777-6666-555555555555";
    for (const parent of [SESSION, other]) {
      writeClaudeTranscript(env, "-Users-x-code-demo", parent);
      const dir = join(claudeProjectsDir(env), "-Users-x-code-demo", parent, "subagents");
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, "agent-shared.jsonl"),
        `${claudeTranscriptLines(parent)
          .map((l) => JSON.stringify(l))
          .join("\n")}\n`,
      );
    }
    const db = openDb(dbPath(env));
    try {
      expect(sync(db, env).dropped).toEqual([]);
      const rows = db
        .prepare<{ id: string; parent_id: string }, []>(
          "SELECT id, parent_id FROM session WHERE id LIKE 'shared@%' ORDER BY id",
        )
        .all();
      expect(rows).toEqual([
        { id: `shared@${SESSION}`, parent_id: SESSION },
        { id: `shared@${other}`, parent_id: other },
      ]);
      expect(db.prepare("SELECT count(*) AS n FROM source_file WHERE kind = 'subagent'").get()).toEqual({
        n: 2,
      });
    } finally {
      db.close();
    }
  });

  test("records a subagent whose parent transcript is gone, unlinked", () => {
    const root = newRoot();
    const env = scratchEnv(root);
    const agentDir = join(claudeProjectsDir(env), "-Users-x-code-demo", SESSION, "subagents");
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(
      join(agentDir, "agent-orphan1.jsonl"),
      `${claudeTranscriptLines(SESSION)
        .map((l) => JSON.stringify(l))
        .join("\n")}\n`,
    );
    const db = openDb(dbPath(env));
    try {
      const report = sync(db, env);
      const id = `orphan1@${SESSION}`;
      expect(report.orphanSubagents).toEqual<string[]>([id]);
      expect(report.failures).toEqual([]);
      expect(db.prepare("SELECT parent_id FROM session WHERE id = ?").get(id)).toEqual({
        parent_id: null,
      });
    } finally {
      db.close();
    }
  });
});

describe("the archive", () => {
  function claudeTranscriptPath(env: Env): string {
    return join(claudeProjectsDir(env), "-Users-x-code-demo", `${SESSION}.jsonl`);
  }

  function writeTranscript(env: Env, prompt: string): void {
    const lines = claudeTranscriptLines(SESSION).map((line) => JSON.stringify(line));
    const path = claudeTranscriptPath(env);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${lines.join("\n").replace("add the parser", prompt)}\n`);
  }

  function sourcePaths(db: Database): string[] {
    return db
      .prepare<{ path: string }, []>("SELECT path FROM source_file ORDER BY path")
      .all()
      .map((row) => row.path);
  }

  test("keeps a session whose transcript is gone, read from its archived copy", () => {
    const root = newRoot();
    const env = scratchEnv(root);
    writeTranscript(env, "add the parser");
    writeCodexRollout(env, "sessions", THREAD);
    const db = run(env);
    try {
      const before = snapshot(db, root);
      rmSync(claudeTranscriptPath(env));
      const report = sync(db, env);
      expect(report.failures).toEqual([]);
      expect(report.filesRead).toBe(0);
      expect(snapshot(db, root)).toEqual(before);
      expect(before.messages.some((m) => m.session_id === SESSION)).toBe(true);
      for (const path of sourcePaths(db)) expect(path.startsWith(`${archiveDir(env)}/`)).toBe(true);
    } finally {
      db.close();
    }
  });

  test("rebuilds every session from the archive after the original files are gone", () => {
    const root = newRoot();
    const env = scratchEnv(root);
    writeTranscript(env, "add the parser");
    writeCodexRollout(env, "sessions", THREAD);
    const db = run(env);
    try {
      const before = snapshot(db, root);
      rmSync(claudeProjectsDir(env), { recursive: true });
      rmSync(codexDir(env), { recursive: true });
      expect(rebuild(db, env).failures).toEqual([]);
      expect(snapshot(db, root)).toEqual(before);
      expect(before.sessions.map((s) => s.id)).toEqual([THREAD, SESSION].sort());
    } finally {
      db.close();
    }
  });

  test("forgets where it read every checkout on a rebuild, so the next sync reads each again", () => {
    const env = scratchEnv(newRoot());
    const db = run(env);
    try {
      db.run("INSERT INTO checkout (path, head, index_stat) VALUES ('/code/gone', 'abc', '1:1')");
      expect(rebuild(db, env).failures).toEqual([]);
      expect(db.query("SELECT path FROM checkout").all()).toEqual([]);
    } finally {
      db.close();
    }
  });

  test("reads a rewritten transcript as new even when the sync that replaced its copy stopped on a fault", () => {
    const freshRoot = newRoot();
    const freshEnv = scratchEnv(freshRoot);
    writeTranscript(freshEnv, "add the lexers");
    const freshDb = run(freshEnv);
    const expected = snapshot(freshDb, freshRoot);
    freshDb.close();

    const root = newRoot();
    const env = scratchEnv(root);
    writeTranscript(env, "add the parser");
    const db = run(env);
    try {
      const at = new Date(Date.now() - 60_000);
      utimesSync(claudeTranscriptPath(env), at, at);
      sync(db, env);
      writeTranscript(env, "add the lexers");
      db.run(
        "CREATE TEMP TRIGGER refuse_message BEFORE INSERT ON message BEGIN SELECT RAISE(ABORT, 'no'); END",
      );
      expect(() => sync(db, env)).toThrow("no");
      db.run("DROP TRIGGER refuse_message");
      expect(sync(db, env).failures).toEqual([]);
      expect(snapshot(db, root)).toEqual(expected);
    } finally {
      db.close();
    }
  });

  test("leaves the record unchanged when its write fails after archiving a file, and records the file once next time", () => {
    const freshRoot = newRoot();
    const freshEnv = scratchEnv(freshRoot);
    writeTranscript(freshEnv, "add the parser");
    const freshDb = run(freshEnv);
    const expected = snapshot(freshDb, freshRoot);
    freshDb.close();

    const root = newRoot();
    const env = scratchEnv(root);
    const lines = claudeTranscriptLines(SESSION);
    writePrefix(claudeTranscriptPath(env), lines, bytesThroughLine(lines, 2));
    const db = run(env);
    try {
      const before = snapshot(db, root);
      writePrefix(claudeTranscriptPath(env), lines, fullBytes(lines));
      db.run(
        "CREATE TEMP TRIGGER refuse_cursor BEFORE UPDATE ON source_file BEGIN SELECT RAISE(ABORT, 'interrupted'); END",
      );
      expect(() => sync(db, env)).toThrow("interrupted");
      expect(snapshot(db, root)).toEqual(before);

      db.run("DROP TRIGGER refuse_cursor");
      expect(sync(db, env).failures).toEqual([]);
      expect(snapshot(db, root)).toEqual(expected);
      expect(sync(db, env).filesRead).toBe(0);
    } finally {
      db.close();
    }
  });

  test("stops on a fault while resetting a session whose copy it would replace, keeping the old copy", () => {
    const root = newRoot();
    const env = scratchEnv(root);
    writeTranscript(env, "add the parser");
    const db = run(env);
    try {
      const at = new Date(Date.now() - 60_000);
      utimesSync(claudeTranscriptPath(env), at, at);
      sync(db, env);
      const copy = archivedPath("claude", claudeTranscriptPath(env), env);
      const before = readFileSync(copy, "utf8");
      writeTranscript(env, "add the lexers");
      db.run(
        "CREATE TEMP TRIGGER refuse_reset BEFORE DELETE ON message BEGIN SELECT RAISE(ABORT, 'no'); END",
      );
      expect(() => sync(db, env)).toThrow("no");
      expect(readFileSync(copy, "utf8")).toBe(before);
    } finally {
      db.close();
    }
  });

  const rewrites = [
    { name: "at the same size", prompt: "add the lexers" },
    { name: "longer, from a different start", prompt: "add the parser and the lexer" },
  ];
  for (const { name, prompt } of rewrites) {
    test(`reads a transcript rewritten ${name} as if it were new`, () => {
      const freshRoot = newRoot();
      const freshEnv = scratchEnv(freshRoot);
      writeTranscript(freshEnv, prompt);
      const freshDb = run(freshEnv);
      const expected = snapshot(freshDb, freshRoot);
      freshDb.close();

      const root = newRoot();
      const env = scratchEnv(root);
      writeTranscript(env, "add the parser");
      const db = run(env);
      try {
        const at = new Date(Date.now() - 60_000);
        utimesSync(claudeTranscriptPath(env), at, at);
        sync(db, env);
        writeTranscript(env, prompt);
        expect(sync(db, env).failures).toEqual([]);
        expect(snapshot(db, root)).toEqual(expected);
      } finally {
        db.close();
      }
    });
  }
});

describe("skill loads", () => {
  const COPY = "66666666-7777-8888-9999-000000000000";
  const at = (n: number) => `2026-09-20T10:0${n}:00.000Z`;
  const base = { sessionId: SESSION, cwd: "/Users/x/code/demo", isSidechain: false };
  const bodyText = (path: string) => `Base directory for this skill: ${path}\n\n# Body`;

  const skillCall = {
    ...base,
    type: "assistant",
    uuid: "a-skill",
    timestamp: at(1),
    message: {
      id: "msg-skill",
      role: "assistant",
      model: "claude-opus-5-5",
      content: [{ type: "tool_use", id: "toolu-skill", name: "Skill", input: { skill: "acme:plan" } }],
    },
  };
  const skillBody = {
    ...base,
    type: "user",
    uuid: "u-skill-body",
    parentUuid: "a-skill",
    timestamp: at(2),
    isMeta: true,
    sourceToolUseID: "toolu-skill",
    message: { role: "user", content: bodyText("/Users/x/code/acme/plugin/skills/plan") },
  };
  const typed = (uuid: string, command: string) => ({
    ...base,
    type: "user",
    uuid,
    timestamp: at(3),
    message: { role: "user", content: `<command-name>/${command}</command-name>` },
  });
  const typedBody = (uuid: string, parentUuid: string, path: string) => ({
    ...base,
    type: "user",
    uuid,
    parentUuid,
    timestamp: at(4),
    isMeta: true,
    message: { role: "user", content: bodyText(path) },
  });

  function writeTranscript(env: Env, sessionId: string, lines: unknown[]): string {
    const path = join(claudeProjectsDir(env), "-Users-x-code-demo", `${sessionId}.jsonl`);
    writePrefix(path, lines, fullBytes(lines));
    return path;
  }

  function skillLoads(db: Database) {
    return db
      .prepare(
        `SELECT session_id, message_id, tool_call_id, ts, model, skill_name, how, body_chars, skill_path
         FROM skill_load ORDER BY session_id, ts, tool_call_id`,
      )
      .all();
  }

  const calledLoad = {
    session_id: SESSION,
    message_id: null,
    tool_call_id: "toolu-skill",
    ts: at(1),
    model: "claude-opus-5-5",
    skill_name: "acme:plan",
    how: "model",
    body_chars: 6,
    skill_path: "/Users/x/code/acme/plugin/skills/plan",
  };

  test("stores a Skill call and the body it injected as one load", () => {
    const env = scratchEnv(newRoot());
    writeTranscript(env, SESSION, [skillCall, skillBody]);
    const db = run(env);
    try {
      expect(skillLoads(db)).toEqual([calledLoad]);
    } finally {
      db.close();
    }
  });

  test("stores each Skill call as its own load, even two of one skill in one message", () => {
    const env = scratchEnv(newRoot());
    const twice = {
      ...skillCall,
      message: {
        ...skillCall.message,
        content: [
          { type: "tool_use", id: "toolu-first", name: "Skill", input: { skill: "acme:plan" } },
          { type: "tool_use", id: "toolu-second", name: "Skill", input: { skill: "acme:plan" } },
        ],
      },
    };
    writeTranscript(env, SESSION, [twice]);
    const db = run(env);
    try {
      expect(skillLoads(db)).toMatchObject([
        { message_id: null, tool_call_id: "toolu-first", skill_name: "acme:plan", how: "model" },
        { message_id: null, tool_call_id: "toolu-second", skill_name: "acme:plan", how: "model" },
      ]);
    } finally {
      db.close();
    }
  });

  test("stores one load when the body arrives in a later sync than its call", () => {
    const env = scratchEnv(newRoot());
    const lines = [skillCall, skillBody];
    const path = writeTranscript(env, SESSION, lines);
    writePrefix(path, lines, bytesThroughLine(lines, 0));
    const db = run(env);
    try {
      expect(skillLoads(db)).toEqual([{ ...calledLoad, body_chars: null, skill_path: null }]);
      writePrefix(path, lines, fullBytes(lines));
      sync(db, env);
      expect(skillLoads(db)).toEqual([calledLoad]);
    } finally {
      db.close();
    }
  });

  test("stores a typed skill whose body arrives in a later sync than its command", () => {
    const env = scratchEnv(newRoot());
    const lines = [
      typed("u-plugin", "acme:plan"),
      typedBody("u-plugin-body", "u-plugin", "/Users/x/code/acme/plugin/skills/plan"),
    ];
    const path = writeTranscript(env, SESSION, lines);
    writePrefix(path, lines, bytesThroughLine(lines, 0));
    const db = run(env);
    try {
      expect(skillLoads(db)).toEqual([]);
      writePrefix(path, lines, fullBytes(lines));
      sync(db, env);
      expect(skillLoads(db)).toEqual([
        {
          session_id: SESSION,
          message_id: "u-plugin",
          tool_call_id: null,
          ts: at(3),
          model: null,
          skill_name: "acme:plan",
          how: "user",
          body_chars: 6,
          skill_path: "/Users/x/code/acme/plugin/skills/plan",
        },
      ]);
    } finally {
      db.close();
    }
  });

  test("stores a typed skill and its body as one load the user chose", () => {
    const env = scratchEnv(newRoot());
    writeTranscript(env, SESSION, [
      typed("u-typed", "review"),
      typedBody("u-typed-body", "u-typed", "/Users/x/.claude/skills/review"),
    ]);
    const db = run(env);
    try {
      expect(skillLoads(db)).toEqual([
        {
          session_id: SESSION,
          message_id: "u-typed",
          tool_call_id: null,
          ts: at(3),
          model: null,
          skill_name: "review",
          how: "user",
          body_chars: 6,
          skill_path: "/Users/x/.claude/skills/review",
        },
      ]);
    } finally {
      db.close();
    }
  });

  test("keeps the body's name when the typed command names a different skill", () => {
    const env = scratchEnv(newRoot());
    writeTranscript(env, SESSION, [
      typed("u-other", "acme:other"),
      typedBody("u-other-body", "u-other", "/Users/x/code/acme/plugin/skills/plan"),
    ]);
    const db = run(env);
    try {
      expect(skillLoads(db)).toEqual([
        expect.objectContaining({ message_id: "u-other", skill_name: "plan" }),
      ]);
    } finally {
      db.close();
    }
  });

  test("stores a typed plugin skill the command form misses as one load the user chose", () => {
    const env = scratchEnv(newRoot());
    writeTranscript(env, SESSION, [
      typed("u-plugin", "acme:plan"),
      typedBody("u-plugin-body", "u-plugin", "/Users/x/code/acme/plugin/skills/plan"),
    ]);
    const db = run(env);
    try {
      expect(skillLoads(db)).toEqual([
        {
          session_id: SESSION,
          message_id: "u-plugin",
          tool_call_id: null,
          ts: at(3),
          model: null,
          skill_name: "acme:plan",
          how: "user",
          body_chars: 6,
          skill_path: "/Users/x/code/acme/plugin/skills/plan",
        },
      ]);
    } finally {
      db.close();
    }
  });

  test("stores a Skill call copied into a second session file once in each session", () => {
    const env = scratchEnv(newRoot());
    writeTranscript(env, SESSION, [skillCall, skillBody]);
    writeTranscript(env, COPY, [skillCall, skillBody]);
    const db = run(env);
    try {
      expect(skillLoads(db)).toEqual([calledLoad, { ...calledLoad, session_id: COPY }]);
    } finally {
      db.close();
    }
  });

  test("stores nothing for a body whose Skill call is missing", () => {
    const env = scratchEnv(newRoot());
    writeClaudeTranscript(env, "-Users-x-code-demo", SESSION);
    const db = openDb(dbPath(env));
    try {
      expect(sync(db, env).failures).toEqual([]);
      expect(skillLoads(db)).toEqual([]);
    } finally {
      db.close();
    }
  });

  test("stores nothing for a typed body whose command line was dropped or that names no parent", () => {
    const env = scratchEnv(newRoot());
    const { timestamp: _, ...untimed } = typed("u-untimed", "acme:plan");
    const { parentUuid: __, ...parentless } = typedBody(
      "u-parentless-body",
      "",
      "/Users/x/.claude/skills/review",
    );
    writeTranscript(env, SESSION, [
      untimed,
      typedBody("u-untimed-body", "u-untimed", "/Users/x/code/acme/plugin/skills/plan"),
      parentless,
    ]);
    const db = openDb(dbPath(env));
    try {
      expect(sync(db, env).failures).toEqual([]);
      expect(skillLoads(db)).toEqual([]);
    } finally {
      db.close();
    }
  });

  test("stores nothing for a body pointing at a call that names no skill or is not a Skill call", () => {
    const env = scratchEnv(newRoot());
    const call = (id: string, name: string, input: unknown) => ({
      ...skillCall,
      uuid: `a-${id}`,
      message: { ...skillCall.message, id: `msg-${id}`, content: [{ type: "tool_use", id, name, input }] },
    });
    writeTranscript(env, SESSION, [
      call("toolu-unnamed", "Skill", {}),
      { ...skillBody, uuid: "u-unnamed-body", sourceToolUseID: "toolu-unnamed" },
      call("toolu-agent", "Agent", { skill: "acme:plan" }),
      { ...skillBody, uuid: "u-agent-body", sourceToolUseID: "toolu-agent" },
    ]);
    const db = openDb(dbPath(env));
    try {
      expect(sync(db, env).failures).toEqual([]);
      expect(skillLoads(db)).toEqual([]);
    } finally {
      db.close();
    }
  });

  test("stores nothing for a body whose Skill call row has no call time", () => {
    const env = scratchEnv(newRoot());
    const result = {
      ...base,
      type: "user",
      uuid: "u-skill-result",
      timestamp: at(1),
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "toolu-skill", content: "Launching" }],
      },
    };
    const lines = [result, skillBody];
    const path = writeTranscript(env, SESSION, lines);
    writePrefix(path, lines, bytesThroughLine(lines, 0));
    const db = run(env);
    try {
      db.run("UPDATE tool_call SET tool_name = 'Skill', skill_name = 'acme:plan' WHERE id = 'toolu-skill'");
      expect(db.prepare("SELECT ts_call FROM tool_call WHERE id = 'toolu-skill'").get()).toEqual({
        ts_call: null,
      });
      writePrefix(path, lines, fullBytes(lines));
      expect(sync(db, env).failures).toEqual([]);
      expect(skillLoads(db)).toEqual([]);
    } finally {
      db.close();
    }
  });
});
