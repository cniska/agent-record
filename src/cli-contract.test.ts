import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { allCommands, findCommand } from "./cli-commands";
import { runCli, scratchEnv } from "./fixtures.test-support";
import { SYNCED_SESSION, syncedRecord } from "./query.test-support";
import { QUERIES } from "./query-registry";

const COMMANDS = await allCommands();

const SRC = import.meta.dir;

function refused(args: readonly string[]): { exitCode: number; error: unknown } {
  const root = mkdtempSync(join(tmpdir(), "agent-record-refused-"));
  try {
    const run = runCli(scratchEnv(root), args);
    return { exitCode: run.exitCode, error: JSON.parse(run.stderr).error };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function sources(): string[] {
  return readdirSync(SRC, { recursive: true })
    .map(String)
    .filter((path) => /\.tsx?$/.test(path) && !/\.test\.tsx?$|test-support/.test(path));
}

describe("the command contract", () => {
  test("cli.ts only dispatches through the list of commands", () => {
    const imports = [...readFileSync(join(SRC, "cli.ts"), "utf8").matchAll(/from "([^"]+)"/g)].map(
      (m) => m[1],
    );
    expect(imports.sort()).toEqual(["./cli-commands", "./cli-contract", "./cli-output"]);
  });

  test("only the writer writes to stdout", () => {
    const writers = sources().filter((path) =>
      /console\.log|process\.stdout\.write/.test(readFileSync(join(SRC, path), "utf8")),
    );
    expect(writers.sort()).toEqual(["cli-output.ts"]);
  });

  test("only the list of commands imports a command file", () => {
    const importers = sources().filter(
      (path) =>
        path !== "cli-commands.ts" &&
        /(?:from |import\()"\.\/[a-z-]+-command"/.test(readFileSync(join(SRC, path), "utf8")),
    );
    expect(importers).toEqual([]);
  });

  test("every command declared is on the list, once", () => {
    const declared = sources().flatMap((path) =>
      [...readFileSync(join(SRC, path), "utf8").matchAll(/export const (\w+): Command = \{/g)].map(
        (m) => m[1],
      ),
    );
    const names = COMMANDS.map((command) => command.name);
    expect(new Set(names).size).toBe(names.length);
    expect(declared).toHaveLength(COMMANDS.length);
  });

  test("a name loads the command it names, and nothing else", async () => {
    for (const command of COMMANDS) {
      expect((await findCommand(command.name))?.name).toBe(command.name);
    }
    expect(findCommand("constructor")).toBeUndefined();
  });

  test("each command file holds one command, named for the file", () => {
    for (const path of sources().filter((p) => p.endsWith("-command.ts"))) {
      const declared = [
        ...readFileSync(join(SRC, path), "utf8").matchAll(
          /export const \w+: Command = \{\s*name: "([^"]+)"/g,
        ),
      ];
      expect({ path, names: declared.map((m) => m[1]) }).toEqual({
        path,
        names: [path.replace(/-command\.ts$/, "")],
      });
    }
  });

  test("a command that takes no arguments refuses one, resolving with its usage", () => {
    for (const name of ["sync", "rebuild", "doctor"]) {
      const usage = `agent-record ${name}`;
      expect(refused([name, "extra"])).toEqual({
        exitCode: 1,
        error: {
          kind: "refusal",
          code: "argument_count",
          message: "takes no arguments and got 1: extra",
          meta: { usage, takes: 0, got: ["extra"] },
          resolve: usage,
        },
      });
    }
    expect(refused(["agent", "install", "extra"])).toMatchObject({
      exitCode: 1,
      error: {
        code: "argument_count",
        message: "takes 1 argument and got 2: install extra",
        resolve: "agent-record agent install",
      },
    });
  });

  test("a command refuses a verb named like a property every object inherits", () => {
    expect(refused(["query", "constructor"])).toMatchObject({
      exitCode: 1,
      error: { code: "unknown_query", meta: { name: "constructor" }, resolve: "agent-record query list" },
    });
    expect(refused(["agent", "constructor"])).toMatchObject({
      exitCode: 1,
      error: {
        code: "unknown_verb",
        meta: { usage: "agent-record agent install", verb: "constructor" },
        resolve: "agent-record agent install",
      },
    });
  });

  test("an unknown command is refused, resolved by the listing", () => {
    expect(refused(["nonesuch"])).toEqual({
      exitCode: 1,
      error: {
        kind: "refusal",
        code: "unknown_command",
        message: "nonesuch is not an agent-record command",
        meta: { name: "nonesuch" },
        resolve: "agent-record",
      },
    });
  });

  test("a named query or sql refuses a missing or blank argument rather than answering over everything", () => {
    const usage = 'agent-record query prior-art "<path fragment>" [--rows <n>]';
    expect(refused(["query", "prior-art"])).toMatchObject({
      exitCode: 1,
      error: { code: "argument_count", resolve: usage },
    });
    expect(refused(["query", "search", "  "])).toMatchObject({
      exitCode: 1,
      error: { code: "blank_argument", message: "the argument is blank" },
    });
    expect(refused(["sql"])).toMatchObject({
      exitCode: 1,
      error: { code: "argument_count", resolve: 'agent-record sql "<select>" [--rows <n>]' },
    });
  });

  test("thread takes --at, and a query that does not take it refuses it", () => {
    const root = mkdtempSync(join(tmpdir(), "agent-record-at-"));
    try {
      syncedRecord(root);
      const run = runCli(scratchEnv(root), [
        "query",
        "thread",
        SYNCED_SESSION.slice(0, 8),
        "--at",
        "2026-09-16T10:04",
      ]);
      expect(run.exitCode).toBe(0);
      expect(JSON.parse(run.stdout).result.denominator).toContain("centered on 2026-09-16T10:04");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
    expect(refused(["query", "search", "words", "--at", "2026-09-16T10:04"])).toMatchObject({
      exitCode: 1,
      error: { code: "unknown_flag", resolve: 'agent-record query search "<words>" [--rows <n>]' },
    });
  });

  test("--rows refuses what is not a count", () => {
    expect(refused(["query", "search", "words", "--rows", "0"])).toEqual({
      exitCode: 1,
      error: {
        kind: "refusal",
        code: "not_a_count",
        message: "--rows 0 is not a count of at least 1",
        meta: { value: "0" },
        resolve: "--rows <n>, a whole number of at least 1",
      },
    });
  });

  test("every command states its usage and what it is for", () => {
    for (const command of COMMANDS) {
      expect(command.usage).toStartWith(`agent-record ${command.name}`);
      expect(command.summary.length).toBeGreaterThan(0);
    }
  });

  test("every named query's usage names each flag its parse takes, --rows last", () => {
    for (const query of QUERIES) {
      for (const flag of query.flags) expect(query.usage).toContain(` [--${flag} <`);
      expect(query.usage).toEndWith(" [--rows <n>]");
    }
  });
});
