import { z } from "zod";
import { lineOf, nonEmpty } from "./ingest-parse";
import {
  type MessageRow,
  NO_FACTS,
  NO_TOOL_CALL,
  type ParsedChunk,
  projectOf,
  type SessionFacts,
  type ToolCallRow,
  type UsageRow,
} from "./ingest-session-records";

const PiContent = z.looseObject({
  type: z.string().optional(),
  text: z.string().optional(),
  id: z.string().optional(),
  name: z.string().optional(),
  arguments: z.record(z.string(), z.unknown()).optional(),
});

const PiMessage = z.looseObject({
  role: z.string().optional(),
  content: z.array(PiContent).optional(),
  model: z.string().optional(),
  usage: z
    .looseObject({
      input: z.number().optional(),
      output: z.number().optional(),
      cacheRead: z.number().optional(),
      cacheWrite: z.number().optional(),
    })
    .optional(),
  responseId: z.string().optional(),
  toolCallId: z.string().optional(),
  toolName: z.string().optional(),
  isError: z.boolean().optional(),
});
type PiMessage = z.infer<typeof PiMessage>;

const PiLine = z.looseObject({
  type: z.string().optional(),
  id: z.string().optional(),
  timestamp: z.string().optional(),
  cwd: z.string().optional(),
  title: z.string().optional(),
  message: PiMessage.optional(),
});

function textOf(content: PiMessage["content"]): string | null {
  return nonEmpty(
    (content ?? []).flatMap((part) => (part.type === "text" && part.text ? [part.text] : [])).join("\n"),
  );
}

function usageOf(message: PiMessage, ts: string, messageId: string | null): UsageRow[] {
  const { usage, responseId } = message;
  if (usage === undefined || responseId === undefined) return [];
  return [
    {
      responseId,
      ts,
      model: message.model ?? null,
      inputTokens: usage.input ?? 0,
      cacheReadTokens: usage.cacheRead ?? 0,
      cacheWriteTokens: usage.cacheWrite ?? 0,
      outputTokens: usage.output ?? 0,
      attributionSkill: null,
      messageId,
    },
  ];
}

function callsOf(message: PiMessage, ts: string, srcLine: number): ToolCallRow[] {
  return (message.content ?? []).flatMap((part): ToolCallRow[] => {
    if (part.type !== "toolCall" || part.id === undefined) return [];
    return [
      {
        ...NO_TOOL_CALL,
        id: part.id,
        tsCall: ts,
        toolName: nonEmpty(part.name),
        filePath: nonEmpty(part.arguments?.path),
        command: nonEmpty(part.arguments?.command),
        model: message.model ?? null,
        srcLineCall: srcLine,
      },
    ];
  });
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
    const ts = line.timestamp ?? null;
    if (ts) session.push({ ...NO_FACTS, ts });
    switch (line.type) {
      case "session": {
        const cwd = line.cwd ?? null;
        session.push({ ...NO_FACTS, cwd, project: projectOf(cwd) });
        continue;
      }
      case "title":
      case "title_change":
        if (line.title) session.push({ ...NO_FACTS, title: line.title });
        continue;
      case "message":
        break;
      default:
        continue;
    }
    const { message, id } = line;
    if (message === undefined || id === undefined || ts === null) continue;
    if (message.role === "toolResult") {
      if (message.toolCallId === undefined) continue;
      toolCalls.push({
        ...NO_TOOL_CALL,
        id: message.toolCallId,
        tsResult: ts,
        toolName: nonEmpty(message.toolName),
        isError: message.isError ?? null,
        srcLineResult: srcLine,
      });
      continue;
    }
    if (message.role !== "user" && message.role !== "assistant") continue;
    const text = textOf(message.content);
    if (text) {
      messages.push({
        id,
        ts,
        role: message.role,
        model: message.model ?? null,
        turnId: null,
        promptSource: null,
        originKind: null,
        isMeta: false,
        isSkillBody: false,
        attributionSkill: null,
        slashCommand: null,
        denialKind: null,
        userFeedback: null,
        text,
        srcLine,
        extra: null,
      });
    }
    if (message.role !== "assistant") continue;
    usage.push(...usageOf(message, ts, text ? id : null));
    toolCalls.push(...callsOf(message, ts, srcLine));
  }

  return { session, messages, usage, turns: [], toolCalls, skillLoads: [], dropped, cursorState: null };
}
