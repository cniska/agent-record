import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Node } from "@babel/types";
import { decode } from "@toon-format/toon";
import { z } from "zod";
import { allCommands, findCommand } from "./cli-commands";
import { runCli, scratchEnv } from "./fixtures.test-support";
import { SYNCED_SESSION, syncedRecord } from "./query.test-support";
import { importsOf, nodesOf, productionSourcesOf } from "./syntax.test-support";

const COMMANDS = await allCommands();

const SRC = import.meta.dir;

function refused(args: readonly string[]): { exitCode: number; error: unknown } {
  const root = mkdtempSync(join(tmpdir(), "agent-record-refused-"));
  try {
    const run = runCli(scratchEnv(root), args);
    return {
      exitCode: run.exitCode,
      error: z.looseObject({ error: z.unknown() }).parse(decode(run.stderr)).error,
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function isMember(node: Node, object: string, property: string): boolean {
  return (
    node.type === "MemberExpression" &&
    node.property.type === "Identifier" &&
    node.property.name === property &&
    node.object.type === "Identifier" &&
    node.object.name === object
  );
}

function writesStdout(text: string): boolean {
  return [...nodesOf(text)].some(
    (node) =>
      isMember(node, "console", "log") ||
      isMember(node, "process", "stdout") ||
      isMember(node, "Bun", "stdout"),
  );
}

const ENVIRONMENT_FUNCTIONS: ReadonlySet<string> = new Set(["tmpdir", "homedir", "userInfo"]);
const GLOBAL_ENVIRONMENT: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ["process", new Set(["env", "execPath", "argv0", "cwd"])],
  ["Bun", new Set(["env"])],
]);

function readsGlobalEnvironment(node: Node): boolean {
  for (const [global, properties] of GLOBAL_ENVIRONMENT) {
    if ([...properties].some((property) => isMember(node, global, property))) return true;
    if (
      node.type === "VariableDeclarator" &&
      node.init?.type === "Identifier" &&
      node.init.name === global &&
      node.id.type === "ObjectPattern" &&
      node.id.properties.some(
        (property) =>
          property.type === "ObjectProperty" &&
          property.key.type === "Identifier" &&
          properties.has(property.key.name),
      )
    )
      return true;
  }
  return false;
}

function readsEnvironment(text: string): boolean {
  return [...nodesOf(text)].some(
    (node) =>
      readsGlobalEnvironment(node) ||
      (node.type === "MemberExpression" &&
        node.object.type === "MetaProperty" &&
        node.property.type === "Identifier" &&
        node.property.name === "dir") ||
      (node.type === "Identifier" && ENVIRONMENT_FUNCTIONS.has(node.name)),
  );
}

describe("the command contract", () => {
  test("cli.ts only runs the CLI with its runtime", () => {
    expect([...importsOf(readFileSync(join(SRC, "cli.ts"), "utf8"))].sort()).toEqual([
      "../package.json",
      "./cli-main",
      "./env",
      "node:path",
    ]);
  });

  test("cli-release.ts only runs the CLI with a release's runtime", () => {
    expect([...importsOf(readFileSync(join(SRC, "cli-release.ts"), "utf8"))].sort()).toEqual([
      "./cli-contract",
      "./cli-main",
      "./env",
    ]);
  });

  test("only the two entries read the environment, and env.ts parses it", () => {
    const readers = productionSourcesOf(SRC)
      .filter(({ text }) => readsEnvironment(text))
      .map(({ file }) => file);
    expect(readers.sort()).toEqual(["cli-release.ts", "cli.ts", "env.ts"]);
  });

  test("the environment check finds each way to read it, and not one named in a string", () => {
    for (const text of [
      "const home = process.env.HOME;",
      "const { env } = process;",
      "run(process.execPath);",
      "const home = Bun.env.HOME;",
      "const user = userInfo();",
      'const up = resolve(import.meta.dir, "..");',
      'import { tmpdir } from "node:os";',
      "const home = os.homedir();",
    ]) {
      expect(readsEnvironment(text)).toBe(true);
    }
    expect(readsEnvironment('const note = "process.env and tmpdir()"; process.argv.slice(2);')).toBe(false);
  });

  test("the CLI only dispatches through the list of commands", () => {
    expect([...importsOf(readFileSync(join(SRC, "cli-main.ts"), "utf8"))].sort()).toEqual([
      "./cli-commands",
      "./cli-contract",
      "./cli-output",
    ]);
  });

  test("only the writer writes to stdout", () => {
    const writers = productionSourcesOf(SRC)
      .filter(({ text }) => writesStdout(text))
      .map(({ file }) => file);
    expect(writers.sort()).toEqual(["cli-output.ts"]);
  });

  test("the stdout check finds a write however it is called, and not one named in a string", () => {
    for (const text of [
      'console.log("x");',
      "process.stdout.write(x);",
      "const log = console.log;",
      "[x].forEach(console.log);",
      "const { write } = process.stdout;",
      "const out = process.stdout;",
      'await Bun.write(Bun.stdout, "x");',
    ]) {
      expect(writesStdout(text)).toBe(true);
    }
    expect(
      writesStdout('const help = "console.log(x) or process.stdout.write(x)"; process.stderr.write(help);'),
    ).toBe(false);
  });

  test("every command declared is on the list, once", () => {
    const declared = productionSourcesOf(SRC).flatMap(({ text }) =>
      [...text.matchAll(/export const (\w+): Command = \{/g)].map((m) => m[1]),
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
    for (const { file: path, text } of productionSourcesOf(SRC).filter(({ file }) =>
      file.endsWith("-command.ts"),
    )) {
      const declared = [...text.matchAll(/export const \w+: Command = \{\s*name: "([^"]+)"/g)];
      expect({ path, names: declared.map((m) => m[1]) }).toEqual({
        path,
        names: [path.replace(/-command\.ts$/, "")],
      });
    }
  });

  test("a command that takes no arguments refuses one, resolving with its usage", () => {
    for (const [name, usage] of [
      ["sync", "agent-record sync [--full]"],
      ["rebuild", "agent-record rebuild [--full]"],
      ["doctor", "agent-record doctor [--full]"],
    ] as const) {
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

  test("--help, -h and help print the listing agent-record alone prints", () => {
    const root = mkdtempSync(join(tmpdir(), "agent-record-help-"));
    try {
      const alone = runCli(scratchEnv(root), []);
      expect(decode(alone.stdout)).toMatchObject({ command: "agent-record", ok: true });
      for (const help of ["--help", "-h", "help"]) {
        const asked = runCli(scratchEnv(root), [help]);
        expect({ help, ...asked }).toEqual({ help, exitCode: 0, stdout: alone.stdout, stderr: "" });
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
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
        "2026-09-16T10:04:00Z",
      ]);
      expect(run.exitCode).toBe(0);
      expect(decode(run.stdout)).toMatchObject({
        result: { denominator: expect.stringContaining("centered on 2026-09-16T10:04:00.000Z") },
      });
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
        meta: { flag: "rows", value: "0" },
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
});
