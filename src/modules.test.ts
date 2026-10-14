import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Glob } from "bun";
import { importsOf } from "./syntax.test-support";

const SRC = import.meta.dir;

const PUBLIC: Readonly<Record<string, readonly string[]>> = {
  agent: ["agent-launchd"],
  assert: ["assert"],
  cli: ["cli-flags"],
  "coded-error": ["coded-error"],
  db: ["db", "db-error", "db-lock", "db-read", "db-schema"],
  doctor: [],
  env: ["env"],
  error: ["error-read"],
  file: ["file-backup", "file-copy"],
  mirror: ["mirror"],
  git: ["git", "git-checkout", "git-operations", "git-probe", "git-remote"],
  ingest: [
    "ingest-checkout-failure",
    "ingest-event-kinds",
    "ingest-session-records",
    "ingest-skill-load",
    "ingest-source-read",
    "ingest-sync",
    "ingest-tools",
  ],
  modules: [],
  paths: ["paths"],
  plugin: [],
  query: ["query", "query-row-cap"],
  rebuild: [],
  repo: ["repo-files"],
  spec: [],
  sql: [],
  sync: ["sync-stamp"],
  timestamp: ["timestamp"],
  worktree: ["worktree"],
};

const LIST_OF_COMMANDS = "cli-commands.ts";

type Source = { readonly file: string; readonly text: string };

function sources(): readonly Source[] {
  return [...new Glob("**/*.{ts,tsx}").scanSync(SRC)].map((file) => ({
    file,
    text: readFileSync(join(SRC, file), "utf8"),
  }));
}

const isTestSupport = (name: string) => /\.test-support(\.ts)?$/.test(name);

const isTest = (name: string) => /\.test\.ts$/.test(name);

function moduleOf(name: string): string | null {
  const base = name.replace(/\.ts$/, "");
  const owners = Object.keys(PUBLIC).filter(
    (module) => base === module || base.startsWith(`${module}-`) || base.startsWith(`${module}.`),
  );
  return owners.sort((a, b) => b.length - a.length)[0] ?? null;
}

function isPublic(owner: string, target: string): boolean {
  return (
    target === `${owner}-contract` || target.endsWith("-command") || (PUBLIC[owner] ?? []).includes(target)
  );
}

function localTargets(text: string): readonly string[] {
  return importsOf(text)
    .filter((path) => path.startsWith("./"))
    .map((path) => path.slice(2).replace(/\.ts$/, ""));
}

function boundaryBreaches(file: string, text: string): readonly string[] {
  if (isTestSupport(file)) return [];
  const importer = moduleOf(file);
  return localTargets(text)
    .filter((target) => !isTestSupport(target))
    .flatMap((target) => {
      const owner = moduleOf(target);
      if (owner === null) return [`${file} imports ./${target}, a file of no module`];
      if (owner === importer || isPublic(owner, target)) return [];
      return [`${file} imports ./${target}, another module's own file`];
    });
}

function commandBreaches(file: string, text: string): readonly string[] {
  if (file === LIST_OF_COMMANDS || isTest(file) || isTestSupport(file)) return [];
  return localTargets(text)
    .filter((target) => target.endsWith("-command"))
    .map((target) => `${file} imports ./${target}, a command`);
}

describe("the modules", () => {
  test("another module or its tests reach a module only through its contract, its commands and the files it publishes", () => {
    expect(sources().flatMap(({ file, text }) => boundaryBreaches(file, text))).toEqual([]);
  });

  test("only the list of commands imports a command", () => {
    expect(sources().flatMap(({ file, text }) => commandBreaches(file, text))).toEqual([]);
  });
});

describe("the module checks", () => {
  test("place every file in a module, and publish only files that exist", () => {
    const names = sources().map(({ file }) => file.replace(/\.ts$/, ""));
    expect(names.filter((name) => !isTestSupport(name) && moduleOf(name) === null)).toEqual([]);
    expect(
      Object.values(PUBLIC)
        .flat()
        .filter((name) => !names.includes(name)),
    ).toEqual([]);
    expect(
      Object.entries(PUBLIC).flatMap(([module, files]) => files.filter((name) => moduleOf(name) !== module)),
    ).toEqual([]);
  });

  test("place a file in the longest module its name starts with", () => {
    expect(moduleOf("coded-error.ts")).toBe("coded-error");
    expect(moduleOf("db-read.test-support.ts")).toBe("db");
    expect(moduleOf("ingest-parse-claude.ts")).toBe("ingest");
    expect(moduleOf("query.ts")).toBe("query");
    expect(moduleOf("queries.ts")).toBeNull();
  });

  test("catch an import of another module's own file, but not of its own, a published file, a contract or a command", () => {
    const text = [
      'import { a } from "./query-thread";',
      'import { b } from "./ingest-git";',
      'import { c } from "./db-read";',
      'import { d } from "./sql-contract";',
      'import { e } from "./query-ops";',
      'import { f } from "./fixtures.test-support";',
      'import { g } from "./nowhere";',
    ].join("\n");
    expect(boundaryBreaches("query-command.ts", text)).toEqual([
      "query-command.ts imports ./ingest-git, another module's own file",
      "query-command.ts imports ./nowhere, a file of no module",
    ]);
  });

  test("hold a test to its module's reach, but let a test fixture reach any file", () => {
    const text = 'import { ingestCommits } from "./ingest-git";';
    expect(boundaryBreaches("query-prior-art.test.ts", text)).toEqual([
      "query-prior-art.test.ts imports ./ingest-git, another module's own file",
    ]);
    expect(boundaryBreaches("query.test-support.ts", text)).toEqual([]);
  });

  test("catch an import however it is written", () => {
    const breach = "doctor.ts imports ./ingest-git, another module's own file";
    for (const text of [
      'import { ingestCommits } from "./ingest-git";',
      'import type { GitReport } from "./ingest-git";',
      'import { type GitReport } from "./ingest-git";',
      'export type { GitReport } from "./ingest-git";',
      'export * from "./ingest-git";',
      'import "./ingest-git";',
      'import type {\n  GitReport,\n} from\n  "./ingest-git";',
      'import { ingestCommits } from "./ingest-git.ts";',
      'const git = await import("./ingest-git");',
      "const git = await import(`./ingest-git`);",
      'const git = require("./ingest-git");',
      'let report: import("./ingest-git").GitReport;',
      'import git = require("./ingest-git");',
    ]) {
      expect(boundaryBreaches("doctor.ts", text)).toEqual([breach]);
    }
    expect(boundaryBreaches("doctor.ts", 'const path = "./ingest-git";')).toEqual([]);
  });

  test("catch a command imported anywhere but the list of commands or a test", () => {
    const text = 'const { syncCommand } = await import("./sync-command");';
    expect(commandBreaches("doctor.ts", text)).toEqual(["doctor.ts imports ./sync-command, a command"]);
    expect(commandBreaches("cli-commands.ts", text)).toEqual([]);
    expect(commandBreaches("sync-command.test.ts", text)).toEqual([]);
  });
});
