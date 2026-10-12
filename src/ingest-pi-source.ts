import { basename } from "node:path";
import type { SourceFile } from "./ingest";
import { parsePiChunk } from "./ingest-parse-pi";

export const PI_SESSIONS = ["*/*.jsonl"] as const;

export function listPiSessions(paths: readonly string[]): SourceFile[] {
  return paths.map((path) => ({
    path,
    kind: "transcript",
    sessionId: basename(path, ".jsonl").slice(basename(path).indexOf("_") + 1),
    parse: (lines, first) => parsePiChunk(lines, first),
  }));
}
