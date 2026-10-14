import { z } from "zod";
import { unreachable } from "./assert";
import { MessageId, ResponseId, ToolCallId, TurnId } from "./ingest-ids";
import {
  byKind,
  jsonOrNull,
  lineOf,
  nonEmpty,
  TextPart,
  textAt,
  typeOf,
  UnkeptLine,
  UnkeptPart,
} from "./ingest-parse";
import {
  type CompactionRow,
  type MessageRow,
  NO_FACTS,
  type ParsedChunk,
  type SessionFacts,
  type ToolCallRow,
  type TurnRow,
  type UsageRow,
} from "./ingest-session-records";
import { bareSkillName, type SkillLoadRow, skillBodyOf, skillFromCommand } from "./ingest-skill-load";
import { Timestamp, timestampMinus } from "./timestamp";

const ClaudeToolUse = z
  .looseObject({
    type: z.literal("tool_use"),
    id: ToolCallId,
    name: z.string().min(1),
    input: z.record(z.string(), z.unknown()).nullish(),
  })
  .transform((block) => ({
    kind: "tool_use" as const,
    id: block.id,
    name: block.name,
    input: block.input ?? {},
  }));

const ClaudeToolResult = z
  .looseObject({
    type: z.literal("tool_result"),
    tool_use_id: ToolCallId,
    is_error: z.boolean().optional(),
    content: z.unknown().optional(),
  })
  .transform((block) => ({
    kind: "tool_result" as const,
    id: block.tool_use_id,
    isError: block.is_error === true,
    content: block.content,
  }));

const ClaudeAssistantBlock = byKind(typeOf, { text: TextPart, tool_use: ClaudeToolUse }, UnkeptPart);

const ClaudeUserBlock = byKind(typeOf, { text: TextPart, tool_result: ClaudeToolResult }, UnkeptPart);

const ClaudeToolUseResult = z.object({
  stdout: z.string().optional(),
  stderr: z.string().optional(),
  interrupted: z.boolean().optional(),
});
type ClaudeToolUseResult = z.infer<typeof ClaudeToolUseResult>;

const ClaudeUsage = z.object({
  input_tokens: z.number().optional(),
  output_tokens: z.number().optional(),
  cache_read_input_tokens: z.number().optional(),
  cache_creation_input_tokens: z.number().optional(),
});

const CLAUDE_CONVERSED = {
  timestamp: Timestamp,
  cwd: z.string().optional(),
  gitBranch: z.string().optional(),
  version: z.string().optional(),
  entrypoint: z.string().optional(),
  isSidechain: z.boolean().optional(),
  session_id: z.string().optional(),
  agentId: z.string().optional(),
};

function conversed(line: z.output<z.ZodObject<typeof CLAUDE_CONVERSED>>) {
  return {
    ts: line.timestamp,
    cwd: line.cwd,
    gitBranch: line.gitBranch,
    version: line.version,
    entrypoint: line.entrypoint,
    isSidechain: line.isSidechain,
    session_id: line.session_id,
    agentId: line.agentId,
  };
}

const ClaudeAssistantLine = z
  .looseObject({
    ...CLAUDE_CONVERSED,
    uuid: z.string().optional(),
    attributionSkill: z.string().nullish(),
    requestId: z.string().optional(),
    effort: z.string().optional(),
    message: z.object({
      id: MessageId,
      model: z.string().optional(),
      content: z.union([z.string(), z.array(ClaudeAssistantBlock.nullable())]).optional(),
      usage: ClaudeUsage.nullish(),
    }),
  })
  .transform((line) => ({
    kind: "assistant" as const,
    ...conversed(line),
    uuid: line.uuid,
    attributionSkill: line.attributionSkill,
    requestId: line.requestId,
    effort: line.effort,
    message: {
      id: line.message.id,
      model: line.message.model,
      content: line.message.content,
      usage: line.message.usage,
    },
  }));

const ClaudeUserLine = z
  .looseObject({
    ...CLAUDE_CONVERSED,
    uuid: MessageId,
    isMeta: z.boolean().nullish(),
    promptSource: z.string().optional(),
    promptId: TurnId.optional(),
    permissionMode: z.string().optional(),
    origin: z.object({ kind: z.string().optional() }).optional(),
    parentUuid: MessageId.nullish(),
    sourceToolUseID: ToolCallId.nullish(),
    interruptedMessageId: z.string().nullish(),
    toolDenialKind: z.string().nullish(),
    userFeedback: z.unknown().optional(),
    toolUseResult: z
      .union([
        ClaudeToolUseResult,
        z.string().transform(() => undefined),
        z.array(z.unknown()).transform(() => undefined),
      ])
      .optional(),
    message: z
      .object({ content: z.union([z.string(), z.array(ClaudeUserBlock.nullable())]).optional() })
      .optional(),
  })
  .transform((line) => ({
    kind: "user" as const,
    ...conversed(line),
    uuid: line.uuid,
    isMeta: line.isMeta,
    promptSource: line.promptSource,
    promptId: line.promptId,
    permissionMode: line.permissionMode,
    originKind: line.origin?.kind,
    parentUuid: line.parentUuid,
    sourceToolUseID: line.sourceToolUseID,
    interruptedMessageId: line.interruptedMessageId,
    toolDenialKind: line.toolDenialKind,
    userFeedback: line.userFeedback,
    toolUseResult: line.toolUseResult,
    content: line.message?.content,
  }));

const ClaudeAiTitleLine = z
  .looseObject({ timestamp: Timestamp.optional(), aiTitle: z.string().min(1) })
  .transform((line) => ({ kind: "title" as const, ts: line.timestamp ?? null, title: line.aiTitle }));

const ClaudeCustomTitleLine = z
  .looseObject({ timestamp: Timestamp.optional(), customTitle: z.string().min(1) })
  .transform((line) => ({ kind: "title" as const, ts: line.timestamp ?? null, title: line.customTitle }));

const ClaudeTurnLine = z
  .looseObject({
    timestamp: Timestamp,
    uuid: TurnId,
    durationMs: z.number().optional(),
    messageCount: z.number().optional(),
  })
  .transform((line) => ({
    kind: "turn" as const,
    ts: line.timestamp,
    uuid: line.uuid,
    durationMs: line.durationMs,
    messageCount: line.messageCount,
  }));

const ClaudeCompactLine = z
  .looseObject({ timestamp: Timestamp })
  .transform((line) => ({ kind: "compaction" as const, ts: line.timestamp }));

function claudeKind(value: unknown): string {
  const type = typeOf(value);
  return type === "system" ? `system/${textAt(value, "subtype")}` : type;
}

const ClaudeLine = byKind(
  claudeKind,
  {
    "ai-title": ClaudeAiTitleLine,
    "custom-title": ClaudeCustomTitleLine,
    "system/turn_duration": ClaudeTurnLine,
    "system/compact_boundary": ClaudeCompactLine,
    assistant: ClaudeAssistantLine,
    user: ClaudeUserLine,
  },
  UnkeptLine,
);

type ClaudeBlock = z.infer<typeof ClaudeAssistantBlock> | z.infer<typeof ClaudeUserBlock>;

const HANDBACK_TOOL = "SubagentHandback";

function messageTexts(content: readonly (ClaudeBlock | null)[]): readonly string[] {
  return content.flatMap((b) => {
    if (b?.kind === "text" && b.text !== null) return [b.text];
    if (b?.kind === "tool_use" && b.name === HANDBACK_TOOL && typeof b.input.message === "string")
      return [b.input.message];
    return [];
  });
}

function textsOf(content: string | readonly (ClaudeBlock | null)[] | undefined): readonly string[] {
  if (typeof content === "string") return [content];
  return Array.isArray(content) ? messageTexts(content) : [];
}

function visibleText(texts: readonly string[]): string | null {
  return nonEmpty(texts.join("\n"));
}

const FAILED_COMMAND_HEAD = /^Exit code (\d+)(?:\n|$)/;

function resultTexts(content: unknown): string[] {
  if (typeof content === "string") return [content];
  if (!Array.isArray(content)) return [];
  return content.flatMap((b) => (typeof b?.text === "string" ? [b.text] : []));
}

function exitCodeOf(content: unknown): number | null {
  const code = resultTexts(content)[0]?.match(FAILED_COMMAND_HEAD)?.[1];
  return code === undefined ? null : Number(code);
}

function resultSize(content: unknown, result: ClaudeToolUseResult | undefined): number | null {
  const parts = resultTexts(content);
  if (typeof result?.stdout === "string") parts.push(result.stdout);
  if (typeof result?.stderr === "string") parts.push(result.stderr);
  return parts.length > 0 ? parts.reduce((n, p) => n + p.length, 0) : null;
}

function sessionFactsOf(line: {
  readonly cwd?: string;
  readonly gitBranch?: string;
  readonly version?: string;
  readonly entrypoint?: string;
}): SessionFacts {
  return {
    ...NO_FACTS,
    cwd: line.cwd ?? null,
    gitBranch: nonEmpty(line.gitBranch),
    cliVersion: nonEmpty(line.version),
    entrypoint: nonEmpty(line.entrypoint),
  };
}

function feedbackText(value: unknown): string | null {
  if (value == null) return null;
  return typeof value === "string" ? value : JSON.stringify(value);
}

export function parseClaudeChunk(lines: readonly string[], firstLineNumber: number): ParsedChunk {
  const session: SessionFacts[] = [];
  const messages: MessageRow[] = [];
  const usage: UsageRow[] = [];
  const turns: TurnRow[] = [];
  const compactions: CompactionRow[] = [];
  const toolCalls: ToolCallRow[] = [];
  const skillLoads: SkillLoadRow[] = [];
  const dropped: number[] = [];

  for (const [index, raw] of lines.entries()) {
    if (raw.length === 0) continue;
    const srcLine = firstLineNumber + index;
    const line = lineOf(raw, ClaudeLine);
    if (!line) {
      dropped.push(srcLine);
      continue;
    }
    if (line.ts) session.push({ ...NO_FACTS, ts: line.ts });

    switch (line.kind) {
      case "title":
        session.push({ ...NO_FACTS, title: line.title });
        break;

      case "turn":
        turns.push({
          turnId: line.uuid,
          tsStart: line.durationMs === undefined ? null : timestampMinus(line.ts, line.durationMs),
          tsEnd: line.ts,
          durationMs: line.durationMs ?? null,
          messageCount: line.messageCount ?? null,
          status: "completed",
          model: null,
          timeToFirstTokenMs: null,
        });
        break;

      case "compaction":
        compactions.push({ ts: line.ts, srcLine });
        break;

      case "assistant": {
        const { ts, message } = line;
        const model = nonEmpty(message.model);
        const attributionSkill = nonEmpty(line.attributionSkill);
        session.push(sessionFactsOf(line));
        messages.push({
          id: message.id,
          ts,
          role: "assistant",
          model,
          turnId: null,
          promptSource: null,
          originKind: null,
          isMeta: false,
          isSkillBody: false,
          attributionSkill,
          slashCommand: null,
          denialKind: null,
          userFeedback: null,
          text: visibleText(textsOf(message.content)),
          srcLine,
          extra: jsonOrNull({
            requestId: line.requestId,
            effort: line.effort,
            isSidechain: line.isSidechain,
            agentId: line.agentId,
            uuid: line.uuid,
            session_id: line.session_id,
          }),
        });
        if (Array.isArray(message.content)) {
          for (const block of message.content) {
            if (block?.kind !== "tool_use") continue;
            const { input } = block;
            const chosen = input.skill;
            if (block.name === "Skill" && typeof chosen === "string") {
              skillLoads.push({
                kind: "called",
                toolCallId: block.id,
                ts,
                model,
                skillName: bareSkillName(chosen),
                how: "model",
              });
            }
            toolCalls.push({
              kind: "call",
              id: block.id,
              ts,
              messageId: message.id,
              toolName: block.name,
              skillName: typeof input.skill === "string" ? input.skill : null,
              filePath: typeof input.file_path === "string" ? input.file_path : null,
              command: typeof input.command === "string" ? input.command : null,
              model,
              attributionSkill,
              srcLine,
            });
          }
        }
        const u = message.usage;
        if (u) {
          usage.push({
            responseId: ResponseId.parse(message.id),
            messageId: message.id,
            ts,
            model,
            inputTokens: u.input_tokens ?? 0,
            cacheReadTokens: u.cache_read_input_tokens ?? 0,
            cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
            outputTokens: u.output_tokens ?? 0,
            attributionSkill,
          });
        }
        break;
      }

      case "user": {
        const { ts } = line;
        const { content } = line;
        const texts = textsOf(content);
        const text = visibleText(texts);
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block?.kind !== "tool_result") continue;
            const r = line.toolUseResult;
            toolCalls.push({
              kind: "result",
              id: block.id,
              ts,
              toolName: null,
              isError: block.isError,
              isInterrupted: r?.interrupted === true,
              exitCode: block.isError ? exitCodeOf(block.content) : null,
              durationMs: null,
              resultBytes: resultSize(block.content, r),
              srcLine,
            });
          }
        }
        session.push(sessionFactsOf(line));
        const skillBody = line.isMeta === true ? skillBodyOf(texts) : null;
        if (skillBody) {
          const { kind, name, ...fields } = skillBody;
          if (kind === "preload")
            skillLoads.push({ kind: "preload", messageId: line.uuid, ts, skillName: name, ...fields });
          else if (line.sourceToolUseID)
            skillLoads.push({ kind: "called-body", toolCallId: line.sourceToolUseID, ...fields });
          else if (line.parentUuid)
            skillLoads.push({ kind: "typed-body", parentUuid: line.parentUuid, skillName: name, ...fields });
        }
        messages.push({
          id: line.uuid,
          ts,
          role: "user",
          model: null,
          turnId: line.promptId ?? null,
          promptSource: nonEmpty(line.promptSource),
          originKind: nonEmpty(line.originKind),
          isMeta: line.isMeta === true,
          isSkillBody: skillBody !== null,
          attributionSkill: null,
          slashCommand: text && skillBody === null ? skillFromCommand(text) : null,
          denialKind: nonEmpty(line.toolDenialKind),
          userFeedback: feedbackText(line.userFeedback),
          text: skillBody ? null : text,
          srcLine,
          extra: jsonOrNull({
            isSidechain: line.isSidechain,
            agentId: line.agentId,
            permissionMode: line.permissionMode,
            sourceToolUseID: line.sourceToolUseID,
            parentUuid: line.parentUuid,
            session_id: line.session_id,
            interruptedMessageId: nonEmpty(line.interruptedMessageId),
          }),
        });
        break;
      }

      case "unkept":
        break;

      default:
        unreachable(line);
    }
  }

  return { session, messages, usage, turns, compactions, toolCalls, skillLoads, dropped, cursorState: null };
}
