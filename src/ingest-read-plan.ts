import { z } from "zod";
import { SqlFlag } from "./db";
import type { Chunk } from "./ingest-chunk";

export type Position = {
  readonly bytes: number;
  readonly lines: number;
  readonly state: string | null;
};

export const ReadCursorRow = z.strictObject({
  bytes: z.number(),
  lines: z.number(),
  state: z.string().nullable(),
  copyReplaced: SqlFlag,
});

export type ReadCursor = Readonly<z.infer<typeof ReadCursorRow>>;

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
