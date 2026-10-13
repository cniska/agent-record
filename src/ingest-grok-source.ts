import { basename, dirname, join } from "node:path";
import { z } from "zod";
import type { SourceFile } from "./ingest";
import type { Failure } from "./ingest-contract";
import { SessionId, sessionIdOf } from "./ingest-ids";
import { nonEmpty } from "./ingest-parse";
import { parseGrokChunk } from "./ingest-parse-grok";
import { projectOf, type SessionFacts } from "./ingest-session-records";
import { readSidecar } from "./ingest-source-read";

const SummaryFile = z.looseObject({
  info: z.looseObject({ id: SessionId.optional(), cwd: z.string().optional() }).optional(),
  generated_title: z.string().nullish(),
  head_branch: z.string().nullish(),
  parent_session_id: SessionId.nullish(),
  agent_name: z.string().nullish(),
});
type SummaryFile = z.infer<typeof SummaryFile>;

export const GROK_SESSIONS = ["*/*/updates.jsonl"] as const;

function summaryPathOf(sessionPath: string): string {
  return join(dirname(sessionPath), "summary.json");
}

export function grokSidecars(sessionPath: string): readonly string[] {
  return [summaryPathOf(sessionPath)];
}

function summaryFacts(summary: SummaryFile | null): SessionFacts[] {
  if (!summary) return [];
  const cwd = nonEmpty(summary.info?.cwd);
  return [
    {
      ts: null,
      cwd,
      project: projectOf(cwd),
      gitBranch: nonEmpty(summary.head_branch),
      cliVersion: null,
      entrypoint: null,
      title: nonEmpty(summary.generated_title),
    },
  ];
}

export function listGrokSessions(paths: readonly string[], fail: Failure): SourceFile[] {
  const specs: SourceFile[] = [];
  for (const path of paths) {
    const summary = readSidecar(summaryPathOf(path), SummaryFile, fail);
    const sessionId = summary?.info?.id ?? sessionIdOf(basename(dirname(path)));
    if (sessionId === null) continue;
    const facts = summaryFacts(summary);
    specs.push({
      path,
      kind: "transcript",
      sessionId,
      parentId: summary?.parent_session_id ?? null,
      agentType: nonEmpty(summary?.agent_name),
      parse: (lines, first) => {
        const parsed = parseGrokChunk(lines, first);
        return { ...parsed, session: [...parsed.session, ...facts] };
      },
    });
  }
  return orderParents(specs);
}

function orderParents(specs: SourceFile[]): SourceFile[] {
  const ids = new Set(specs.map((spec) => spec.sessionId));
  const remaining = [...specs];
  const ordered: SourceFile[] = [];
  const placed = new Set<string>();
  while (remaining.length > 0) {
    const ready = remaining.filter(
      (spec) => spec.parentId === null || !ids.has(spec.parentId) || placed.has(spec.parentId),
    );
    if (ready.length === 0) return ordered.concat(remaining);
    for (const spec of ready) {
      placed.add(spec.sessionId);
      ordered.push(spec);
    }
    for (const spec of ready) remaining.splice(remaining.indexOf(spec), 1);
  }
  return ordered;
}
