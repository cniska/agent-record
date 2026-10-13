import { constants, Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { basename } from "node:path";
import type { SourceFile } from "./ingest";
import { faultIngest } from "./ingest-contract";
import { SessionId, sessionIdOf } from "./ingest-ids";
import { CodexState, NO_CODEX_STATE, parseCodexChunk } from "./ingest-parse-codex";
import { parseJson, readingSource } from "./ingest-source-read";

const ROLLOUT_NAME = /^rollout-[0-9T:-]+-([0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12})$/;

export function threadIdOf(path: string): SessionId | null {
  const thread = ROLLOUT_NAME.exec(basename(path, ".jsonl"))?.[1];
  return thread === undefined ? null : SessionId.parse(thread);
}

function readState(thread: SessionId, raw: string | null): CodexState {
  if (!raw) return NO_CODEX_STATE;
  const read = parseJson(raw, CodexState);
  if (read.kind === "invalid")
    throw faultIngest("cursor_state_corrupt", { thread, state: raw, detail: read.detail });
  return read.value;
}

export const CODEX_SESSIONS = [
  "sessions/**/rollout-*.jsonl",
  "archived_sessions/**/rollout-*.jsonl",
] as const;

export const CODEX_TITLES = "state_5.sqlite";

export function listCodexRollouts(paths: readonly string[]): SourceFile[] {
  return paths.flatMap((path): SourceFile[] => {
    const threadId = threadIdOf(path);
    if (threadId === null) return [];
    return [
      {
        path,
        kind: "rollout",
        sessionId: threadId,
        parentId: null,
        agentType: null,
        parse: (lines, first, state) =>
          parseCodexChunk(lines, first, { id: threadId, state: readState(threadId, state) }),
      },
    ];
  });
}

function threadRows(statePath: string): { id: string; title: string | null }[] {
  const db = new Database(
    `file:${statePath}?immutable=1`,
    constants.SQLITE_OPEN_READONLY | constants.SQLITE_OPEN_URI,
  );
  try {
    return db.prepare<{ id: string; title: string | null }, []>("SELECT id, title FROM threads").all();
  } finally {
    db.close();
  }
}

export function readCodexTitles(statePath: string): Map<SessionId, string> {
  const titles = new Map<SessionId, string>();
  if (!existsSync(statePath)) return titles;
  for (const row of readingSource("titles_unreadable", statePath, () => threadRows(statePath))) {
    const thread = sessionIdOf(row.id);
    if (thread !== null && row.title) titles.set(thread, row.title);
  }
  return titles;
}
