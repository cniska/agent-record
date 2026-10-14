import { readAt } from "./ingest-read-at";

export type Chunk = { readonly lines: readonly string[]; readonly bytes: number };

export function readChunk(path: string, size: number, from: number): Chunk | null {
  const buf = readAt(path, from, size - from);
  const lastNewline = buf.lastIndexOf(0x0a);
  if (lastNewline === -1) return null;
  const lines = buf
    .subarray(0, lastNewline + 1)
    .toString("utf8")
    .split("\n");
  lines.pop();
  return { lines, bytes: lastNewline + 1 };
}
