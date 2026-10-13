import { basename, dirname, join } from "node:path";
import { z } from "zod";
import type { SourceFile } from "./ingest";
import type { Failure } from "./ingest-contract";
import { SessionId, sessionIdOf } from "./ingest-ids";
import { nonEmpty } from "./ingest-parse";
import { parseClaudeChunk } from "./ingest-parse-claude";
import { readSidecar } from "./ingest-source-read";

const SUBAGENTS_DIR = "subagents";

export const CLAUDE_SESSIONS = ["*/*.jsonl", `*/*/${SUBAGENTS_DIR}/*.jsonl`] as const;

function isSubagent(path: string): boolean {
  return basename(dirname(path)) === SUBAGENTS_DIR;
}

function metaPathOf(subagentPath: string): string {
  return join(dirname(subagentPath), `${basename(subagentPath, ".jsonl")}.meta.json`);
}

export function claudeSidecars(sessionPath: string): readonly string[] {
  return isSubagent(sessionPath) ? [metaPathOf(sessionPath)] : [];
}

export function listClaudeSessions(paths: readonly string[], fail: Failure): SourceFile[] {
  const transcripts = paths.filter((path) => !isSubagent(path));
  const subagents = paths.filter(isSubagent);
  return [...transcripts.flatMap(transcript), ...subagents.flatMap((path) => subagent(path, fail))];
}

function transcript(path: string): SourceFile[] {
  const sessionId = sessionIdOf(basename(path, ".jsonl"));
  if (sessionId === null) return [];
  return [{ path, kind: "transcript", sessionId, parentId: null, agentType: null, parse: parseClaudeChunk }];
}

const SubagentMeta = z.looseObject({ agentType: z.string().optional() });

function agentTypeOf(path: string, fail: Failure): string | null {
  return readSidecar(metaPathOf(path), SubagentMeta, fail)?.agentType || null;
}

function subagent(path: string, fail: Failure): SourceFile[] {
  const parentId = sessionIdOf(basename(dirname(dirname(path))));
  const agentId = nonEmpty(basename(path, ".jsonl").replace(/^agent-/, ""));
  if (parentId === null || agentId === null) return [];
  return [
    {
      path,
      kind: "subagent",
      sessionId: SessionId.parse(`${agentId}@${parentId}`),
      parentId,
      agentType: agentTypeOf(path, fail),
      parse: parseClaudeChunk,
    },
  ];
}
