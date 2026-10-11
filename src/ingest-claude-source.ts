import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { Glob } from "bun";
import { z } from "zod";
import type { SourceFile } from "./ingest";
import { parseClaudeChunk } from "./ingest-parse-claude";
import { claudeProjectsDir, type Env } from "./paths";
import { listInstalledSkills } from "./skill-installed";

function parserFor(env: Env) {
  const known = listInstalledSkills(env);
  return (lines: string[], firstLineNumber: number) => parseClaudeChunk(lines, firstLineNumber, known);
}

export function listClaudeSessions(env: Env = process.env): SourceFile[] {
  const root = claudeProjectsDir(env);
  if (!existsSync(root)) return [];
  const parse = parserFor(env);
  return [...transcripts(root, parse), ...subagents(root, parse)];
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

function agentTypeOf(path: string): string | undefined {
  const meta = join(dirname(path), `${basename(path, ".jsonl")}.meta.json`);
  if (!existsSync(meta)) return undefined;
  try {
    const parsed = SubagentMeta.safeParse(JSON.parse(readFileSync(meta, "utf8")));
    return parsed.success ? parsed.data.agentType || undefined : undefined;
  } catch {
    return undefined;
  }
}

function subagents(root: string, parse: SourceFile["parse"]): SourceFile[] {
  return scan(root, "*/*/subagents/*.jsonl").map((path) => {
    const parentId = basename(dirname(dirname(path)));
    return {
      path,
      kind: "subagent",
      sessionId: `${basename(path, ".jsonl").replace(/^agent-/, "")}@${parentId}`,
      parentId,
      agentType: agentTypeOf(path),
      parse,
    };
  });
}
