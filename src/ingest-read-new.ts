import { statSync } from "node:fs";
import { type Chunk, readChunk } from "./ingest-chunk";
import { type Position, planRead } from "./ingest-read-plan";
import { readingSource } from "./ingest-source-read";

export type ReadResult = { readonly read: boolean; readonly dropped: readonly number[] };

type NewLines =
  | { readonly reset: boolean; readonly from: Position; readonly chunk: Chunk }
  | { readonly reset: boolean; readonly from: null; readonly chunk: null };

export function readNewLines(path: string, cursor: Position | null): NewLines {
  const { size } = readingSource("source_unreadable", path, () => statSync(path));
  const { reset, from } = planRead(cursor, size);
  const chunk =
    from === null ? null : readingSource("source_unreadable", path, () => readChunk(path, size, from.bytes));
  if (from === null || chunk === null) return { reset, from: null, chunk: null };
  return { reset, from, chunk };
}
