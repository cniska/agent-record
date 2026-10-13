import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const transpiler = new Bun.Transpiler({ loader: "ts" });
const SHEBANG = /^#!.*\n/;

const EAGER_KINDS: ReadonlySet<string> = new Set(["import-statement", "require-call"]);

function loadedBeforeACommandIsChosen(entry: string): ReadonlySet<string> {
  const reached = new Set([entry]);
  for (const file of reached) {
    if (!file.startsWith("./")) continue;
    const source = readFileSync(join(import.meta.dir, `${file}.ts`), "utf8").replace(SHEBANG, "");
    for (const { path, kind } of transpiler.scanImports(source)) if (EAGER_KINDS.has(kind)) reached.add(path);
  }
  return reached;
}

describe("the CLI entry", () => {
  test("loads neither SQLite nor any command before a command is chosen, so a usage error stays fast", () => {
    const loaded = [...loadedBeforeACommandIsChosen("./cli")];
    expect(loaded).toContain("./coded-error");
    expect(loaded.filter((module) => module === "bun:sqlite" || module.endsWith("-command"))).toEqual([]);
  });
});
