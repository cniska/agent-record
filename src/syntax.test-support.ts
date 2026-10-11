import { parse } from "@babel/parser";
import { isNode, type Node } from "@babel/types";

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
