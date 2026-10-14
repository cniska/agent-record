import { z } from "zod";
import { MessageId, ResponseId, ToolCallId, TurnId } from "./ingest-ids";
import { SkillLoadRow } from "./ingest-skill-load";
import { Timestamp } from "./timestamp";

export const ROLES = ["user", "assistant"] as const;

const nullableString = z.string().nullable();
const nullableNumber = z.number().nullable();
const nullableTime = Timestamp.nullable();

export const SessionFacts = z
  .strictObject({
    ts: nullableTime,
    cwd: nullableString,
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
  gitBranch: null,
  cliVersion: null,
  entrypoint: null,
  title: null,
};

export const MessageRow = z
  .strictObject({
    id: MessageId,
    ts: Timestamp,
    role: z.enum(ROLES),
    model: nullableString,
    turnId: TurnId.nullable(),
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

export function plainMessage({
  id,
  ts,
  role,
  model,
  text,
  srcLine,
}: Pick<MessageRow, "id" | "ts" | "role" | "model" | "text" | "srcLine">): MessageRow {
  return {
    id,
    ts,
    role,
    model,
    text,
    srcLine,
    turnId: null,
    promptSource: null,
    originKind: null,
    isMeta: false,
    isSkillBody: false,
    attributionSkill: null,
    slashCommand: null,
    denialKind: null,
    userFeedback: null,
    extra: null,
  };
}

export const UsageRow = z
  .strictObject({
    responseId: ResponseId,
    ts: Timestamp,
    model: nullableString,
    inputTokens: z.number(),
    cacheReadTokens: z.number(),
    cacheWriteTokens: z.number(),
    outputTokens: z.number(),
    attributionSkill: nullableString,
    messageId: MessageId.nullable(),
  })
  .readonly();
export type UsageRow = z.infer<typeof UsageRow>;

export const TurnRow = z
  .strictObject({
    turnId: TurnId,
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

export const CompactionRow = z.strictObject({ ts: Timestamp, srcLine: z.number() }).readonly();
export type CompactionRow = z.infer<typeof CompactionRow>;

const ToolCall = z
  .strictObject({
    kind: z.literal("call"),
    id: ToolCallId,
    ts: Timestamp,
    messageId: MessageId.nullable(),
    toolName: nullableString,
    skillName: nullableString,
    filePath: nullableString,
    command: nullableString,
    model: nullableString,
    attributionSkill: nullableString,
    srcLine: z.number(),
  })
  .readonly();

const ToolCallDetail = z
  .strictObject({
    kind: z.literal("detail"),
    id: ToolCallId,
    toolName: nullableString,
    filePath: nullableString,
    command: nullableString,
  })
  .readonly();

const ToolResult = z
  .strictObject({
    kind: z.literal("result"),
    id: ToolCallId,
    ts: Timestamp,
    toolName: nullableString,
    isError: z.boolean().nullable(),
    isInterrupted: z.boolean().nullable(),
    exitCode: nullableNumber,
    durationMs: nullableNumber,
    resultBytes: nullableNumber,
    srcLine: z.number(),
  })
  .readonly();

export const ToolCallRow = z.discriminatedUnion("kind", [ToolCall, ToolCallDetail, ToolResult]);
export type ToolCallRow = z.infer<typeof ToolCallRow>;

export const ParsedChunk = z
  .strictObject({
    session: z.array(SessionFacts).readonly(),
    messages: z.array(MessageRow).readonly(),
    usage: z.array(UsageRow).readonly(),
    turns: z.array(TurnRow).readonly(),
    compactions: z.array(CompactionRow).readonly(),
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
