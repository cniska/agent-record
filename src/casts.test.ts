import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Glob } from "bun";
import { invariant } from "./assert";
import { nodesOf } from "./syntax.test-support";

const SRC = import.meta.dir;

function castBreaches(file: string, text: string): readonly string[] {
  const breaches: string[] = [];
  for (const node of nodesOf(text)) {
    if (node.type !== "CallExpression" || node.callee.type !== "MemberExpression") continue;
    const { object, property } = node.callee;
    if (property.type !== "Identifier") continue;
    invariant(node.loc != null, `Babel locates the ${node.type}`);
    const line = node.loc.start.line;
    if (object.type === "Identifier" && object.name === "z" && property.name === "object") {
      breaches.push(`${file}:${line} builds a bare z.object`);
    }
  }
  return breaches;
}

function sources(): readonly { readonly file: string; readonly text: string }[] {
  return [...new Glob("**/*.{ts,tsx}").scanSync(SRC)].map((file) => ({
    file,
    text: readFileSync(join(SRC, file), "utf8"),
  }));
}

describe("every object schema in src", () => {
  test("is built strict or loose, never a bare z.object", () => {
    expect(sources().flatMap(({ file, text }) => castBreaches(file, text))).toEqual([]);
  });
});

describe("the cast check", () => {
  test("catches a bare z.object on one line or split across two", () => {
    expect(castBreaches("a.ts", "const A = z.object({ a: z.string() });")).toEqual([
      "a.ts:1 builds a bare z.object",
    ]);
    expect(castBreaches("a.ts", "const A = z\n  .object({ a: z.string() })\n  .optional();")).toEqual([
      "a.ts:1 builds a bare z.object",
    ]);
  });

  test("lets a strict or loose object through", () => {
    expect(castBreaches("a.ts", "const A = z.strictObject({}); const B = z.looseObject({});")).toEqual([]);
  });

  test("reads syntax, not text", () => {
    expect(castBreaches("a.ts", 'const help = "z.object({})";')).toEqual([]);
  });
});
