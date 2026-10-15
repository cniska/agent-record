import type { Chunk } from "./ingest-chunk";

export type Position = {
  readonly bytes: number;
  readonly lines: number;
  readonly state: string | null;
};

export type ReadCursor = Position & { readonly copyReplaced: boolean };

export type ReadCursorRow = Position & { readonly copyReplaced: number };

export function readCursorOf<Row extends ReadCursorRow>(
  row: Row,
): Omit<Row, "copyReplaced"> & { readonly copyReplaced: boolean } {
  return { ...row, copyReplaced: row.copyReplaced === 1 };
}

type ReadPlan = { readonly reset: boolean; readonly from: Position | null };

const START: Position = { bytes: 0, lines: 0, state: null };

export function planRead(cursor: ReadCursor | null, size: number): ReadPlan {
  const reset = cursor !== null && (cursor.copyReplaced || size < cursor.bytes);
  const at =
    cursor === null || reset ? START : { bytes: cursor.bytes, lines: cursor.lines, state: cursor.state };
  return { reset, from: size === at.bytes ? null : at };
}

export function advance(at: Position, chunk: Chunk, state: string | null): Position {
  return { bytes: at.bytes + chunk.bytes, lines: at.lines + chunk.lines.length, state };
}
