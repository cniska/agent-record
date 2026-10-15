import { z } from "zod";
import { unreachable } from "./assert";
import { MessageId, ResponseId, ToolCallId } from "./ingest-ids";
import { byKind, lineOf, nonEmpty, TextPart, textAt, typeOf, UnkeptLine, UnkeptPart } from "./ingest-parse";
import {
  type MessageRow,
  NO_FACTS,
  type ParsedChunk,
  plainMessage,
  type SessionFacts,
  type ToolCallRow,
  type UsageRow,
} from "./ingest-session-records";
import { Timestamp } from "./timestamp";

const PiToolCall = z
  .looseObject({
    type: z.literal("toolCall"),
    id: ToolCallId,
    name: z.string().optional(),
    arguments: z.record(z.string(), z.unknown()).optional(),
  })
  .transform((part) => ({
    kind: "toolCall" as const,
    id: part.id,
    name: part.name,
    arguments: part.arguments,
  }));

const PiTextPart = byKind(typeOf, { text: TextPart }, UnkeptPart);

const PiAssistantPart = byKind(typeOf, { text: TextPart, toolCall: PiToolCall }, UnkeptPart);

const PiUsage = z.looseObject({
  input: z.number().optional(),
  output: z.number().optional(),
  cacheRead: z.number().optional(),
  cacheWrite: z.number().optional(),
});

const PiUserLine = z
  .looseObject({
    id: MessageId,
    timestamp: Timestamp,
    message: z.looseObject({ content: z.array(PiTextPart).optional(), model: z.string().optional() }),
  })
  .transform((line) => ({
    kind: "user" as const,
    ts: line.timestamp,
    id: line.id,
    parts: line.message.content ?? [],
    model: line.message.model ?? null,
  }));

const PiAssistantLine = z
  .looseObject({
    id: MessageId,
    timestamp: Timestamp,
    message: z.looseObject({
      content: z.array(PiAssistantPart).optional(),
      model: z.string().optional(),
      usage: PiUsage.optional(),
      responseId: ResponseId.optional(),
    }),
  })
  .transform((line) => ({
    kind: "assistant" as const,
    ts: line.timestamp,
    id: line.id,
    parts: line.message.content ?? [],
    model: line.message.model ?? null,
    usage: line.message.usage ?? null,
    responseId: line.message.responseId ?? null,
  }));
type PiAssistantLine = z.infer<typeof PiAssistantLine>;

const FAILED_COMMAND_TAIL = /\nCommand exited with code (\d+)$/;

function exitCodeOf(parts: readonly z.output<typeof PiTextPart>[]): number | null {
  const last = parts.at(-1);
  const code = last?.kind === "text" ? last.text?.match(FAILED_COMMAND_TAIL)?.[1] : undefined;
  return code === undefined ? null : Number(code);
}

const PiToolResultLine = z
  .looseObject({
    timestamp: Timestamp,
    message: z.looseObject({
      toolCallId: ToolCallId,
      toolName: z.string().optional(),
      isError: z.boolean().optional(),
      content: z.array(PiTextPart).optional(),
      details: z.looseObject({ exitCode: z.number().int().optional() }).nullish(),
    }),
  })
  .transform(({ timestamp, message }) => ({
    kind: "toolResult" as const,
    ts: timestamp,
    toolCallId: message.toolCallId,
    toolName: nonEmpty(message.toolName),
    isError: message.isError ?? null,
    exitCode:
      message.details?.exitCode ?? (message.isError === true ? exitCodeOf(message.content ?? []) : null),
  }));
type PiToolResultLine = z.infer<typeof PiToolResultLine>;

const PiSessionLine = z
  .looseObject({ timestamp: Timestamp.optional(), cwd: z.string() })
  .transform((line) => ({ kind: "session" as const, ts: line.timestamp ?? null, cwd: line.cwd }));

const PiTitleLine = z
  .looseObject({ timestamp: Timestamp.optional(), title: z.string().min(1) })
  .transform((line) => ({ kind: "title" as const, ts: line.timestamp ?? null, title: line.title }));

function piKind(value: unknown): string {
  const type = typeOf(value);
  return type === "message" ? `message/${textAt(value, "message", "role")}` : type;
}

const PiLine = byKind(
  piKind,
  {
    session: PiSessionLine,
    title: PiTitleLine,
    title_change: PiTitleLine,
    "message/user": PiUserLine,
    "message/assistant": PiAssistantLine,
    "message/toolResult": PiToolResultLine,
  },
  UnkeptLine,
);

function textOf(parts: readonly z.output<typeof PiAssistantPart>[]): string | null {
  return nonEmpty(parts.flatMap((part) => (part.kind === "text" && part.text ? [part.text] : [])).join("\n"));
}

function usageOf(line: PiAssistantLine, messageId: MessageId | null): UsageRow[] {
  const { usage, responseId } = line;
  if (usage === null || responseId === null) return [];
  return [
    {
      responseId,
      ts: line.ts,
      model: line.model,
      inputTokens: usage.input ?? 0,
      cacheReadTokens: usage.cacheRead ?? 0,
      cacheWriteTokens: usage.cacheWrite ?? 0,
      outputTokens: usage.output ?? 0,
      attributionSkill: null,
      messageId,
    },
  ];
}

function callsOf(line: PiAssistantLine, srcLine: number): ToolCallRow[] {
  return line.parts.flatMap((part): ToolCallRow[] => {
    if (part.kind !== "toolCall") return [];
    return [
      {
        kind: "call",
        id: part.id,
        ts: line.ts,
        messageId: null,
        toolName: nonEmpty(part.name),
        skillName: null,
        filePath: nonEmpty(part.arguments?.path),
        command: nonEmpty(part.arguments?.command),
        model: line.model,
        attributionSkill: null,
        srcLine,
      },
    ];
  });
}

function resultOf(line: PiToolResultLine, srcLine: number): ToolCallRow {
  return {
    kind: "result",
    id: line.toolCallId,
    ts: line.ts,
    toolName: line.toolName,
    isError: line.isError,
    isInterrupted: null,
    hostRefused: null,
    exitCode: line.exitCode,
    durationMs: null,
    resultBytes: null,
    srcLine,
  };
}

export function parsePiChunk(lines: readonly string[], firstLineNumber: number): ParsedChunk {
  const session: SessionFacts[] = [];
  const messages: MessageRow[] = [];
  const usage: UsageRow[] = [];
  const toolCalls: ToolCallRow[] = [];
  const dropped: number[] = [];

  for (const [index, raw] of lines.entries()) {
    if (raw.length === 0) continue;
    const srcLine = firstLineNumber + index;
    const line = lineOf(raw, PiLine);
    if (!line) {
      dropped.push(srcLine);
      continue;
    }
    if (line.ts) session.push({ ...NO_FACTS, ts: line.ts });
    switch (line.kind) {
      case "session":
        session.push({ ...NO_FACTS, cwd: line.cwd });
        break;
      case "title":
        session.push({ ...NO_FACTS, title: line.title });
        break;
      case "user": {
        const text = textOf(line.parts);
        if (text) messages.push(plainMessage({ ...line, role: "user", text, srcLine }));
        break;
      }
      case "assistant": {
        const text = textOf(line.parts);
        if (text) messages.push(plainMessage({ ...line, role: "assistant", text, srcLine }));
        usage.push(...usageOf(line, text ? line.id : null));
        toolCalls.push(...callsOf(line, srcLine));
        break;
      }
      case "toolResult":
        toolCalls.push(resultOf(line, srcLine));
        break;
      case "unkept":
        break;
      default:
        unreachable(line);
    }
  }

  return {
    session,
    messages,
    usage,
    turns: [],
    compactions: [],
    toolCalls,
    skillLoads: [],
    dropped,
    cursorState: null,
  };
}
