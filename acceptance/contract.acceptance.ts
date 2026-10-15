import { afterEach, expect, test } from "bun:test";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import {
  DOCTOR_RESULT,
  doctor,
  type Home,
  holdingRecord,
  okLine,
  rebuild,
  refused,
  removeScratch,
  rowsOf,
  runCli,
  schemaVersion,
  scratchHome,
  setSchemaVersion,
  succeeded,
  sync,
  syncedHome,
  USAGE_ENTRY,
  withFixtures,
} from "./cli";
import { CLAUDE } from "./fixture-names";

afterEach(removeScratch);

const USAGE = {
  sync: "agent-record sync",
  rebuild: "agent-record rebuild",
  query: "agent-record query <name> <arg> [--rows <n>] | agent-record query list",
  search: 'agent-record query search "<words>" [--rows <n>]',
  sql: 'agent-record sql "<select>" [--rows <n>]',
  agent: "agent-record agent install",
  doctor: "agent-record doctor",
} as const;

const READERS = [
  { command: "query", args: ["query", "search", "parser"] },
  { command: "sql", args: ["sql", "select 1 as one"] },
] as const;

const READERS_AND_WRITER = [{ command: "sync", args: ["sync"] }, ...READERS] as const;

function expectVersionRefused(
  home: Home,
  commands: readonly { readonly command: string; readonly args: readonly string[] }[],
  resolve: string,
): void {
  for (const { command, args } of commands) {
    const error = refused(runCli(home, args), command);
    expect({ command, code: error.code, resolve: error.resolve }).toEqual({
      command,
      code: "record_version",
      resolve,
    });
  }
}

test("AC-10 a record of an older schema version is refused by query and sql naming the next sync or rebuild, and sync and rebuild each rebuild it", () => {
  const home = syncedHome();
  const current = schemaVersion(home);
  setSchemaVersion(home, current - 1);

  expectVersionRefused(home, READERS, "the next agent-record sync rebuilds it, or run agent-record rebuild");
  withFixtures(home, [CLAUDE]);
  expect(sync(home).rebuilt).toEqual({
    from: current - 1,
    to: current,
    backup: `${home.record}.agent-record-backup`,
    unreadCheckouts: [],
  });
  expect(schemaVersion(home)).toBe(current);
  expect(rowsOf(home, "select id from session")).toEqual([["claude-session"]]);
  expect(sync(home).rebuilt).toBeNull();

  setSchemaVersion(home, current - 1);
  rebuild(home);
  expect(schemaVersion(home)).toBe(current);
});

test("AC-10 a record of a newer schema version is refused by sync, query and sql naming a newer agent-record", () => {
  const home = syncedHome();
  const newer = schemaVersion(home) + 1;
  setSchemaVersion(home, newer);

  expectVersionRefused(home, READERS_AND_WRITER, `run an agent-record that reads schema version ${newer}`);
  expect(schemaVersion(home)).toBe(newer);
});

test("AC-11 every command that runs prints ok and its result on stdout, exiting 0", () => {
  const home = scratchHome();
  for (const args of [
    ["sync"],
    ["rebuild"],
    ["query", "list"],
    ["sql", "select 1 as one"],
    ["agent", "install"],
    ["doctor"],
  ]) {
    const [command = ""] = args;
    succeeded(runCli(home, args), command, z.unknown());
  }
});

test("AC-11 a failing doctor still prints ok on stdout and exits 1", () => {
  const ran = runCli(scratchHome(), ["doctor"]);
  expect({ exitCode: ran.exitCode, stderr: ran.stderr }).toEqual({ exitCode: 1, stderr: "" });
  const result = okLine(ran, "doctor", DOCTOR_RESULT);
  expect({
    checks: result.checks.map(({ name, state }) => ({ name, state })),
    failing: result.failing,
  }).toEqual({
    checks: [
      { name: "record", state: "fail" },
      { name: "backup", state: "ok" },
      { name: "sync", state: "fail" },
      { name: "agent", state: "warn" },
      { name: "mirror", state: "warn" },
    ],
    failing: 2,
  });
});

test("AC-11 every command refuses bad input on stderr with a refusal's kind, code, message, meta and resolve", () => {
  const home = scratchHome();
  for (const { args, usage } of [
    { args: ["sync", "--bogus"], usage: USAGE.sync },
    { args: ["rebuild", "--bogus"], usage: USAGE.rebuild },
    { args: ["query", "search", "parser", "--bogus"], usage: USAGE.search },
    { args: ["sql", "select 1 as one", "--bogus"], usage: USAGE.sql },
    { args: ["agent", "install", "--bogus"], usage: USAGE.agent },
    { args: ["doctor", "--bogus"], usage: USAGE.doctor },
  ]) {
    const [command = ""] = args;
    const error = refused(runCli(home, args), command);
    expect({ command, kind: error.kind, code: error.code, resolve: error.resolve }).toEqual({
      command,
      kind: "refusal",
      code: "unknown_flag",
      resolve: usage,
    });
    expect(error.message).not.toBe("");
    expect(error.meta).toMatchObject({ flag: "--bogus" });
  }
});

test("AC-12 agent-record alone lists every command with its usage and summary", () => {
  const result = succeeded(
    runCli(scratchHome(), []),
    "agent-record",
    z.strictObject({ commands: z.array(USAGE_ENTRY) }),
  );
  expect(result.commands.map(({ name, usage }) => ({ name, usage }))).toEqual([
    { name: "sync", usage: USAGE.sync },
    { name: "rebuild", usage: USAGE.rebuild },
    { name: "query", usage: USAGE.query },
    { name: "sql", usage: USAGE.sql },
    { name: "agent", usage: USAGE.agent },
    { name: "doctor", usage: USAGE.doctor },
  ]);
  for (const { summary } of result.commands) expect(summary).not.toBe("");
});

test("AC-12 an unknown command is refused with the listing as its fix", () => {
  const error = refused(runCli(scratchHome(), ["nope"]), "agent-record");
  expect({ code: error.code, resolve: error.resolve }).toEqual({
    code: "unknown_command",
    resolve: "agent-record",
  });
});

test("AC-12 each malformed argument form is refused with the command's usage as its fix", () => {
  const home = scratchHome();
  const cases = [
    { args: ["sync", "--x"], code: "unknown_flag", usage: USAGE.sync },
    { args: ["query", "--rows", "5"], code: "unknown_flag", usage: USAGE.query },
    { args: ["query", "search", "--rows"], code: "flag_without_value", usage: USAGE.search },
    {
      args: ["query", "search", "a", "--rows", "2", "--rows", "3"],
      code: "flag_repeated",
      usage: USAGE.search,
    },
    { args: ["rebuild", "extra"], code: "argument_count", usage: USAGE.rebuild },
    { args: ["query", "search"], code: "argument_count", usage: USAGE.search },
    { args: ["query", "search", " "], code: "blank_argument", usage: USAGE.search },
    { args: ["agent", "nope"], code: "unknown_verb", usage: USAGE.agent },
  ];
  for (const { args, code, usage } of cases) {
    const [command = ""] = args;
    const error = refused(runCli(home, args), command);
    expect({ args, code: error.code, resolve: error.resolve, usage: error.meta.usage }).toEqual({
      args,
      code,
      resolve: usage,
      usage,
    });
  }
});

test("AC-24 query and sql with no record are refused naming sync, and create no file", () => {
  const home = scratchHome();
  for (const { command, args } of READERS) {
    const error = refused(runCli(home, args), command);
    expect({ command, code: error.code, resolve: error.resolve }).toEqual({
      command,
      code: "no_database",
      resolve: "agent-record sync",
    });
  }
  expect(readdirSync(home.root, { recursive: true })).toEqual([]);
});

function expectUnopenableRefusedEverywhere(home: Home): void {
  const fix = `make ${home.record} a file you can read and write, or move it aside and run \`agent-record rebuild\``;
  for (const { command, args } of [...READERS_AND_WRITER, { command: "rebuild", args: ["rebuild"] }]) {
    const error = refused(runCli(home, args), command);
    expect({ command, kind: error.kind, code: error.code, meta: error.meta, resolve: error.resolve }).toEqual(
      {
        command,
        kind: "refusal",
        code: "record_unopenable",
        meta: { path: home.record },
        resolve: fix,
      },
    );
  }
  const { report } = doctor(home);
  expect(report.checks.find(({ name }) => name === "record")).toMatchObject({ state: "fail", fix });
}

test("AC-29 a directory at the record path is refused by every command naming the path, never command_failed", () => {
  const home = scratchHome();
  mkdirSync(home.record, { recursive: true });

  expectUnopenableRefusedEverywhere(home);
  expect(readdirSync(home.record)).toEqual([]);
});

test("AC-29 a record that is not a database is refused by every command naming the path, never command_failed", () => {
  const home = scratchHome();
  mkdirSync(dirname(home.record), { recursive: true });
  writeFileSync(home.record, "not a database\n");

  expectUnopenableRefusedEverywhere(home);
  expect(readFileSync(home.record, "utf8")).toBe("not a database\n");
});

test("AC-29 a busy record is refused by every command with a code and fix, never command_failed", () => {
  const home = syncedHome();
  const fix = "run this again; if it keeps failing, close whatever holds the file";
  for (const { command, args } of [...READERS_AND_WRITER, { command: "rebuild", args: ["rebuild"] }]) {
    const error = holdingRecord(home, "exclusive", () => refused(runCli(home, args), command));
    expect({ command, kind: error.kind, code: error.code, meta: error.meta, resolve: error.resolve }).toEqual(
      { command, kind: "refusal", code: "record_busy", meta: { path: home.record }, resolve: fix },
    );
  }
});
