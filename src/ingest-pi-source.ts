import { basename } from "node:path";
import type { SourceFile } from "./ingest";
import { sessionIdOf } from "./ingest-ids";
import { parsePiChunk } from "./ingest-parse-pi";

export const PI_SESSIONS = ["*/*.jsonl"] as const;

export function listPiSessions(paths: readonly string[]): SourceFile[] {
  return paths.flatMap((path): SourceFile[] => {
    const name = basename(path, ".jsonl");
    const sessionId = sessionIdOf(name.slice(name.indexOf("_") + 1));
    if (sessionId === null) return [];
    return [{ path, kind: "transcript", sessionId, parentId: null, agentType: null, parse: parsePiChunk }];
  });
}
