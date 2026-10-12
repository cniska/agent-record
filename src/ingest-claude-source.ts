import { basename, dirname, join } from "node:path";
import { z } from "zod";
import type { SourceFile } from "./ingest";
import type { Failure } from "./ingest-contract";
import { parseClaudeChunk } from "./ingest-parse-claude";
import { readSidecar } from "./ingest-source-read";
import type { ListingIo } from "./ingest-sources";
import type { Env } from "./paths";
import { listInstalledSkills } from "./skill-installed";

const SUBAGENTS_DIR = "subagents";

export const CLAUDE_SESSIONS = ["*/*.jsonl", `*/*/${SUBAGENTS_DIR}/*.jsonl`] as const;

function parserFor(env: Env) {
  const known = listInstalledSkills(env);
  return (lines: string[], firstLineNumber: number) => parseClaudeChunk(lines, firstLineNumber, known);
}

function isSubagent(path: string): boolean {
  return basename(dirname(path)) === SUBAGENTS_DIR;
}

function metaPathOf(subagentPath: string): string {
  return join(dirname(subagentPath), `${basename(subagentPath, ".jsonl")}.meta.json`);
}

export function claudeSidecars(sessionPath: string): readonly string[] {
  return isSubagent(sessionPath) ? [metaPathOf(sessionPath)] : [];
}

export function listClaudeSessions(paths: readonly string[], { env, fail }: ListingIo): SourceFile[] {
  const parse = parserFor(env);
  const transcripts = paths.filter((path) => !isSubagent(path));
  const subagents = paths.filter(isSubagent);
  return [
    ...transcripts.map((path) => transcript(path, parse)),
    ...subagents.map((path) => subagent(path, parse, fail)),
  ];
}

function transcript(path: string, parse: SourceFile["parse"]): SourceFile {
  return { path, kind: "transcript", sessionId: basename(path, ".jsonl"), parse };
}

const SubagentMeta = z.looseObject({ agentType: z.string().optional() });

function agentTypeOf(path: string, fail: Failure): string | undefined {
  return readSidecar(metaPathOf(path), SubagentMeta, fail)?.agentType || undefined;
}

function subagent(path: string, parse: SourceFile["parse"], fail: Failure): SourceFile {
  const parentId = basename(dirname(dirname(path)));
  return {
    path,
    kind: "subagent",
    sessionId: `${basename(path, ".jsonl").replace(/^agent-/, "")}@${parentId}`,
    parentId,
    agentType: agentTypeOf(path, fail),
    parse,
  };
}
