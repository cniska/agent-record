import { countFlag } from "./query";
import type { CappedResult, QueryResult } from "./query-contract";

export const DEFAULT_MAX_ROWS = 40;

export function rowsOf(spec: string | undefined): number {
  if (spec === undefined) return DEFAULT_MAX_ROWS;
  return countFlag("rows", spec);
}

export function rowsToRead(maxRows: number): number {
  return maxRows + 1;
}

export function capResult(result: QueryResult, maxRows: number): CappedResult {
  const shown = result.rows.slice(0, maxRows);
  return {
    ...result,
    rows: shown,
    more: result.rows.length > shown.length ? `more rows than ${maxRows}; --rows <n> to widen` : null,
  };
}
