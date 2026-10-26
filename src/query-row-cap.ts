import { countFlag } from "./query";
import type { CappedResult, QueryResult } from "./query-contract";
import { recordsOf } from "./query-table";

export const DEFAULT_MAX_ROWS = 40;

export function rowsOf(spec: string | undefined): number {
  if (spec === undefined) return DEFAULT_MAX_ROWS;
  return countFlag("rows", spec);
}

export function rowsToRead(maxRows: number): number {
  return maxRows + 1;
}

export function capResult(result: QueryResult, maxRows: number): CappedResult {
  const { denominator, note, columns, rows } = result;
  const shown = rows.slice(0, maxRows);
  return {
    denominator,
    note,
    more: rows.length > shown.length ? `more rows than ${maxRows}; --rows <n> to widen` : null,
    columns,
    rows: recordsOf(columns, shown),
  };
}
