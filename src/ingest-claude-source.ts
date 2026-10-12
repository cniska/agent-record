import { basename, dirname, join } from "node:path";
import { z } from "zod";
import type { SourceFile } from "./ingest";
import type { Failure } from "./ingest-contract";
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
  return [...transcripts.map(transcript), ...subagents.map((path) => subagent(path, fail))];
}

function transcript(path: string): SourceFile {
  return { path, kind: "transcript", sessionId: basename(path, ".jsonl"), parse: parseClaudeChunk };
}

const SubagentMeta = z.looseObject({ agentType: z.string().optional() });

function agentTypeOf(path: string, fail: Failure): string | undefined {
  return readSidecar(metaPathOf(path), SubagentMeta, fail)?.agentType || undefined;
}

function subagent(path: string, fail: Failure): SourceFile {
  const parentId = basename(dirname(dirname(path)));
  return {
    path,
    kind: "subagent",
    sessionId: `${basename(path, ".jsonl").replace(/^agent-/, "")}@${parentId}`,
    parentId,
    agentType: agentTypeOf(path, fail),
    parse: parseClaudeChunk,
  };
}
