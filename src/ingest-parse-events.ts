import { z } from "zod";
import { Counted, DECISIONS, GATES, type HookEvent, VERDICTS } from "./ingest-event-kinds";
import { SessionId, ToolCallId } from "./ingest-ids";
import { byKind, textAt } from "./ingest-parse";
import { parseJson } from "./ingest-source-read";
import { Timestamp } from "./timestamp";

const FORMAT_VERSION = 1;

const known = z.string().min(1);
const unknown = z.string().min(1).nullable();

const placed = {
  v: z.literal(FORMAT_VERSION),
  ts: Timestamp,
  session: SessionId,
  agent: unknown,
  cwd: unknown,
};

const GateLine = z.looseObject({
  ...placed,
  event: z.literal("gate"),
  gate: z.enum(GATES),
  decision: z.enum(DECISIONS),
  reason: known,
  repo: unknown,
  head: unknown,
  fingerprint: unknown,
});

const verdict = {
  ...placed,
  event: z.literal("verdict"),
  verdict: z.enum(VERDICTS),
  repo: known,
  fingerprint: known,
  reason: unknown.optional().transform((reason) => reason ?? null),
};

const CountedVerdictLine = z
  .looseObject({ ...verdict, ...Counted.shape })
  .transform(({ findings, conflicts, rules, ...rest }) => ({
    ...rest,
    counted: { findings, conflicts, rules },
  }));

const uncounted = z.null().optional();

const UncountedVerdictLine = z
  .looseObject({
    ...verdict,
    findings: uncounted,
    conflicts: uncounted,
    rules: uncounted,
  })
  .transform(({ findings, conflicts, rules, ...rest }) => ({ ...rest, counted: null }));

const VerdictLine = z.union([CountedVerdictLine, UncountedVerdictLine]);

const PromptLine = z.looseObject({ ...placed, event: z.literal("permission_prompt"), tool: known });

const DeniedLine = z
  .looseObject({
    ...placed,
    event: z.literal("permission_denied"),
    tool: known,
    tool_use: ToolCallId.nullable(),
    reason: known,
    rule: unknown,
  })
  .transform(({ tool_use, ...rest }) => ({ ...rest, toolUse: tool_use }));

const TagLine = z.looseObject({ ...placed, event: z.literal("tag"), key: known, value: known });

const Unkept = z.looseObject({ v: z.literal(FORMAT_VERSION) }).transform(() => null);

const KEPT = {
  gate: GateLine,
  verdict: VerdictLine,
  permission_prompt: PromptLine,
  permission_denied: DeniedLine,
  tag: TagLine,
} satisfies Readonly<Record<HookEvent, z.ZodType>>;

const EventLine = byKind((value) => textAt(value, "event"), KEPT, Unkept);

type Unversioned<Line> = Line extends unknown
  ? { [Field in keyof Line as Field extends "v" ? never : string extends Field ? never : Field]: Line[Field] }
  : never;

type Parsed = Unversioned<NonNullable<z.output<typeof EventLine>>>;

export type HookEventRow = Parsed & { readonly srcLine: number };

type ParsedEvents = { readonly events: readonly HookEventRow[]; readonly dropped: readonly number[] };

export function parseEventChunk(lines: readonly string[], firstLine: number): ParsedEvents {
  const events: HookEventRow[] = [];
  const dropped: number[] = [];
  lines.forEach((raw, index) => {
    const srcLine = firstLine + index;
    const read = parseJson(raw, EventLine);
    if (read.kind === "invalid") dropped.push(srcLine);
    else if (read.value !== null) {
      const { v, ...event } = read.value;
      events.push({ ...event, srcLine });
    }
  });
  return { events, dropped };
}
