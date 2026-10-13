import { z } from "zod";
import { MessageId, ResponseId, ToolCallId, TurnId } from "./ingest-ids";
import { jsonOrNull, lineOf, nonEmpty } from "./ingest-parse";
import {
  type MessageRow,
  NO_FACTS,
  NO_TOOL_CALL,
  type ParsedChunk,
  type SessionFacts,
  type ToolCallRow,
  type TurnRow,
  type UsageRow,
} from "./ingest-session-records";

import { parseSkillBody, type SkillLoadRow, skillFromCommand } from "./ingest-skill-load";
import { Timestamp, timestampMinus } from "./timestamp";

const SKILL_BODY_PREFIX = "Base directory for this skill:";

const ContentBlock = z.looseObject({
  type: z.string().optional(),
  text: z.string().optional(),
  id: ToolCallId.optional(),
  name: z.string().optional(),
  input: z.record(z.string(), z.unknown()).nullish(),
  tool_use_id: ToolCallId.optional(),
  is_error: z.boolean().optional(),
  content: z.unknown().optional(),
});
type ContentBlock = z.infer<typeof ContentBlock>;

const ClaudeToolUseResult = z.looseObject({
  stdout: z.string().optional(),
  stderr: z.string().optional(),
  interrupted: z.boolean().optional(),
});
type ClaudeToolUseResult = z.infer<typeof ClaudeToolUseResult>;

const ClaudeUsage = z.looseObject({
  input_tokens: z.number().optional(),
  output_tokens: z.number().optional(),
  cache_read_input_tokens: z.number().optional(),
  cache_creation_input_tokens: z.number().optional(),
});

const ClaudeLine = z.looseObject({
  type: z.string().optional(),
  uuid: MessageId.optional(),
  timestamp: Timestamp.optional(),
  cwd: z.string().optional(),
  gitBranch: z.string().optional(),
  version: z.string().optional(),
  entrypoint: z.string().optional(),
  isSidechain: z.boolean().optional(),
  isMeta: z.boolean().nullish(),
  session_id: z.string().optional(),
  promptSource: z.string().optional(),
  promptId: TurnId.optional(),
  permissionMode: z.string().optional(),
  origin: z.looseObject({ kind: z.string().optional() }).optional(),
  attributionSkill: z.string().nullish(),
  requestId: z.string().optional(),
  effort: z.string().optional(),
  agentId: z.string().optional(),
  parentUuid: MessageId.nullish(),
  sourceToolUseID: ToolCallId.nullish(),
  interruptedMessageId: z.string().nullish(),
  toolDenialKind: z.string().nullish(),
  userFeedback: z.unknown().optional(),
  aiTitle: z.string().optional(),
  customTitle: z.string().optional(),
  subtype: z.string().optional(),
  durationMs: z.number().optional(),
  messageCount: z.number().optional(),
  toolUseResult: z
    .union([
      ClaudeToolUseResult,
      z.string().transform(() => undefined),
      z.array(z.unknown()).transform(() => undefined),
    ])
    .optional(),
  message: z
    .looseObject({
      id: MessageId.optional(),
      model: z.string().optional(),
      content: z.union([z.string(), z.array(ContentBlock.nullable())]).optional(),
      usage: ClaudeUsage.nullish(),
    })
    .optional(),
});

function visibleText(content: string | (ContentBlock | null)[] | undefined): string | null {
  if (typeof content === "string") return nonEmpty(content);
  if (!Array.isArray(content)) return null;
  const parts = content.flatMap((b) => (b?.type === "text" && b.text !== undefined ? [b.text] : []));
  return parts.length > 0 ? parts.join("\n") : null;
}

function resultSize(content: unknown, result: ClaudeToolUseResult | undefined): number | null {
  const parts: string[] = [];
  if (typeof content === "string") parts.push(content);
  else if (Array.isArray(content)) {
    for (const b of content) if (typeof b?.text === "string") parts.push(b.text);
  }
  if (typeof result?.stdout === "string") parts.push(result.stdout);
  if (typeof result?.stderr === "string") parts.push(result.stderr);
  return parts.length > 0 ? parts.reduce((n, p) => n + p.length, 0) : null;
}

function sessionFactsOf(line: z.infer<typeof ClaudeLine>): SessionFacts {
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
    const ts = line.timestamp ?? null;
    if (ts) session.push({ ...NO_FACTS, ts });

    if (line.type === "ai-title" || line.type === "custom-title") {
      const title = nonEmpty(line.aiTitle) ?? nonEmpty(line.customTitle);
      if (title) session.push({ ...NO_FACTS, title });
      continue;
    }

    if (line.type === "system" && line.subtype === "turn_duration" && line.uuid) {
      if (!ts) {
        dropped.push(srcLine);
        continue;
      }
      turns.push({
        turnId: TurnId.parse(line.uuid),
        tsStart: line.durationMs == null ? null : timestampMinus(ts, line.durationMs),
        tsEnd: ts,
        durationMs: line.durationMs ?? null,
        messageCount: line.messageCount ?? null,
        status: "completed",
        model: null,
        timeToFirstTokenMs: null,
      });
      continue;
    }

    if (line.type === "assistant" && line.message?.id) {
      if (!ts) {
        dropped.push(srcLine);
        continue;
      }
      const model = nonEmpty(line.message.model);
      session.push(sessionFactsOf(line));
      messages.push({
        id: line.message.id,
        ts,
        role: "assistant",
        model,
        turnId: null,
        promptSource: null,
        originKind: null,
        isMeta: false,
        isSkillBody: false,
        attributionSkill: nonEmpty(line.attributionSkill),
        slashCommand: null,
        denialKind: null,
        userFeedback: null,
        text: visibleText(line.message.content),
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
      if (Array.isArray(line.message.content)) {
        for (const block of line.message.content) {
          if (block?.type !== "tool_use" || !block.id || !block.name) continue;
          const input = block.input ?? {};
          const chosen = input.skill;
          if (block.name === "Skill" && typeof chosen === "string") {
            skillLoads.push({
              toolCallId: block.id,
              ts,
              model,
              skillName: chosen,
              how: "model",
            });
          }
          toolCalls.push({
            ...NO_TOOL_CALL,
            id: block.id,
            messageId: line.message.id,
            model,
            attributionSkill: nonEmpty(line.attributionSkill),
            tsCall: ts,
            toolName: block.name,
            skillName: typeof input.skill === "string" ? input.skill : null,
            filePath: typeof input.file_path === "string" ? input.file_path : null,
            command: typeof input.command === "string" ? input.command : null,
            srcLineCall: srcLine,
          });
        }
      }
      const u = line.message.usage;
      if (u) {
        usage.push({
          responseId: ResponseId.parse(line.message.id),
          messageId: line.message.id,
          ts,
          model,
          inputTokens: u.input_tokens ?? 0,
          cacheReadTokens: u.cache_read_input_tokens ?? 0,
          cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
          outputTokens: u.output_tokens ?? 0,
          attributionSkill: nonEmpty(line.attributionSkill),
        });
      }
      continue;
    }

    if (line.type === "user" && line.uuid) {
      if (!ts) {
        dropped.push(srcLine);
        continue;
      }
      const text = visibleText(line.message?.content);
      if (Array.isArray(line.message?.content)) {
        for (const block of line.message.content) {
          if (block?.type !== "tool_result" || !block.tool_use_id) continue;
          const r = line.toolUseResult;
          toolCalls.push({
            ...NO_TOOL_CALL,
            id: block.tool_use_id,
            tsResult: ts,
            isError: block.is_error === true,
            isInterrupted: r?.interrupted === true,
            resultBytes: resultSize(block.content, r),
            srcLineResult: srcLine,
          });
        }
      }
      session.push(sessionFactsOf(line));
      const body = line.isMeta === true && text ? parseSkillBody(text) : null;
      if (body) {
        const { name, ...fields } = body;
        if (line.sourceToolUseID) skillLoads.push({ toolUseId: line.sourceToolUseID, ...fields });
        else if (line.parentUuid)
          skillLoads.push({ parentUuid: line.parentUuid, skillName: name, ...fields });
      }
      messages.push({
        id: line.uuid,
        ts,
        role: "user",
        model: null,
        turnId: line.promptId ?? null,
        promptSource: nonEmpty(line.promptSource),
        originKind: nonEmpty(line.origin?.kind),
        isMeta: line.isMeta === true,
        isSkillBody: line.isMeta === true && text !== null && text.startsWith(SKILL_BODY_PREFIX),
        attributionSkill: null,
        slashCommand: text ? skillFromCommand(text) : null,
        denialKind: nonEmpty(line.toolDenialKind),
        userFeedback: feedbackText(line.userFeedback),
        text: body ? null : text,
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
    }
  }

  return { session, messages, usage, turns, toolCalls, skillLoads, dropped, cursorState: null };
}
