import { basename, dirname, join } from "node:path";
import { z } from "zod";
import type { SourceFile } from "./ingest";
import type { Failure } from "./ingest-contract";
import { agentIdOfFileName, sessionIdOf, subagentSessionId, ToolCallId } from "./ingest-ids";
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
  return paths.flatMap((path) => (isSubagent(path) ? subagent(path, fail) : transcript(path)));
}

function transcript(path: string): SourceFile[] {
  const sessionId = sessionIdOf(basename(path, ".jsonl"));
  if (sessionId === null) return [];
  return [
    {
      path,
      kind: "transcript",
      sessionId,
      parentId: null,
      agentType: null,
      spawnCall: null,
      parse: parseClaudeChunk,
    },
  ];
}

const SubagentMeta = z.looseObject({ agentType: z.string().optional(), toolUseId: ToolCallId.optional() });

function subagent(path: string, fail: Failure): SourceFile[] {
  const parentId = sessionIdOf(basename(dirname(dirname(path))));
  const name = basename(path, ".jsonl");
  const agentId = nonEmpty(agentIdOfFileName(name) ?? name);
  if (parentId === null || agentId === null) return [];
  const meta = readSidecar(metaPathOf(path), SubagentMeta, fail);
  return [
    {
      path,
      kind: "subagent",
      sessionId: subagentSessionId(agentId, parentId),
      parentId,
      agentType: meta?.agentType || null,
      spawnCall: meta?.toolUseId ?? null,
      parse: parseClaudeChunk,
    },
  ];
}
