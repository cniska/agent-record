import { z } from "zod";
import { unreachable } from "./assert";
import { MessageId, ToolCallId } from "./ingest-ids";
import { byKind, lineOf, nonEmpty, textAt } from "./ingest-parse";
import {
  type MessageRow,
  NO_FACTS,
  type ParsedChunk,
  plainMessage,
  type SessionFacts,
  type ToolCallRow,
} from "./ingest-session-records";
import { EpochMs, EpochSeconds, type Timestamp } from "./timestamp";

const GrokContent = z.looseObject({ type: z.string().optional(), text: z.string().optional() });
type GrokContent = z.infer<typeof GrokContent>;

const AgentTimestampMs = EpochMs.optional();

const GrokTimedLine = z.looseObject({
  timestamp: EpochSeconds.optional(),
  params: z
    .looseObject({ _meta: z.looseObject({ agentTimestampMs: AgentTimestampMs }).optional() })
    .optional(),
});
type GrokTimedLine = z.infer<typeof GrokTimedLine>;

function timeOf(line: GrokTimedLine): Timestamp | null {
  return line.params?._meta?.agentTimestampMs ?? line.timestamp ?? null;
}

function timed(line: GrokTimedLine, ctx: z.RefinementCtx): Timestamp {
  const ts = timeOf(line);
  if (ts !== null) return ts;
  ctx.addIssue({ code: "custom", message: "the line carries no time" });
  return z.NEVER;
}

const GrokShellExitCode = z.union([
  z
    .looseObject({ type: z.literal("Bash"), exit_code: z.number().int() })
    .transform((output) => output.exit_code),
  z.unknown().transform(() => null),
]);

const GrokToolLine = z
  .looseObject({
    timestamp: EpochSeconds.optional(),
    params: z.looseObject({
      update: z.looseObject({
        sessionUpdate: z.enum(["tool_call", "tool_call_update"]),
        toolCallId: ToolCallId,
        rawInput: z.record(z.string(), z.unknown()).nullish(),
        locations: z.array(z.looseObject({ path: z.string().nullish() })).nullish(),
        status: z.string().nullish(),
        rawOutput: GrokShellExitCode.optional(),
        _meta: z
          .looseObject({ "x.ai/tool": z.looseObject({ name: z.string().nullish() }).nullish() })
          .nullish(),
      }),
      _meta: z.looseObject({ agentTimestampMs: AgentTimestampMs }).optional(),
    }),
  })
  .transform((line, ctx) => {
    const { rawOutput, ...update } = line.params.update;
    return {
      kind: "tool" as const,
      ts: timed(line, ctx),
      update: { ...update, shellExitCode: rawOutput ?? null },
    };
  });
type GrokToolLine = z.infer<typeof GrokToolLine>;
type GrokToolUpdate = GrokToolLine["update"];

const GrokMessageLine = z
  .looseObject({
    timestamp: EpochSeconds.optional(),
    params: z.looseObject({
      update: z.looseObject({
        sessionUpdate: z.enum(["user_message_chunk", "agent_message_chunk"]),
        content: z.union([GrokContent, z.array(z.unknown())]).nullish(),
        _meta: z.looseObject({ modelId: z.string().nullish() }).nullish(),
      }),
      _meta: z.looseObject({ eventId: MessageId, agentTimestampMs: AgentTimestampMs }),
    }),
  })
  .transform((line, ctx) => {
    const { update, _meta } = line.params;
    return {
      kind: "message" as const,
      ts: timed(line, ctx),
      id: _meta.eventId,
      role: update.sessionUpdate === "user_message_chunk" ? ("user" as const) : ("assistant" as const),
      text: textOf(update.content),
      model: update._meta?.modelId ?? null,
    };
  });

const GrokUnkeptLine = GrokTimedLine.transform((line) => ({ kind: "unkept" as const, ts: timeOf(line) }));

const GrokLine = byKind(
  (value) => textAt(value, "params", "update", "sessionUpdate"),
  {
    tool_call: GrokToolLine,
    tool_call_update: GrokToolLine,
    user_message_chunk: GrokMessageLine,
    agent_message_chunk: GrokMessageLine,
  },
  GrokUnkeptLine,
);

function textOf(content: GrokContent | unknown[] | null | undefined): string | null {
  if (!content || Array.isArray(content)) return null;
  if (content.type !== "text") return null;
  return nonEmpty(content.text);
}

function filePathOf(update: GrokToolUpdate): string | null {
  const fromInput = nonEmpty(update.rawInput?.file_path) ?? nonEmpty(update.rawInput?.target_file);
  if (fromInput) return fromInput;
  const located = update.locations?.find((location) => nonEmpty(location.path));
  return nonEmpty(located?.path);
}

function toolNameOf(update: GrokToolUpdate): string | null {
  return nonEmpty(update._meta?.["x.ai/tool"]?.name);
}

function toolRowsOf({ update, ts }: GrokToolLine, srcLine: number): ToolCallRow[] {
  const id = update.toolCallId;
  const toolName = toolNameOf(update);
  const filePath = filePathOf(update);
  const command = nonEmpty(update.rawInput?.command);
  const described: ToolCallRow =
    update.sessionUpdate === "tool_call"
      ? {
          kind: "call",
          id,
          ts,
          messageId: null,
          toolName,
          skillName: null,
          filePath,
          command,
          model: null,
          attributionSkill: null,
          srcLine,
        }
      : { kind: "detail", id, toolName, filePath, command };
  const failed = update.status === "failed" || update.status === "error";
  if (update.status !== "completed" && !failed) return [described];
  return [
    described,
    {
      kind: "result",
      id,
      ts,
      toolName: null,
      isError: failed ? true : null,
      isInterrupted: null,
      exitCode: update.shellExitCode,
      durationMs: null,
      resultBytes: null,
      srcLine,
    },
  ];
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
    if (line.ts) session.push({ ...NO_FACTS, ts: line.ts });
    switch (line.kind) {
      case "tool":
        toolCalls.push(...toolRowsOf(line, srcLine));
        break;
      case "message":
        if (line.text) messages.push(plainMessage({ ...line, text: line.text, srcLine }));
        break;
      case "unkept":
        break;
      default:
        unreachable(line);
    }
  }

  return { session, messages, usage: [], turns: [], toolCalls, skillLoads: [], dropped, cursorState: null };
}
