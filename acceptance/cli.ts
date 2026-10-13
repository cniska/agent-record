import { Database } from "bun:sqlite";
import { expect } from "bun:test";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

const CLI = join(import.meta.dir, "..", "src", "cli.ts");
const FIXTURES = join(import.meta.dir, "fixtures");
const BUN_CACHE_OUTSIDE_HOMES = join(tmpdir(), "agent-record-acceptance-bun-cache");

export type Home = { readonly root: string; readonly record: string };

type Ran = { readonly exitCode: number; readonly stdout: string; readonly stderr: string };

const homes: string[] = [];

export function scratchHome(): Home {
  const root = mkdtempSync(join(tmpdir(), "agent-record-acceptance-"));
  homes.push(root);
  return { root, record: join(root, "data", "agent-record", "sessions.db") };
}

export function removeHomes(): void {
  for (const root of homes.splice(0)) rmSync(root, { recursive: true, force: true });
}

export function withClaudeFixtures(home: Home): Home {
  cpSync(join(FIXTURES, "claude"), join(home.root, ".claude", "projects"), { recursive: true });
  return home;
}

export function syncedHome(home: Home = scratchHome()): Home {
  succeeded(runCli(home, ["sync"]), "sync", z.unknown());
  return home;
}

export function runCli(home: Home, args: readonly string[]): Ran {
  const ran = Bun.spawnSync([process.execPath, CLI, ...args], {
    env: {
      PATH: process.env.PATH,
      BUN_RUNTIME_TRANSPILER_CACHE_PATH: BUN_CACHE_OUTSIDE_HOMES,
      HOME: home.root,
      XDG_DATA_HOME: join(home.root, "data"),
      XDG_STATE_HOME: join(home.root, "state"),
    },
  });
  return { exitCode: ran.exitCode, stdout: ran.stdout.toString(), stderr: ran.stderr.toString() };
}

const ERROR = z.strictObject({
  kind: z.enum(["refusal", "fault"]),
  code: z.string(),
  message: z.string(),
  meta: z.record(z.string(), z.unknown()),
  resolve: z.string(),
});

type CliError = z.infer<typeof ERROR>;

export const QUERY_RESULT = z.strictObject({
  denominator: z.string(),
  columns: z.array(z.string()),
  rows: z.array(z.array(z.union([z.string(), z.number(), z.null()]))),
  note: z.string().nullable(),
  more: z.string().nullable(),
});

export const DOCTOR_RESULT = z.strictObject({
  checks: z.array(
    z.strictObject({
      name: z.string(),
      state: z.enum(["ok", "warn", "fail"]),
      detail: z.string(),
      fix: z.string().nullable(),
    }),
  ),
  failing: z.number(),
});

export const USAGE_ENTRY = z.strictObject({ name: z.string(), usage: z.string(), summary: z.string() });

const ONE_LINE = /^[^\n]+\n$/;

export function succeeded<T extends z.ZodType>(ran: Ran, command: string, result: T): z.infer<T> {
  expect({ exitCode: ran.exitCode, stderr: ran.stderr }).toEqual({ exitCode: 0, stderr: "" });
  return okLine(ran, command, result);
}

export function okLine<T extends z.ZodType>(ran: Ran, command: string, result: T): z.infer<T> {
  expect(ran.stdout).toMatch(ONE_LINE);
  const line = z
    .strictObject({ command: z.literal(command), ok: z.literal(true), result: z.unknown() })
    .parse(JSON.parse(ran.stdout));
  return result.parse(line.result);
}

export function refused(ran: Ran, command: string): CliError {
  expect({ exitCode: ran.exitCode, stdout: ran.stdout }).toEqual({ exitCode: 1, stdout: "" });
  expect(ran.stderr).toMatch(ONE_LINE);
  return z
    .strictObject({ command: z.literal(command), ok: z.literal(false), error: ERROR })
    .parse(JSON.parse(ran.stderr)).error;
}

export function schemaVersion(home: Home): number {
  using db = new Database(home.record, { readonly: true });
  return z.strictObject({ user_version: z.number() }).parse(db.query("PRAGMA user_version").get())
    .user_version;
}

export function setSchemaVersion(home: Home, version: number): void {
  using db = new Database(home.record);
  db.run(`PRAGMA user_version = ${version}`);
}
