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
