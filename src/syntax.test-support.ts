import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "@babel/parser";
import { isNode, type Node } from "@babel/types";
import { Glob } from "bun";
import { invariant } from "./assert";

type Source = { readonly file: string; readonly text: string };

export function sourcesOf(dir: string): readonly Source[] {
  return [...new Glob("**/*.{ts,tsx}").scanSync(dir)].map((file) => ({
    file,
    text: readFileSync(join(dir, file), "utf8"),
  }));
}

const NOT_PRODUCTION = /\.test\.tsx?$|test-support/;

export function productionSourcesOf(dir: string): readonly Source[] {
  return sourcesOf(dir).filter(({ file }) => !NOT_PRODUCTION.test(file));
}

export function* nodesOf(text: string): Iterable<Node> {
  yield* walk(parse(text, { sourceType: "module", plugins: ["typescript"] }).program);
}

function* walk(value: unknown): Iterable<Node> {
  if (Array.isArray(value)) {
    for (const item of value) yield* walk(item);
  } else if (isNode(value)) {
    yield value;
    for (const child of Object.values(value)) yield* walk(child);
  }
}

export function importsOf(text: string): readonly string[] {
  const paths: string[] = [];
  for (const node of nodesOf(text)) {
    if (
      (node.type === "ImportDeclaration" ||
        node.type === "ExportNamedDeclaration" ||
        node.type === "ExportAllDeclaration") &&
      node.source
    ) {
      paths.push(node.source.value);
    } else if (node.type === "TSImportType") {
      paths.push(node.argument.value);
    } else if (
      node.type === "TSImportEqualsDeclaration" &&
      node.moduleReference.type === "TSExternalModuleReference"
    ) {
      paths.push(node.moduleReference.expression.value);
    } else if (
      node.type === "CallExpression" &&
      (node.callee.type === "Import" || (node.callee.type === "Identifier" && node.callee.name === "require"))
    ) {
      const [first] = node.arguments;
      if (first?.type === "StringLiteral") paths.push(first.value);
      if (first?.type === "TemplateLiteral" && first.expressions.length === 0) {
        const [quasi] = first.quasis;
        if (quasi?.value.cooked != null) paths.push(quasi.value.cooked);
      }
    }
  }
  return [...new Set(paths)];
}

const TEST = "test";

type Kind = "test" | "suite";

const KINDS: ReadonlyMap<string, Kind> = new Map([
  [TEST, "test"],
  ["describe", "suite"],
]);

export type TestCall =
  | { readonly kind: "test"; readonly name: string | null; readonly modifier: string | null }
  | { readonly kind: "suite"; readonly name: string | null; readonly modifier: string };

function chainOf(callee: Node): readonly Node[] {
  if (callee.type === "CallExpression") return [callee, ...chainOf(callee.callee)];
  if (callee.type === "MemberExpression") return [callee, ...chainOf(callee.object)];
  return [callee];
}

function sourceOf(text: string, node: Node): string {
  const { start, end } = node;
  invariant(start != null && end != null, `Babel locates the ${node.type}`);
  return text.slice(start, end);
}

export function testCallsOf(text: string): readonly TestCall[] {
  const calls: TestCall[] = [];
  const factories = new Set<Node>();
  for (const node of nodesOf(text)) {
    if (node.type !== "CallExpression" || factories.has(node)) continue;
    const { callee } = node;
    const [first] = node.arguments;
    const name = first?.type === "StringLiteral" ? first.value : null;
    if (callee.type === "Identifier") {
      if (callee.name === TEST) calls.push({ kind: "test", name, modifier: null });
      continue;
    }
    const chain = chainOf(callee);
    const root = chain.at(-1);
    if (root?.type !== "Identifier") continue;
    const kind = KINDS.get(root.name);
    if (kind === undefined) continue;
    for (const link of chain) if (link.type === "CallExpression") factories.add(link);
    calls.push({ kind, name, modifier: sourceOf(text, callee) });
  }
  return calls;
}
