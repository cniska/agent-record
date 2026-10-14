import type { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, recordVersion } from "./db";
import { NO_WAIT_MS } from "./db-read.test-support";
import { SCHEMA_VERSION } from "./db-schema";
import type { Env } from "./env";
import { scratchEnv, writeClaudeTranscript } from "./fixtures.test-support";
import { rebuild, sync } from "./ingest-sync";
import { TOOLS } from "./ingest-tools";
import { archiveDir, dbPath, pluginDataDir } from "./paths";

type Scratch = { db: Database; env: Env };

function scratch(): Scratch {
  const home = mkdtempSync(join(tmpdir(), "agent-record-rebuild-"));
  const env = scratchEnv(home);
  return { db: openDb(dbPath(env), { heldRecordWaitMs: NO_WAIT_MS }), env };
}

function fill(db: Database): void {
  db.run("INSERT INTO session (id, tool) VALUES ('parent', 'claude')");
  db.run("INSERT INTO session (id, tool, parent_id) VALUES ('s1', 'claude', 'parent')");
  db.run(
    "INSERT INTO source_file (path, tool, kind, session_id) VALUES ('/f.jsonl', 'claude', 'transcript', 's1')",
  );
  db.run(
    "INSERT INTO message (id, session_id, ts, role, src_file, src_line) VALUES ('m1', 's1', '2026-01-01T00:00:00Z', 'user', '/f.jsonl', 1)",
  );
  db.run(
    "INSERT INTO usage (response_id, session_id, message_id, ts, input_tokens, output_tokens) VALUES ('r1', 's1', 'm1', '2026-01-01T00:00:00Z', 1, 1)",
  );
  db.run("INSERT INTO turn (session_id, turn_id, ts_end) VALUES ('s1', 't1', '2026-01-01T00:00:00Z')");
  db.run(
    "INSERT INTO tool_call (id, session_id, message_id, tool_name, src_file) VALUES ('tc1', 's1', 'm1', 'Bash', '/f.jsonl')",
  );
  db.run("INSERT INTO git_command (tool_call_id, position, subcommand) VALUES ('tc1', 0, 'commit')");
  db.run(
    "INSERT INTO skill_load (session_id, message_id, ts, skill_name, how) VALUES ('s1', 'm1', '2026-01-01T00:00:00Z', 'line-fix', 'model')",
  );
  db.run(
    "INSERT INTO repo_commit (sha, repo, ts, subject) VALUES ('abc', '/r', '2026-01-01T00:00:00Z', 'fix: x')",
  );
  db.run("INSERT INTO commit_file (sha, path) VALUES ('abc', '/r/a.ts')");
}

function tablesOf(db: Database): string[] {
  return db
    .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all()
    .map((row) => row.name);
}

function columnsOf(db: Database, table: string): string[] {
  return db
    .query<{ name: string }, []>(`PRAGMA table_info(${table})`)
    .all()
    .map((row) => row.name);
}

describe("absorbing a schema change", () => {
  test("a column missing from a table rebuild re-reads is back afterwards", () => {
    const { db, env } = scratch();
    fill(db);
    db.run("ALTER TABLE tool_call DROP COLUMN duration_ms");
    expect(columnsOf(db, "tool_call")).not.toContain("duration_ms");

    rebuild(db, env);

    expect(columnsOf(db, "tool_call")).toContain("duration_ms");
    db.close();
  });

  test("a database opened for rebuild takes a new indexed column and a new table", () => {
    const { db, env } = scratch();
    fill(db);
    db.run("DROP INDEX tool_call_file");
    db.run("ALTER TABLE tool_call DROP COLUMN file_path");
    db.run("DROP TABLE repo_file");
    db.run(`PRAGMA user_version = ${SCHEMA_VERSION - 1}`);
    db.close();

    const reopened = openDb(dbPath(env), { forRebuild: true, heldRecordWaitMs: NO_WAIT_MS });
    rebuild(reopened, env);

    expect(columnsOf(reopened, "tool_call")).toContain("file_path");
    expect(tablesOf(reopened)).toContain("repo_file");
    expect(recordVersion(reopened)).toBe(SCHEMA_VERSION);
    reopened.close();
  });

  test("a row in every table that references another does not stop the drops", () => {
    const { db, env } = scratch();
    fill(db);

    rebuild(db, env);

    expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
    db.close();
  });

  test("drops a large table that another references through an unindexed column without checking each row", () => {
    const { db, env } = scratch();
    const rows = 50_000;
    db.run("CREATE TABLE old_parent (id INTEGER PRIMARY KEY)");
    db.run("CREATE TABLE old_child (id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES old_parent(id))");
    db.transaction(() => {
      for (let id = 1; id <= rows; id++) {
        db.run("INSERT INTO old_parent (id) VALUES (?)", [id]);
        db.run("INSERT INTO old_child (id, parent_id) VALUES (?, ?)", [id, id]);
      }
    })();

    const started = performance.now();
    rebuild(db, env);

    expect(performance.now() - started).toBeLessThan(3000);
    expect(tablesOf(db)).not.toContain("old_parent");
    db.close();
  }, 120_000);

  test("a rebuild that throws leaves the old version stamped", () => {
    const { db, env } = scratch();
    db.run(`PRAGMA user_version = ${SCHEMA_VERSION - 1}`);
    const broken = { ...env, dataHome: join(env.home, "broken-data") };
    mkdirSync(archiveDir(broken), { recursive: true });
    writeFileSync(join(archiveDir(broken), "claude"), "");

    expect(() => rebuild(db, broken)).toThrow(expect.objectContaining({ code: "ENOTDIR" }));
    expect(recordVersion(db)).toBe(SCHEMA_VERSION - 1);

    rebuild(db, env);
    expect(recordVersion(db)).toBe(SCHEMA_VERSION);
    db.close();
  });
});

describe("rebuilding a database an older schema wrote", () => {
  test("a table the schema no longer defines is dropped", () => {
    const { db, env } = scratch();
    db.run("CREATE TABLE retired (id INTEGER PRIMARY KEY)");

    rebuild(db, env);

    expect(tablesOf(db)).not.toContain("retired");
    expect(tablesOf(db)).toContain("message_fts");
    db.close();
  });
});

describe("a sync", () => {
  test("reads every source in the tool vocabulary's order", () => {
    const root = mkdtempSync(join(tmpdir(), "agent-record-tools-"));
    const env = scratchEnv(root);
    const db = openDb(dbPath(env), { heldRecordWaitMs: NO_WAIT_MS });
    try {
      expect(sync(db, env).sources).toEqual(TOOLS.map((tool) => ({ tool, files: 0 })));
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("reads every archived hook event log, reports its dropped lines, and keeps its events through a rebuild", () => {
    const root = mkdtempSync(join(tmpdir(), "agent-record-events-"));
    const env = scratchEnv(root);
    const live = join(pluginDataDir(env), "cniska-skills-cniska", "events.jsonl");
    mkdirSync(join(live, ".."), { recursive: true });
    const prompt = {
      v: 1,
      ts: "2026-10-14T08:00:00Z",
      event: "permission_prompt",
      session: "s1",
      agent: null,
    };
    writeFileSync(live, `${JSON.stringify({ ...prompt, cwd: "/w", tool: "Bash" })}\n{broken\n`);
    const db = openDb(dbPath(env), { heldRecordWaitMs: NO_WAIT_MS });
    const events = () => db.query("SELECT src_file, src_line, event, tool FROM hook_event").all();
    const copy = join(archiveDir(env), "plugin-data", "cniska-skills-cniska", "events.jsonl");
    try {
      const report = sync(db, env);
      expect({ eventLogs: report.eventLogs, filesRead: report.filesRead, dropped: report.dropped }).toEqual({
        eventLogs: 1,
        filesRead: 1,
        dropped: [{ path: copy, lines: [2] }],
      });
      const synced = events();
      expect(synced).toEqual([{ src_file: copy, src_line: 1, event: "permission_prompt", tool: "Bash" }]);
      rmSync(live);
      rebuild(db, env);
      expect(events()).toEqual(synced);
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a rebuild with HOME at an empty directory keeps the skill loads a sync wrote", () => {
    const root = mkdtempSync(join(tmpdir(), "agent-record-archive-only-"));
    const env = scratchEnv(root);
    const typed = {
      sessionId: "11111111-2222-3333-4444-555555555555",
      cwd: "/Users/x/code/demo",
      type: "user",
      uuid: "u-typed",
      timestamp: "2026-09-20T10:03:00.000Z",
      message: { role: "user", content: "<command-name>/review</command-name>" },
    };
    writeClaudeTranscript(env, "-Users-x-code-demo", typed.sessionId, [typed]);
    mkdirSync(join(root, ".claude", "skills", "review"), { recursive: true });
    writeFileSync(join(root, ".claude", "skills", "review", "SKILL.md"), "# Review");
    const empty = join(root, "empty-home");
    mkdirSync(empty);
    const db = openDb(dbPath(env), { heldRecordWaitMs: NO_WAIT_MS });
    const loads = () => db.query("SELECT session_id, message_id, skill_name, how FROM skill_load").all();
    try {
      sync(db, env);
      const synced = loads();
      rebuild(db, { ...env, home: empty });
      expect(loads()).toEqual(synced);
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
