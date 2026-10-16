import { describe, expect, test } from "bun:test";
import type { CallExpression, MemberExpression } from "@babel/types";
import { invariant } from "./assert";
import { nodesOf, sourcesOf } from "./syntax.test-support";

const STATEMENT_BUILDERS = new Set(["query", "prepare"]);

const UNCLAIMED_ROWS = new Set(["TSUnknownKeyword", "TSVoidKeyword"]);

type MethodCall = {
  readonly call: CallExpression;
  readonly on: MemberExpression["object"];
  readonly method: string;
  readonly line: number;
};

function* methodCallsOf(text: string): Iterable<MethodCall> {
  for (const node of nodesOf(text)) {
    if (node.type !== "CallExpression" || node.callee.type !== "MemberExpression") continue;
    const { object, property } = node.callee;
    if (property.type !== "Identifier") continue;
    invariant(node.loc != null, `Babel locates the ${node.type}`);
    yield { call: node, on: object, method: property.name, line: node.loc.start.line };
  }
}

function objectBreaches(file: string, text: string): readonly string[] {
  return [...methodCallsOf(text)]
    .filter(({ on, method }) => on.type === "Identifier" && on.name === "z" && method === "object")
    .map(({ line }) => `${file}:${line} builds a bare z.object`);
}

function rowClaimBreaches(file: string, text: string): readonly string[] {
  return [...methodCallsOf(text)]
    .filter(({ call, method }) => {
      const row = call.typeParameters?.params[0];
      return STATEMENT_BUILDERS.has(method) && row !== undefined && !UNCLAIMED_ROWS.has(row.type);
    })
    .map(({ line, method }) => `${file}:${line} claims a row type on .${method}`);
}

describe("every object schema in src", () => {
  test("is built strict or loose, never a bare z.object", () => {
    expect(sourcesOf(import.meta.dir).flatMap(({ file, text }) => objectBreaches(file, text))).toEqual([]);
  });
});

describe("every statement in src", () => {
  test("claims no row type, so its rows are parsed", () => {
    expect(sourcesOf(import.meta.dir).flatMap(({ file, text }) => rowClaimBreaches(file, text))).toEqual([]);
  });
});

describe("the cast check", () => {
  test("catches a bare z.object on one line or split across two", () => {
    expect(objectBreaches("a.ts", "const A = z.object({ a: z.string() });")).toEqual([
      "a.ts:1 builds a bare z.object",
    ]);
    expect(objectBreaches("a.ts", "const A = z\n  .object({ a: z.string() })\n  .optional();")).toEqual([
      "a.ts:1 builds a bare z.object",
    ]);
  });

  test("lets a strict or loose object through", () => {
    expect(objectBreaches("a.ts", "const A = z.strictObject({}); const B = z.looseObject({});")).toEqual([]);
  });

  test("catches a row type claimed on query or prepare, on one line or split across two", () => {
    expect(rowClaimBreaches("a.ts", 'db.query<{ n: number }, []>("SELECT 1 AS n")')).toEqual([
      "a.ts:1 claims a row type on .query",
    ]);
    expect(rowClaimBreaches("a.ts", 'db\n  .prepare<\n    Row,\n    [string]\n  >("SELECT ?")')).toEqual([
      "a.ts:1 claims a row type on .prepare",
    ]);
  });

  test("lets an unknown or void row with its parameter tuple through", () => {
    expect(
      rowClaimBreaches(
        "a.ts",
        'db.query<unknown, [string]>("SELECT ?"); db.prepare<void, [string]>("DELETE");',
      ),
    ).toEqual([]);
    expect(rowClaimBreaches("a.ts", 'db.query("SELECT 1")')).toEqual([]);
  });

  test("reads syntax, not text", () => {
    expect(objectBreaches("a.ts", 'const help = "z.object({})";')).toEqual([]);
    expect(rowClaimBreaches("a.ts", 'const help = "db.query<Row>(sql)";')).toEqual([]);
  });
});
