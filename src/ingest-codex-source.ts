import { constants, Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import { Glob } from "bun";
import type { SourceFile } from "./ingest";
import { faultIngest } from "./ingest-contract";
import { CodexState, parseCodexChunk } from "./ingest-parse-codex";
import { parseJson, readingSource } from "./ingest-source-read";
import { codexDir, type Env } from "./paths";

const ROLLOUT_NAME = /^rollout-[0-9T:-]+-([0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12})$/;

export function threadIdOf(path: string): string | undefined {
  return ROLLOUT_NAME.exec(basename(path, ".jsonl"))?.[1];
}

function readState(thread: string, raw: string | null): CodexState {
  if (!raw) return {};
  const read = parseJson(raw, CodexState);
  if (read.kind === "invalid")
    throw faultIngest("cursor_state_corrupt", { thread, state: raw, detail: read.detail });
  return read.value;
}

export function listCodexRollouts(env: Env = process.env): SourceFile[] {
  const root = codexDir(env);
  const specs: SourceFile[] = [];
  for (const dir of [join(root, "sessions"), join(root, "archived_sessions")]) {
    if (!existsSync(dir)) continue;
    for (const path of new Glob("**/rollout-*.jsonl").scanSync({ cwd: dir, absolute: true })) {
      const threadId = threadIdOf(path);
      if (!threadId) continue;
      specs.push({
        path,
        kind: "rollout",
        sessionId: threadId,
        parse: (lines, first, state) => parseCodexChunk(lines, first, threadId, readState(threadId, state)),
      });
    }
  }
  return specs.sort((a, b) => a.path.localeCompare(b.path));
}

export function codexTitlesPath(env: Env = process.env): string {
  return join(codexDir(env), "state_5.sqlite");
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

export function readCodexTitles(statePath: string): Map<string, string> {
  const titles = new Map<string, string>();
  if (!existsSync(statePath)) return titles;
  for (const row of readingSource("titles_unreadable", statePath, () => threadRows(statePath))) {
    if (row.title) titles.set(row.id, row.title);
  }
  return titles;
}
