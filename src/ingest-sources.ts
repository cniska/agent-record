import type { SourceFile } from "./ingest";
import { CLAUDE_SESSIONS, claudeSidecars, listClaudeSessions } from "./ingest-claude-source";
import {
  CODEX_SESSIONS,
  CODEX_TITLES,
  listCodexRollouts,
  readCodexTitles,
  threadIdOf,
} from "./ingest-codex-source";
import type { Failure } from "./ingest-contract";
import { GROK_SESSIONS, grokSidecars, listGrokSessions } from "./ingest-grok-source";
import { listPiSessions, PI_SESSIONS } from "./ingest-pi-source";
import { scan } from "./ingest-scan";
import type { Tool } from "./ingest-tools";
import {
  claudeProjectsDir,
  codexDir,
  type Env,
  grokSessionsDir,
  ompSessionsDir,
  piSessionsDir,
} from "./paths";

export type SessionSource = {
  readonly root: (env: Env) => string;
  readonly sessions: readonly string[];
  readonly sidecars?: (sessionPath: string) => readonly string[];
  readonly movedKey?: (sessionPath: string) => string | undefined;
  readonly titles?: { readonly file: string; readonly read: (path: string) => ReadonlyMap<string, string> };
  readonly list: (paths: readonly string[], fail: Failure) => SourceFile[];
};

export const SESSION_SOURCES: Readonly<Record<Tool, SessionSource>> = {
  claude: {
    root: claudeProjectsDir,
    sessions: CLAUDE_SESSIONS,
    sidecars: claudeSidecars,
    list: listClaudeSessions,
  },
  codex: {
    root: codexDir,
    sessions: CODEX_SESSIONS,
    movedKey: threadIdOf,
    titles: { file: CODEX_TITLES, read: readCodexTitles },
    list: listCodexRollouts,
  },
  grok: {
    root: grokSessionsDir,
    sessions: GROK_SESSIONS,
    sidecars: grokSidecars,
    list: listGrokSessions,
  },
  pi: { root: piSessionsDir, sessions: PI_SESSIONS, list: listPiSessions },
  omp: { root: ompSessionsDir, sessions: PI_SESSIONS, list: listPiSessions },
};

export function listSource(source: SessionSource, root: string, fail: Failure): SourceFile[] {
  return source.list(scan(root, source.sessions), fail);
}
