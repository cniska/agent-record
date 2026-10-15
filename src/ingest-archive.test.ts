import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Env } from "./env";
import { errorCode } from "./error-read";
import { archivedPath as archived, asUnprivileged, scratchEnv } from "./fixtures.test-support";
import { archiveSources } from "./ingest-archive";
import { readCodexTitles } from "./ingest-codex-source";
import { SessionId } from "./ingest-ids";
import { archiveDir, claudeProjectsDir, codexDir, grokSessionsDir, pluginDataDir } from "./paths";

const SESSION = "0b8f2c1e-7d4a-4e2b-9c3f-5a6d7e8f9a0b";
const THREAD = "01a0a651-086e-7150-8650-cef0f4025a58";
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function newEnv(): Env {
  const root = mkdtempSync(join(tmpdir(), "agent-record-archive-"));
  roots.push(root);
  return scratchEnv(root);
}

function write(path: string, body: string): string {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
  return path;
}

function age(path: string, seconds: number): void {
  const at = new Date(Date.now() - seconds * 1000);
  utimesSync(path, at, at);
}

function claudeTranscript(env: Env, slug = "-Users-x-code-demo"): string {
  return join(claudeProjectsDir(env), slug, `${SESSION}.jsonl`);
}

function rollout(env: Env, dir: "sessions" | "archived_sessions", stamp = "2026-09-16T10-00-00"): string {
  return join(codexDir(env), dir, "2026", "09", "16", `rollout-${stamp}-${THREAD}.jsonl`);
}

function archive(env: Env) {
  const failures: { path: string; code: unknown }[] = [];
  const replaced: string[] = [];
  const logsReset: (readonly [string, string])[] = [];
  const report = archiveSources(env, (path, error) => failures.push({ path, code: errorCode(error) }), {
    resetSession: (copy) => replaced.push(copy),
    resetLog: (copy) => logsReset.push([copy, readFileSync(copy, "utf8")]),
  });
  return { report, replaced, logsReset, failures };
}

describe("archiving hook event logs", () => {
  const log = (env: Env, install: string) => join(pluginDataDir(env), install, "events.jsonl");
  const copyOf = (env: Env, install: string) => join(archiveDir(env), "plugin-data", install, "events.jsonl");

  test("copies the log of every plugin install, and no other file in its data folder", () => {
    const env = newEnv();
    write(log(env, "acme-kit"), '{"v":1}\n');
    write(log(env, "other-plugin-market"), '{"v":1}\n{"v":1}\n');
    write(join(pluginDataDir(env), "other-plugin-market", "state.jsonl"), '{"v":1}\n');
    expect(archive(env).report).toEqual({ files: 2, bytes: 24 });
    expect(readFileSync(copyOf(env, "other-plugin-market"), "utf8")).toBe('{"v":1}\n{"v":1}\n');
    expect(existsSync(join(archiveDir(env), "plugin-data", "other-plugin-market", "state.jsonl"))).toBe(
      false,
    );
  });

  test("appends what a log gained, and keeps the copy of one rewritten shorter beside the new copy", () => {
    const env = newEnv();
    const live = write(log(env, "acme-kit"), '{"a":1}\n');
    age(live, 60);
    archive(env);
    appendFileSync(live, '{"b":2}\n');
    expect(archive(env).report).toEqual({ files: 1, bytes: 8 });
    age(live, 30);
    write(live, '{"c":3}\n');
    const result = archive(env);
    expect(readFileSync(copyOf(env, "acme-kit"), "utf8")).toBe('{"c":3}\n');
    const segment = join(archiveDir(env), "plugin-data", "acme-kit", "events-1.jsonl");
    expect(readFileSync(segment, "utf8")).toBe('{"a":1}\n{"b":2}\n');
    expect(result.replaced).toEqual([]);
    expect(result.logsReset).toEqual([[copyOf(env, "acme-kit"), '{"a":1}\n{"b":2}\n']]);

    write(live, '{"d":4}\n');
    age(live, 10);
    archive(env);
    expect(readFileSync(join(dirname(segment), "events-2.jsonl"), "utf8")).toBe('{"c":3}\n');
  });
});

describe("archiving session files", () => {
  test("copies a new file byte for byte, a partial last line included", () => {
    const env = newEnv();
    const live = write(claudeTranscript(env), '{"a":1}\n{"b":');
    const result = archive(env);
    expect(result.failures).toEqual([]);
    expect(readFileSync(archived("claude", live, env), "utf8")).toBe('{"a":1}\n{"b":');
    expect(result.report).toEqual({ files: 1, bytes: 13 });
    expect(result.replaced).toEqual([]);
  });

  test("writes nothing when nothing changed since the last pass", () => {
    const env = newEnv();
    write(claudeTranscript(env), '{"a":1}\n');
    write(rollout(env, "sessions"), '{"b":2}\n');
    archive(env);
    expect(archive(env).report).toEqual({ files: 0, bytes: 0 });
  });

  test("writes nothing for a file rewritten with the same bytes, and leaves it unreplaced", () => {
    const env = newEnv();
    const live = write(claudeTranscript(env), '{"a":1}\n');
    age(live, 60);
    archive(env);
    write(live, '{"a":1}\n');
    const result = archive(env);
    expect(result.report).toEqual({ files: 0, bytes: 0 });
    expect(result.replaced).toEqual([]);
    expect(archive(env).report).toEqual({ files: 0, bytes: 0 });
  });

  test("appends only the bytes a growing file gained", () => {
    const env = newEnv();
    const live = write(claudeTranscript(env), '{"a":1}\n{"b":');
    age(live, 60);
    archive(env);
    appendFileSync(live, '2}\n{"c":3}\n');
    const result = archive(env);
    expect(readFileSync(archived("claude", live, env), "utf8")).toBe('{"a":1}\n{"b":2}\n{"c":3}\n');
    expect(result.report).toEqual({ files: 1, bytes: 11 });
    expect(result.replaced).toEqual([]);
  });

  const rewrites: { name: string; before: string; after: string }[] = [
    { name: "shrank", before: '{"a":1}\n{"b":2}\n', after: '{"a":1}\n' },
    { name: "grew from a different start", before: '{"a":1}\n', after: '{"z":9}\n{"y":8}\n' },
    { name: "was rewritten at the same size", before: '{"a":1}\n', after: '{"a":2}\n' },
  ];
  for (const { name, before, after } of rewrites) {
    test(`replaces the copy of a file that ${name}, and names it replaced`, () => {
      const env = newEnv();
      const live = write(claudeTranscript(env), before);
      age(live, 60);
      archive(env);
      write(live, after);
      const result = archive(env);
      const copy = archived("claude", live, env);
      expect(readFileSync(copy, "utf8")).toBe(after);
      expect(result.replaced).toEqual([copy]);
      expect(existsSync(`${copy}.part`)).toBe(false);
    });
  }

  test("keeps the copy of a file whose original is gone", () => {
    const env = newEnv();
    const live = write(claudeTranscript(env), '{"a":1}\n');
    archive(env);
    rmSync(live);
    expect(archive(env).report).toEqual({ files: 0, bytes: 0 });
    expect(readFileSync(archived("claude", live, env), "utf8")).toBe('{"a":1}\n');
  });

  test("keeps two coexisting files of one session apart", () => {
    const env = newEnv();
    const big = write(claudeTranscript(env), '{"a":1}\n{"b":2}\n');
    const small = write(claudeTranscript(env, "-Users-x-code-demo--claude-worktrees-w"), '{"c":3}\n');
    archive(env);
    expect(readFileSync(archived("claude", big, env), "utf8")).toBe('{"a":1}\n{"b":2}\n');
    expect(readFileSync(archived("claude", small, env), "utf8")).toBe('{"c":3}\n');
  });

  test("names an archive it cannot write by the copy's path and leaves the original alone", () => {
    const env = newEnv();
    const live = write(claudeTranscript(env), '{"a":1}\n');
    const copyRoot = join(archiveDir(env), "claude");
    mkdirSync(copyRoot, { recursive: true });
    chmodSync(copyRoot, 0o555);
    const result = asUnprivileged(env, () => archive(env));
    chmodSync(copyRoot, 0o755);
    expect(result.failures).toEqual([{ path: archived("claude", live, env), code: "archive_unwritable" }]);
    expect(readFileSync(live, "utf8")).toBe('{"a":1}\n');
    expect(existsSync(archived("claude", live, env))).toBe(false);
  });

  test("names a file it cannot read and still archives the others", () => {
    const env = newEnv();
    const locked = write(claudeTranscript(env), '{"a":1}\n');
    const open = write(rollout(env, "sessions"), '{"b":2}\n');
    chmodSync(locked, 0o000);
    const result = asUnprivileged(env, () => archive(env));
    chmodSync(locked, 0o644);
    expect(result.failures).toEqual([{ path: locked, code: "source_unreadable" }]);
    expect(existsSync(archived("claude", locked, env))).toBe(false);
    expect(readFileSync(archived("codex", open, env), "utf8")).toBe('{"b":2}\n');
  });
});

describe("a rollout Codex moves", () => {
  test("moves its copy along and leaves one copy", () => {
    const env = newEnv();
    const from = write(rollout(env, "sessions"), '{"a":1}\n');
    archive(env);
    const to = rollout(env, "archived_sessions");
    mkdirSync(dirname(to), { recursive: true });
    renameSync(from, to);
    appendFileSync(to, '{"b":2}\n');
    const result = archive(env);
    expect(existsSync(archived("codex", from, env))).toBe(false);
    expect(readFileSync(archived("codex", to, env), "utf8")).toBe('{"a":1}\n{"b":2}\n');
    expect(result.report).toEqual({ files: 1, bytes: 8 });
    expect(result.replaced).toEqual([]);
  });

  test("does not take over a copy whose bytes the new file does not start with", () => {
    const env = newEnv();
    const from = write(rollout(env, "sessions"), '{"a":1}\n');
    archive(env);
    rmSync(from);
    const other = write(rollout(env, "archived_sessions"), '{"z":9}\n{"y":8}\n');
    archive(env);
    expect(readFileSync(archived("codex", from, env), "utf8")).toBe('{"a":1}\n');
    expect(readFileSync(archived("codex", other, env), "utf8")).toBe('{"z":9}\n{"y":8}\n');
  });

  test("does not move a copy whose original still exists", () => {
    const env = newEnv();
    const first = write(rollout(env, "sessions"), '{"a":1}\n');
    archive(env);
    const second = write(rollout(env, "archived_sessions"), '{"a":1}\n{"b":2}\n');
    archive(env);
    expect(readFileSync(archived("codex", first, env), "utf8")).toBe('{"a":1}\n');
    expect(readFileSync(archived("codex", second, env), "utf8")).toBe('{"a":1}\n{"b":2}\n');
  });
});

describe("archiving sidecars and the titles store", () => {
  test("copies a subagent's meta file and a Grok summary beside their sessions", () => {
    const env = newEnv();
    const agentDir = join(claudeProjectsDir(env), "-Users-x-code-demo", SESSION, "subagents");
    write(join(agentDir, "agent-a1.jsonl"), '{"a":1}\n');
    const meta = write(join(agentDir, "agent-a1.meta.json"), '{"agentType":"Explore"}');
    const grokDir = join(grokSessionsDir(env), "group", SESSION);
    write(join(grokDir, "updates.jsonl"), '{"b":2}\n');
    const summary = write(join(grokDir, "summary.json"), '{"generated_title":"t"}');
    archive(env);
    expect(readFileSync(archived("claude", meta, env), "utf8")).toBe('{"agentType":"Explore"}');
    expect(readFileSync(archived("grok", summary, env), "utf8")).toBe('{"generated_title":"t"}');
  });

  test("replaces a rewritten sidecar whole, without naming its session replaced", () => {
    const env = newEnv();
    const grokDir = join(grokSessionsDir(env), "group", SESSION);
    write(join(grokDir, "updates.jsonl"), '{"b":2}\n');
    const summary = write(join(grokDir, "summary.json"), `{"generated_title":"${"a".repeat(5000)}"}`);
    age(summary, 60);
    archive(env);
    write(summary, `{"generated_title":"${"b".repeat(5000)}","head_branch":"main"}`);
    const result = archive(env);
    expect(readFileSync(archived("grok", summary, env), "utf8")).toBe(
      `{"generated_title":"${"b".repeat(5000)}","head_branch":"main"}`,
    );
    expect(result.replaced).toEqual([]);
  });

  test("keeps a readable copy of a titles store that grew while its first page changed", () => {
    const env = newEnv();
    const live = join(codexDir(env), "state_5.sqlite");
    mkdirSync(dirname(live), { recursive: true });
    const db = new Database(live);
    db.run("CREATE TABLE threads (id TEXT PRIMARY KEY, title TEXT)");
    db.run("INSERT INTO threads VALUES ('t1', 'first')");
    age(live, 60);
    archive(env);
    for (let n = 2; n < 400; n += 1) db.run("INSERT INTO threads VALUES (?, ?)", [`t${n}`, "x".repeat(200)]);
    db.run("UPDATE threads SET title = 'renamed' WHERE id = 't1'");
    db.close();
    archive(env);
    const titles = readCodexTitles(archived("codex", live, env));
    expect(titles.get(SessionId.parse("t1"))).toBe("renamed");
    expect(titles.size).toBe(399);
  });
});
