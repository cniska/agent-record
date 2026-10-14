import { basename, dirname, join } from "node:path";
import { z } from "zod";
import type { SourceFile } from "./ingest";
import type { Failure } from "./ingest-contract";
import { SessionId, sessionIdOf, TopLevelSessionId } from "./ingest-ids";
import { nonEmpty } from "./ingest-parse";
import { parseGrokChunk } from "./ingest-parse-grok";
import type { SessionFacts } from "./ingest-session-records";
import { readSidecar } from "./ingest-source-read";

const SummaryFile = z.looseObject({
  info: z.looseObject({ id: TopLevelSessionId.optional(), cwd: z.string().optional() }).optional(),
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
  return [
    {
      ts: null,
      cwd: nonEmpty(summary.info?.cwd),
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
      spawnCall: null,
      parse: (lines, first) => {
        const parsed = parseGrokChunk(lines, first);
        return { ...parsed, session: [...parsed.session, ...facts] };
      },
    });
  }
  return specs;
}
