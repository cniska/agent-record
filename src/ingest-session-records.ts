import { z } from "zod";
import { SkillLoadRow } from "./ingest-skill-load";
import { Timestamp } from "./timestamp";

export const ROLES = ["user", "assistant"] as const;

export type Role = (typeof ROLES)[number];

const nullableString = z.string().nullable();
const nullableNumber = z.number().nullable();
const nullableTime = Timestamp.nullable();

export const SessionFacts = z
  .strictObject({
    ts: nullableTime,
    cwd: nullableString,
    project: nullableString,
    gitBranch: nullableString,
    cliVersion: nullableString,
    entrypoint: nullableString,
    title: nullableString,
  })
  .readonly();
export type SessionFacts = z.infer<typeof SessionFacts>;

export const NO_FACTS: SessionFacts = {
  ts: null,
  cwd: null,
  project: null,
  gitBranch: null,
  cliVersion: null,
  entrypoint: null,
  title: null,
};

export const MessageRow = z
  .strictObject({
    id: z.string(),
    ts: Timestamp,
    role: z.enum(ROLES),
    model: nullableString,
    turnId: nullableString,
    promptSource: nullableString,
    originKind: nullableString,
    isMeta: z.boolean(),
    isSkillBody: z.boolean(),
    attributionSkill: nullableString,
    slashCommand: nullableString,
    denialKind: nullableString,
    userFeedback: nullableString,
    text: nullableString,
    srcLine: z.number(),
    extra: nullableString,
  })
  .readonly();
export type MessageRow = z.infer<typeof MessageRow>;

export const UsageRow = z
  .strictObject({
    responseId: z.string(),
    ts: Timestamp,
    model: nullableString,
    inputTokens: z.number(),
    cacheReadTokens: z.number(),
    cacheWriteTokens: z.number(),
    outputTokens: z.number(),
    attributionSkill: nullableString,
    messageId: nullableString,
  })
  .readonly();
export type UsageRow = z.infer<typeof UsageRow>;

export const TurnRow = z
  .strictObject({
    turnId: z.string(),
    tsStart: nullableTime,
    tsEnd: nullableTime,
    durationMs: nullableNumber,
    messageCount: nullableNumber,
    status: z.string(),
    model: nullableString,
    timeToFirstTokenMs: nullableNumber,
  })
  .readonly();
export type TurnRow = z.infer<typeof TurnRow>;

export const ToolCallRow = z
  .strictObject({
    id: z.string(),
    messageId: nullableString,
    model: nullableString,
    attributionSkill: nullableString,
    tsCall: nullableTime,
    tsResult: nullableTime,
    toolName: nullableString,
    skillName: nullableString,
    filePath: nullableString,
    command: nullableString,
    isError: z.boolean().nullable(),
    isInterrupted: z.boolean().nullable(),
    exitCode: nullableNumber,
    durationMs: nullableNumber,
    resultBytes: nullableNumber,
    srcLineCall: nullableNumber,
    srcLineResult: nullableNumber,
  })
  .readonly();
export type ToolCallRow = z.infer<typeof ToolCallRow>;

export const NO_TOOL_CALL: Omit<ToolCallRow, "id"> = {
  messageId: null,
  model: null,
  attributionSkill: null,
  tsCall: null,
  tsResult: null,
  toolName: null,
  skillName: null,
  filePath: null,
  command: null,
  isError: null,
  isInterrupted: null,
  exitCode: null,
  durationMs: null,
  resultBytes: null,
  srcLineCall: null,
  srcLineResult: null,
};

export const ParsedChunk = z
  .strictObject({
    session: z.array(SessionFacts).readonly(),
    messages: z.array(MessageRow).readonly(),
    usage: z.array(UsageRow).readonly(),
    turns: z.array(TurnRow).readonly(),
    toolCalls: z.array(ToolCallRow).readonly(),
    skillLoads: z.array(SkillLoadRow).readonly(),
    dropped: z.array(z.number()).readonly(),
    cursorState: nullableString,
  })
  .readonly();
export type ParsedChunk = z.infer<typeof ParsedChunk>;

export type ChunkParser = (
  lines: readonly string[],
  firstLineNumber: number,
  state: string | null,
) => ParsedChunk;

const WORKTREE_MARKER = "/.claude/worktrees/";

export function projectOf(cwd: string | null): string | null {
  if (!cwd) return null;
  const at = cwd.indexOf(WORKTREE_MARKER);
  return at === -1 ? cwd : cwd.slice(0, at);
}
