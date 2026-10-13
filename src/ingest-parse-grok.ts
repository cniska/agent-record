import { z } from "zod";
import { MessageId, ToolCallId } from "./ingest-ids";
import { lineOf, nonEmpty } from "./ingest-parse";
import {
  type MessageRow,
  NO_FACTS,
  NO_TOOL_CALL,
  type ParsedChunk,
  type SessionFacts,
  type ToolCallRow,
} from "./ingest-session-records";
import { EpochMs, EpochSeconds } from "./timestamp";

const GrokContent = z.looseObject({ type: z.string().optional(), text: z.string().optional() });
type GrokContent = z.infer<typeof GrokContent>;

const GrokUpdate = z.looseObject({
  sessionUpdate: z.string().optional(),
  content: z.union([GrokContent, z.array(z.unknown())]).nullish(),
  toolCallId: ToolCallId.optional(),
  rawInput: z.record(z.string(), z.unknown()).nullish(),
  locations: z.array(z.looseObject({ path: z.string().nullish() })).nullish(),
  status: z.string().nullish(),
  _meta: z
    .looseObject({
      modelId: z.string().nullish(),
      "x.ai/tool": z.looseObject({ name: z.string().nullish() }).nullish(),
    })
    .nullish(),
});
type GrokUpdate = z.infer<typeof GrokUpdate>;

const GrokLine = z.looseObject({
  timestamp: EpochSeconds.optional(),
  params: z
    .looseObject({
      update: GrokUpdate.optional(),
      _meta: z
        .looseObject({ eventId: MessageId.optional(), agentTimestampMs: EpochMs.optional() })
        .optional(),
    })
    .optional(),
});

function textOf(content: GrokContent | unknown[] | null | undefined): string | null {
  if (!content || Array.isArray(content)) return null;
  if (content.type !== "text") return null;
  return nonEmpty(content.text);
}

function filePathOf(update: GrokUpdate): string | null {
  const fromInput = nonEmpty(update.rawInput?.file_path) ?? nonEmpty(update.rawInput?.target_file);
  if (fromInput) return fromInput;
  const located = update.locations?.find((location) => nonEmpty(location.path));
  return nonEmpty(located?.path);
}

function toolNameOf(update: GrokUpdate): string | null {
  return nonEmpty(update._meta?.["x.ai/tool"]?.name);
}

export function parseGrokChunk(lines: readonly string[], firstLineNumber: number): ParsedChunk {
  const session: SessionFacts[] = [];
  const messages: MessageRow[] = [];
  const toolCalls: ToolCallRow[] = [];
  const dropped: number[] = [];

  for (const [index, raw] of lines.entries()) {
    if (raw.length === 0) continue;
    const srcLine = firstLineNumber + index;
    const line = lineOf(raw, GrokLine);
    if (!line) {
      dropped.push(srcLine);
      continue;
    }
    const update = line.params?.update;
    const kind = update?.sessionUpdate;
    const ts = line.params?._meta?.agentTimestampMs ?? line.timestamp ?? null;
    if (ts) session.push({ ...NO_FACTS, ts });
    if (!update || !kind || !ts) continue;

    if (kind === "user_message_chunk" || kind === "agent_message_chunk") {
      const text = textOf(update.content);
      const id = line.params?._meta?.eventId;
      if (!text || !id) continue;
      messages.push({
        id,
        ts,
        role: kind === "user_message_chunk" ? "user" : "assistant",
        model: update._meta?.modelId ?? null,
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
      continue;
    }

    if (kind !== "tool_call" && kind !== "tool_call_update") continue;
    const id = update.toolCallId;
    if (!id) continue;
    const failed = update.status === "failed" || update.status === "error";
    const finished = update.status === "completed" || failed;
    toolCalls.push({
      ...NO_TOOL_CALL,
      id,
      tsCall: kind === "tool_call" ? ts : null,
      tsResult: finished ? ts : null,
      toolName: toolNameOf(update),
      filePath: filePathOf(update),
      command: nonEmpty(update.rawInput?.command),
      isError: failed ? true : null,
      srcLineCall: kind === "tool_call" ? srcLine : null,
      srcLineResult: kind === "tool_call_update" ? srcLine : null,
    });
  }

  return { session, messages, usage: [], turns: [], toolCalls, skillLoads: [], dropped, cursorState: null };
}
