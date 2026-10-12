import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { openDb } from "./db";
import { recordDoctor } from "./doctor";
import { scratchEnv } from "./fixtures.test-support";
import { agentPlistPath, installAgent } from "./ingest-launchd";
import { dbPath, type Env } from "./paths";
import { writeSyncStamp } from "./sync-stamp";

const NOW = Date.parse("2026-10-11T12:00:00Z");
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function newEnv(): Env {
  const root = mkdtempSync(join(tmpdir(), "agent-record-doctor-"));
  roots.push(root);
  return scratchEnv(root);
}

function home(env: Env): string {
  const dir = env.HOME;
  if (dir === undefined) throw new Error("scratchEnv sets HOME");
  return dir;
}

function writeRecord(env: Env): void {
  openDb(dbPath(env)).close();
}

function stampPath(env: Env): string {
  return join(home(env), "state", "agent-record", "last-sync");
}

function check(env: Env, name: string, loaded = false) {
  return recordDoctor(env, { agentLoaded: () => loaded, now: NOW }).checks.find((c) => c.name === name);
}

describe("agent-record doctor", () => {
  test("fails on a missing record, and creates none", () => {
    const env = newEnv();
    expect(check(env, "record")).toEqual({
      name: "record",
      state: "fail",
      detail: `no database at ${dbPath(env)}; run \`agent-record sync\` first`,
      fix: "agent-record sync",
    });
    expect(existsSync(dbPath(env))).toBe(false);
  });

  test("fails on a record of a schema version this build cannot read, naming rebuild", () => {
    const env = newEnv();
    mkdirSync(dirname(dbPath(env)), { recursive: true });
    const db = new Database(dbPath(env), { create: true });
    db.run("CREATE TABLE old (x TEXT)");
    db.close();
    expect(check(env, "record")).toMatchObject({ state: "fail", fix: "agent-record rebuild" });
  });

  test("passes a readable record", () => {
    const env = newEnv();
    writeRecord(env);
    expect(check(env, "record")).toEqual({
      name: "record",
      state: "ok",
      detail: "schema version 3",
      fix: null,
    });
  });

  test("fails when no sync has ever finished, or the stamp holds no time", () => {
    const env = newEnv();
    expect(check(env, "sync")).toEqual({
      name: "sync",
      state: "fail",
      detail: "no sync has ever finished",
      fix: "agent-record sync",
    });
    mkdirSync(dirname(stampPath(env)), { recursive: true });
    writeFileSync(stampPath(env), "yesterday\n");
    expect(check(env, "sync")).toEqual({
      name: "sync",
      state: "fail",
      detail: `${stampPath(env)} holds no sync time`,
      fix: "agent-record sync",
    });
  });

  test("warns once the last finished sync is over a day old, and passes inside a day", () => {
    const env = newEnv();
    writeSyncStamp(new Date("2026-10-10T11:00:00Z"), env);
    expect(check(env, "sync")).toEqual({
      name: "sync",
      state: "warn",
      detail: "last sync finished 25 hours ago",
      fix: "agent-record sync, and fix any error it reports",
    });
    writeSyncStamp(new Date("2026-10-10T13:00:00Z"), env);
    expect(check(env, "sync")).toEqual({
      name: "sync",
      state: "ok",
      detail: "last sync finished 23 hours ago",
      fix: null,
    });
  });

  test("warns on a launchd agent that is missing, stale or not loaded, and passes a loaded one", () => {
    const env = newEnv();
    const plist = agentPlistPath(env);
    expect(check(env, "agent")).toMatchObject({
      state: "warn",
      fix: "claude plugin install cniska-record@cniska, or agent-record agent install to sync while Claude Code is not running",
    });
    mkdirSync(dirname(plist), { recursive: true });
    writeFileSync(plist, "<plist>other checkout</plist>");
    expect(check(env, "agent", true)).toEqual({
      name: "agent",
      state: "warn",
      detail: "the launchd agent runs a different checkout or Bun than this agent-record",
      fix: `agent-record agent install, then launchctl bootout gui/$(id -u)/dev.agentrecord.sync and launchctl bootstrap gui/$(id -u) ${plist}`,
    });
    installAgent(env);
    expect(check(env, "agent")).toEqual({
      name: "agent",
      state: "warn",
      detail: "the launchd agent is written but not loaded",
      fix: `launchctl bootstrap gui/$(id -u) ${plist}`,
    });
    expect(check(env, "agent", true)).toEqual({
      name: "agent",
      state: "ok",
      detail: "the launchd agent is loaded",
      fix: null,
    });
  });

  test("counts the failing checks", () => {
    const env = newEnv();
    expect(recordDoctor(env, { agentLoaded: () => true, now: NOW }).failing).toBe(2);
    writeRecord(env);
    writeSyncStamp(new Date(NOW), env);
    expect(recordDoctor(env, { agentLoaded: () => true, now: NOW }).failing).toBe(0);
  });
});

describe("the commands", () => {
  function run(env: Env, command: string) {
    const ran = Bun.spawnSync([process.execPath, join(import.meta.dir, "cli.ts"), command], {
      env: { ...process.env, ...env },
    });
    return { exitCode: ran.exitCode, stdout: ran.stdout.toString(), stderr: ran.stderr.toString() };
  }

  test("doctor exits 1 when a check fails, still printing the report on stdout", () => {
    const ran = run(newEnv(), "doctor");
    expect(ran.exitCode).toBe(1);
    expect(ran.stderr).toBe("");
    expect(JSON.parse(ran.stdout)).toMatchObject({ command: "doctor", ok: true, result: { failing: 2 } });
  });

  test("a finished sync stamps its time, which lets the doctor pass", () => {
    const env = newEnv();
    const before = Date.now();
    expect(run(env, "sync").exitCode).toBe(0);
    expect(Date.parse(readFileSync(stampPath(env), "utf8").trim())).toBeGreaterThanOrEqual(before - 1000);
    const ran = run(env, "doctor");
    expect(JSON.parse(ran.stdout)).toMatchObject({ command: "doctor", ok: true, result: { failing: 0 } });
    expect(ran.exitCode).toBe(0);
  });

  test("a finished rebuild stamps its time too", () => {
    const env = newEnv();
    expect(run(env, "rebuild").exitCode).toBe(0);
    expect(existsSync(stampPath(env))).toBe(true);
  });
});
