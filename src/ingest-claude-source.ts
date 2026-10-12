import { existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { Glob } from "bun";
import { z } from "zod";
import type { SourceFile } from "./ingest";
import type { Failure } from "./ingest-contract";
import { parseClaudeChunk } from "./ingest-parse-claude";
import { readSidecar } from "./ingest-source-read";
import { claudeProjectsDir, type Env } from "./paths";
import { listInstalledSkills } from "./skill-installed";

function parserFor(env: Env) {
  const known = listInstalledSkills(env);
  return (lines: string[], firstLineNumber: number) => parseClaudeChunk(lines, firstLineNumber, known);
}

export function listClaudeSessions(env: Env, fail: Failure): SourceFile[] {
  const root = claudeProjectsDir(env);
  if (!existsSync(root)) return [];
  const parse = parserFor(env);
  return [...transcripts(root, parse), ...subagents(root, parse, fail)];
}

function transcripts(root: string, parse: SourceFile["parse"]): SourceFile[] {
  return scan(root, "*/*.jsonl").map((path) => ({
    path,
    kind: "transcript",
    sessionId: basename(path, ".jsonl"),
    parse,
  }));
}

function scan(root: string, pattern: string): string[] {
  return [...new Glob(pattern).scanSync({ cwd: root, absolute: true })].sort((a, b) => a.localeCompare(b));
}

const SubagentMeta = z.looseObject({ agentType: z.string().optional() });

function agentTypeOf(path: string, fail: Failure): string | undefined {
  const meta = readSidecar(join(dirname(path), `${basename(path, ".jsonl")}.meta.json`), SubagentMeta, fail);
  return meta?.agentType || undefined;
}

function subagents(root: string, parse: SourceFile["parse"], fail: Failure): SourceFile[] {
  return scan(root, "*/*/subagents/*.jsonl").map((path) => {
    const parentId = basename(dirname(dirname(path)));
    return {
      path,
      kind: "subagent",
      sessionId: `${basename(path, ".jsonl").replace(/^agent-/, "")}@${parentId}`,
      parentId,
      agentType: agentTypeOf(path, fail),
      parse,
    };
  });
}
