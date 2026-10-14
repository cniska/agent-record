import { z } from "zod";
import { unreachable } from "./assert";
import { MessageId, ResponseId, type SessionId, ToolCallId, TurnId } from "./ingest-ids";
import { byKind, jsonOrNull, lineOf, nonEmpty, textAt, typeOf, UnkeptLine } from "./ingest-parse";
import {
  type MessageRow,
  NO_FACTS,
  type ParsedChunk,
  ROLES,
  type SessionFacts,
  type ToolCallRow,
  type TurnRow,
  type UsageRow,
} from "./ingest-session-records";
import { type SkillLoadRow, skillFromFileRead } from "./ingest-skill-load";
import { EpochMs, EpochSeconds, Timestamp } from "./timestamp";

export const CodexState = z.strictObject({ model: z.string().nullable(), turnId: TurnId.nullable() });
export type CodexState = z.infer<typeof CodexState>;

export const NO_CODEX_STATE: CodexState = { model: null, turnId: null };

const CodexContent = z.object({ type: z.string().optional(), text: z.string().optional() });

const CodexUsage = z.object({
  input_tokens: z.number().optional(),
  cached_input_tokens: z.number().optional(),
  cache_write_input_tokens: z.number().optional(),
  output_tokens: z.number().optional(),
});

const CodexDuration = z.object({ secs: z.number().optional(), nanos: z.number().optional() });
type CodexDuration = z.infer<typeof CodexDuration>;

function codexLine<Kind extends string, Payload>(kind: Kind, payload: z.ZodType<Payload>) {
  return z
    .looseObject({ timestamp: Timestamp, payload })
    .transform((line) => ({ kind, ts: line.timestamp, p: line.payload }));
}

const CodexTurnEnd = {
  turn_id: TurnId,
  started_at: EpochSeconds.optional(),
  completed_at: EpochSeconds.optional(),
  duration_ms: z.number().optional(),
  time_to_first_token_ms: z.number().optional(),
};

const CODEX_TOOL_ITEMS = ["CommandExecution", "FileChange", "McpToolCall"] as const;

const CodexItemLine = codexLine(
  "item",
  z.object({
    started_at_ms: EpochMs.optional(),
    completed_at_ms: EpochMs.optional(),
    item: z.object({
      id: ToolCallId,
      type: z.enum(CODEX_TOOL_ITEMS),
      command: z.unknown().optional(),
      changes: z.record(z.string(), z.unknown()).optional(),
      status: z.string().nullish(),
      exit_code: z.number().optional(),
      duration: CodexDuration.optional(),
      stdout: z.string().optional(),
      stderr: z.string().optional(),
    }),
  }),
);

const CodexMessageLine = codexLine(
  "message",
  z.object({
    id: MessageId.nullish(),
    role: z.enum(ROLES),
    content: z.array(CodexContent.nullable()).nullish(),
  }),
);

function isToolItem(type: string): boolean {
  return CODEX_TOOL_ITEMS.some((item) => item === type);
}

function codexKind(value: unknown): string {
  const type = typeOf(value);
  const payloadType = textAt(value, "payload", "type");
  switch (type) {
    case "response_item":
      return `response_item/${payloadType}/${textAt(value, "payload", "role")}`;
    case "event_msg": {
      if (payloadType !== "item_completed") return `event_msg/${payloadType}`;
      const itemType = textAt(value, "payload", "item", "type");
      return isToolItem(itemType) ? "item_completed" : `item_completed/${itemType}`;
    }
    default:
      return type;
  }
}

const CodexLine = byKind(
  codexKind,
  {
    session_meta: codexLine(
      "session",
      z.object({
        timestamp: Timestamp.optional(),
        cwd: z.string().optional(),
        originator: z.string().nullish(),
        cli_version: z.string().nullish(),
        git: z.object({ branch: z.string().optional() }).optional(),
      }),
    ),
    turn_context: codexLine(
      "turnContext",
      z.object({ cwd: z.string().optional(), model: z.string().nullish(), turn_id: TurnId.nullish() }),
    ),
    "response_item/message/user": CodexMessageLine,
    "response_item/message/assistant": CodexMessageLine,
    "event_msg/task_complete": codexLine("turnComplete", z.object(CodexTurnEnd)),
    "event_msg/turn_aborted": codexLine(
      "turnAborted",
      z.object({ ...CodexTurnEnd, reason: z.string().min(1) }),
    ),
    item_completed: CodexItemLine,
    token_usage_record: codexLine(
      "usage",
      z
        .object({ response_id: ResponseId, usage: CodexUsage.nullish() })
        .refine((p) => (p.usage?.cached_input_tokens ?? 0) <= (p.usage?.input_tokens ?? 0), {
          error: "reports more cached input than input",
        }),
    ),
  },
  UnkeptLine,
);

function durationMs(d: CodexDuration | undefined): number | null {
  if (!d) return null;
  return Math.round((d.secs ?? 0) * 1000 + (d.nanos ?? 0) / 1e6);
}

function commandText(value: unknown): string | null {
  return Array.isArray(value) ? value.map(String).join(" ") : null;
}

function visibleText(content: (z.infer<typeof CodexContent> | null)[] | null | undefined): string | null {
  if (!Array.isArray(content)) return null;
  const parts = content.flatMap((b) => (b?.text !== undefined ? [b.text] : []));
  return parts.length > 0 ? parts.join("\n") : null;
}

type CodexThread = { readonly id: SessionId; readonly state: CodexState };

export function parseCodexChunk(
  lines: readonly string[],
  firstLineNumber: number,
  thread: CodexThread,
): ParsedChunk {
  const session: SessionFacts[] = [];
  const messages: MessageRow[] = [];
  const usage: UsageRow[] = [];
  const turns: TurnRow[] = [];
  const toolCalls: ToolCallRow[] = [];
  const skillLoads: SkillLoadRow[] = [];
  const dropped: number[] = [];
  let current: CodexState = { ...thread.state };

  for (const [index, raw] of lines.entries()) {
    if (raw.length === 0) continue;
    const srcLine = firstLineNumber + index;
    const line = lineOf(raw, CodexLine);
    if (!line) {
      dropped.push(srcLine);
      continue;
    }
    if (line.ts) session.push({ ...NO_FACTS, ts: line.ts });

    switch (line.kind) {
      case "session": {
        const { p } = line;
        session.push({
          ts: p.timestamp ?? null,
          cwd: p.cwd ?? null,
          gitBranch: nonEmpty(p.git?.branch),
          cliVersion: nonEmpty(p.cli_version),
          entrypoint: nonEmpty(p.originator),
          title: null,
        });
        break;
      }

      case "turnContext": {
        const { p } = line;
        current = {
          model: nonEmpty(p.model) ?? current.model,
          turnId: p.turn_id ?? current.turnId,
        };
        session.push({ ...NO_FACTS, cwd: p.cwd ?? null });
        if (current.turnId) {
          turns.push({
            turnId: current.turnId,
            tsStart: line.ts,
            tsEnd: null,
            durationMs: null,
            messageCount: null,
            status: "started",
            model: current.model,
            timeToFirstTokenMs: null,
          });
        }
        break;
      }

      case "message": {
        const { p } = line;
        const text = visibleText(p.content);
        const injected = /^\s*(#\s*AGENTS\.md instructions|<[a-z_]+>|\[\s*\{)/.test(text ?? "");
        const promptSource = p.role === "user" ? (injected ? "system" : "typed") : null;
        messages.push({
          id: p.id ?? MessageId.parse(`${thread.id}:${srcLine}`),
          ts: line.ts,
          role: p.role,
          model: p.role === "assistant" ? current.model : null,
          turnId: current.turnId,
          promptSource,
          originKind: null,
          isMeta: false,
          isSkillBody: false,
          attributionSkill: null,
          slashCommand: null,
          denialKind: null,
          userFeedback: null,
          text,
          srcLine,
          extra: jsonOrNull({ content_types: p.content?.map((c) => c?.type).filter(Boolean) }),
        });
        break;
      }

      case "turnComplete":
      case "turnAborted": {
        const { p } = line;
        turns.push({
          turnId: p.turn_id,
          tsStart: p.started_at ?? null,
          tsEnd: p.completed_at ?? line.ts,
          durationMs: p.duration_ms ?? null,
          messageCount: null,
          status: line.kind === "turnAborted" ? line.p.reason : "completed",
          model: null,
          timeToFirstTokenMs: p.time_to_first_token_ms ?? null,
        });
        break;
      }

      case "item": {
        const { item } = line.p;
        const cmd = typeof item.command === "string" ? item.command : commandText(item.command);
        const startedAt = line.p.started_at_ms ?? line.ts;
        const readSkill = cmd ? skillFromFileRead(cmd) : null;
        if (readSkill) {
          skillLoads.push({
            kind: "called",
            toolCallId: item.id,
            ts: startedAt,
            model: current.model,
            skillName: readSkill,
            how: "read",
          });
        }
        toolCalls.push(
          {
            kind: "call",
            id: item.id,
            ts: startedAt,
            messageId: null,
            toolName: item.type,
            skillName: null,
            filePath: item.type === "FileChange" ? Object.keys(item.changes ?? {}).join(" ") || null : null,
            command: cmd,
            model: current.model,
            attributionSkill: null,
            srcLine,
          },
          {
            kind: "result",
            id: item.id,
            ts: line.p.completed_at_ms ?? line.ts,
            toolName: null,
            isError: item.status != null ? item.status !== "completed" : null,
            isInterrupted: null,
            exitCode: item.exit_code ?? null,
            durationMs: durationMs(item.duration),
            resultBytes: (item.stdout?.length ?? 0) + (item.stderr?.length ?? 0) || null,
            srcLine,
          },
        );
        break;
      }

      case "usage": {
        const { p } = line;
        const u = p.usage ?? {};
        const input = u.input_tokens ?? 0;
        const cached = u.cached_input_tokens ?? 0;
        usage.push({
          responseId: p.response_id,
          ts: line.ts,
          model: current.model,
          inputTokens: input - cached,
          cacheReadTokens: cached,
          cacheWriteTokens: u.cache_write_input_tokens ?? 0,
          outputTokens: u.output_tokens ?? 0,
          attributionSkill: null,
          messageId: null,
        });
        break;
      }

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
    turns,
    toolCalls,
    skillLoads,
    dropped,
    cursorState: JSON.stringify(current),
  };
}
