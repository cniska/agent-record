import { invariant } from "./assert";
import type { Cell, Row } from "./query-contract";

export type UnprintableColumn = { readonly kind: "repeated" | "reordered"; readonly column: string };

function reorderedColumn(columns: readonly string[]): string | null {
  const keys = Object.keys(Object.fromEntries(columns.map((column) => [column, null])));
  return keys.find((key, at) => key !== columns[at]) ?? null;
}

export function unprintableColumn(columns: readonly string[]): UnprintableColumn | null {
  const repeated = columns.find((column, at) => columns.indexOf(column) !== at);
  if (repeated !== undefined) return { kind: "repeated", column: repeated };
  const reordered = reorderedColumn(columns);
  if (reordered !== null) return { kind: "reordered", column: reordered };
  return null;
}

function recordOf(columns: readonly string[], cells: readonly Cell[]): Row {
  invariant(cells.length === columns.length, `a row holds one cell per column of ${columns.join(", ")}`);
  return Object.fromEntries(columns.map((column, at) => [column, cells[at] ?? null]));
}

export function recordsOf(columns: readonly string[], rows: readonly (readonly Cell[])[]): readonly Row[] {
  const unprintable = unprintableColumn(columns);
  invariant(
    unprintable === null,
    `the column ${unprintable?.column} is ${unprintable?.kind} in ${columns.join(", ")}`,
  );
  return rows.map((cells) => recordOf(columns, cells));
}
