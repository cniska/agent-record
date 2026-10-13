import { z } from "zod";
import { jsonOrNull, lineOf, nonEmpty } from "./ingest-parse";
import {
  type MessageRow,
  NO_FACTS,
  type ParsedChunk,
  projectOf,
  type SessionFacts,
  type ToolCallRow,
  type TurnRow,
  type UsageRow,
} from "./ingest-session-records";
import { type SkillLoadRow, skillFromFileRead } from "./ingest-skill-load";
import { EpochMs, EpochSeconds, Timestamp } from "./timestamp";

export const CodexState = z.strictObject({ model: z.string().nullable(), turnId: z.string().nullable() });
export type CodexState = z.infer<typeof CodexState>;

export const NO_CODEX_STATE: CodexState = { model: null, turnId: null };

const CodexContent = z.looseObject({ type: z.string().optional(), text: z.string().optional() });

const CodexUsage = z.looseObject({
  input_tokens: z.number().optional(),
  cached_input_tokens: z.number().optional(),
  cache_write_input_tokens: z.number().optional(),
  output_tokens: z.number().optional(),
});

const CodexDuration = z.looseObject({ secs: z.number().optional(), nanos: z.number().optional() });
type CodexDuration = z.infer<typeof CodexDuration>;

const CodexLine = z.looseObject({
  type: z.string().optional(),
  timestamp: Timestamp.optional(),
  payload: z
    .looseObject({
      type: z.string().optional(),
      id: z.string().nullish(),
      role: z.string().optional(),
      content: z.array(CodexContent.nullable()).nullish(),
      timestamp: Timestamp.optional(),
      cwd: z.string().optional(),
      originator: z.string().nullish(),
      cli_version: z.string().nullish(),
      git: z.looseObject({ branch: z.string().optional() }).optional(),
      turn_id: z.string().nullish(),
      model: z.string().nullish(),
      response_id: z.string().optional(),
      usage: CodexUsage.nullish(),
      started_at: EpochSeconds.optional(),
      completed_at: EpochSeconds.optional(),
      duration_ms: z.number().optional(),
      time_to_first_token_ms: z.number().optional(),
      reason: z.string().nullish(),
      started_at_ms: EpochMs.optional(),
      completed_at_ms: EpochMs.optional(),
      item: z
        .looseObject({
          id: z.string().optional(),
          type: z.string().optional(),
          command: z.unknown().optional(),
          changes: z.record(z.string(), z.unknown()).optional(),
          status: z.string().nullish(),
          exit_code: z.number().optional(),
          duration: CodexDuration.optional(),
          stdout: z.string().optional(),
          stderr: z.string().optional(),
        })
        .optional(),
    })
    .optional(),
});

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

type CodexThread = { readonly id: string; readonly state: CodexState };

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
    const line = lineOf(raw, CodexLine);
    if (!line) {
      dropped.push(firstLineNumber + index);
      continue;
    }
    const ts = line.timestamp ?? null;
    if (ts) session.push({ ...NO_FACTS, ts });
    const p = line.payload;
    if (!p) continue;
    if (!ts) {
      dropped.push(firstLineNumber + index);
      continue;
    }
    const srcLine = firstLineNumber + index;

    if (line.type === "session_meta") {
      const cwd = p.cwd ?? null;
      session.push({
        ts: p.timestamp ?? null,
        cwd,
        project: projectOf(cwd),
        gitBranch: nonEmpty(p.git?.branch),
        cliVersion: nonEmpty(p.cli_version),
        entrypoint: nonEmpty(p.originator),
        title: null,
      });
      continue;
    }

    if (line.type === "turn_context") {
      current = {
        model: nonEmpty(p.model) ?? current.model,
        turnId: nonEmpty(p.turn_id) ?? current.turnId,
      };
      const cwd = p.cwd ?? null;
      session.push({ ...NO_FACTS, cwd, project: projectOf(cwd) });
      if (current.turnId) {
        turns.push({
          turnId: current.turnId,
          tsStart: ts,
          tsEnd: null,
          durationMs: null,
          messageCount: null,
          status: "started",
          model: current.model,
          timeToFirstTokenMs: null,
        });
      }
      continue;
    }

    if (
      line.type === "response_item" &&
      p.type === "message" &&
      (p.role === "user" || p.role === "assistant")
    ) {
      const text = visibleText(p.content);
      const injected = /^\s*(#\s*AGENTS\.md instructions|<[a-z_]+>|\[\s*\{)/.test(text ?? "");
      const promptSource = p.role === "user" ? (injected ? "system" : "typed") : null;

      const id = nonEmpty(p.id) ?? `${thread.id}:${srcLine}`;
      messages.push({
        id,
        ts,
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
      continue;
    }

    if (line.type === "event_msg" && (p.type === "task_complete" || p.type === "turn_aborted") && p.turn_id) {
      const status = p.type === "task_complete" ? "completed" : nonEmpty(p.reason);
      if (status === null) {
        dropped.push(srcLine);
        continue;
      }
      turns.push({
        turnId: p.turn_id,
        tsStart: p.started_at ?? null,
        tsEnd: p.completed_at ?? ts,
        durationMs: p.duration_ms ?? null,
        messageCount: null,
        status,
        model: null,
        timeToFirstTokenMs: p.time_to_first_token_ms ?? null,
      });
      continue;
    }

    const item = p.item;
    if (line.type === "event_msg" && p.type === "item_completed" && item?.id) {
      const kind = item.type ?? "";
      if (kind === "CommandExecution" || kind === "FileChange" || kind === "McpToolCall") {
        const cmd = typeof item.command === "string" ? item.command : commandText(item.command);
        const readSkill = cmd ? skillFromFileRead(cmd) : null;
        if (readSkill) {
          skillLoads.push({
            toolCallId: item.id,
            ts: p.started_at_ms ?? ts,
            model: current.model,
            skillName: readSkill,
            how: "read",
          });
        }
        toolCalls.push({
          id: item.id,
          messageId: null,
          model: current.model,
          attributionSkill: null,
          tsCall: p.started_at_ms ?? ts,
          tsResult: p.completed_at_ms ?? ts,
          toolName: kind,
          skillName: null,
          filePath: kind === "FileChange" ? Object.keys(item.changes ?? {}).join(" ") || null : null,
          command: cmd,
          isError: item.status != null ? item.status !== "completed" : null,
          isInterrupted: null,
          exitCode: item.exit_code ?? null,
          durationMs: durationMs(item.duration),
          resultBytes: (item.stdout?.length ?? 0) + (item.stderr?.length ?? 0) || null,
          srcLineCall: srcLine,
          srcLineResult: srcLine,
        });
      }
      continue;
    }

    if (line.type === "token_usage_record" && p.response_id) {
      const u = p.usage ?? {};
      const input = u.input_tokens ?? 0;
      const cached = u.cached_input_tokens ?? 0;
      if (cached > input) {
        dropped.push(srcLine);
        continue;
      }
      usage.push({
        responseId: p.response_id,
        ts,
        model: current.model,
        inputTokens: input - cached,
        cacheReadTokens: cached,
        cacheWriteTokens: u.cache_write_input_tokens ?? 0,
        outputTokens: u.output_tokens ?? 0,
        attributionSkill: null,
        messageId: null,
      });
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
