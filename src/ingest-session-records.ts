import type { SkillLoadRow } from "./ingest-skill-load";

export const ROLES = ["user", "assistant"] as const;

export type Role = (typeof ROLES)[number];

export type SessionFacts = {
  ts?: string;
  cwd?: string;
  project?: string;
  gitBranch?: string;
  cliVersion?: string;
  entrypoint?: string;
  title?: string;
};

export type MessageRow = {
  id: string;
  ts: string;
  role: Role;
  model?: string;
  turnId?: string;
  promptSource?: string;
  originKind?: string;
  isMeta: boolean;
  isSkillBody: boolean;
  attributionSkill?: string;
  slashCommand?: string;
  denialKind?: string;
  userFeedback?: string;
  text?: string;
  srcLine: number;
  extra?: string;
};

export type UsageRow = {
  responseId: string;
  ts: string;
  model?: string;
  inputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  attributionSkill?: string;
  messageId?: string;
};

export type TurnRow = {
  turnId: string;
  tsStart?: string;
  tsEnd?: string;
  durationMs?: number;
  messageCount?: number;
  status: string;
  model?: string;
  timeToFirstTokenMs?: number;
};

export type ToolCallRow = {
  id: string;
  messageId?: string;
  model?: string;
  attributionSkill?: string;
  tsCall?: string;
  tsResult?: string;
  toolName?: string;
  skillName?: string;
  filePath?: string;
  command?: string;
  isError?: boolean;
  isInterrupted?: boolean;
  exitCode?: number;
  durationMs?: number;
  resultBytes?: number;
  srcLineCall?: number;
  srcLineResult?: number;
};

export type ParsedChunk = {
  session: SessionFacts[];
  messages: MessageRow[];
  usage: UsageRow[];
  turns: TurnRow[];
  toolCalls: ToolCallRow[];
  skillLoads: SkillLoadRow[];
  dropped: number[];
  cursorState: string | null;
};

export type ChunkParser = (
  lines: readonly string[],
  firstLineNumber: number,
  state: string | null,
) => ParsedChunk;

const WORKTREE_MARKER = "/.claude/worktrees/";

export function projectOf(cwd: string | undefined): string | undefined {
  if (!cwd) return undefined;
  const at = cwd.indexOf(WORKTREE_MARKER);
  return at === -1 ? cwd : cwd.slice(0, at);
}
