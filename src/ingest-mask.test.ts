import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { maskedChunk } from "./ingest-mask";
import { ParsedChunk } from "./ingest-session-records";

const SECRET = "X_TOKEN=made-up-value";
const SOME_TIME = "2026-10-16T09:00:00.000Z";

const IDENTIFIERS = [
  "cursorState",
  "messages.attributionSkill",
  "messages.denial.kind",
  "messages.id",
  "messages.model",
  "messages.originKind",
  "messages.promptSource",
  "messages.turnId",
  "session.cliVersion",
  "session.cwd",
  "session.entrypoint",
  "session.gitBranch",
  "skillLoads.bodySha256",
  "skillLoads.install",
  "skillLoads.messageId",
  "skillLoads.model",
  "skillLoads.parentUuid",
  "skillLoads.skillName",
  "skillLoads.skillPath",
  "skillLoads.toolCallId",
  "toolCalls.attributionSkill",
  "toolCalls.id",
  "toolCalls.messageId",
  "toolCalls.model",
  "toolCalls.skillName",
  "toolCalls.toolName",
  "turns.model",
  "turns.status",
  "turns.turnId",
  "usage.attributionSkill",
  "usage.messageId",
  "usage.model",
  "usage.responseId",
];

const MASKED = [
  "messages.denial.reason",
  "messages.denial.userFeedback",
  "messages.extra",
  "messages.slashCommand",
  "messages.text",
  "session.title",
  "toolCalls.command",
  "toolCalls.errorText",
  "toolCalls.filePath",
];

function samples(schema: z.core.$ZodType): readonly unknown[] {
  if (schema instanceof z.ZodDiscriminatedUnion || schema instanceof z.ZodUnion)
    return schema.options.flatMap((option) => samples(option));
  return [sample(schema)];
}

function sample(schema: z.core.$ZodType): unknown {
  if (schema instanceof z.ZodReadonly || schema instanceof z.ZodNullable || schema instanceof z.ZodOptional)
    return sample(schema.unwrap());
  if (schema instanceof z.ZodObject)
    return Object.fromEntries(Object.entries(schema.shape).map(([key, field]) => [key, sample(field)]));
  if (schema instanceof z.ZodArray) return samples(schema.element);
  if (schema instanceof z.ZodPipe) return sample(schema.in);
  if (schema instanceof z.ZodISODateTime) return SOME_TIME;
  if (schema instanceof z.ZodString) return SECRET;
  if (schema instanceof z.ZodNumber) return 1;
  if (schema instanceof z.ZodBoolean) return false;
  if (schema instanceof z.ZodLiteral) return [...schema.values][0];
  if (schema instanceof z.ZodEnum) return schema.options[0];
  if (schema instanceof z.ZodDiscriminatedUnion || schema instanceof z.ZodUnion) return samples(schema)[0];
  throw new Error(`no sample for a ${schema._zod.def.type} schema`);
}

function pathsHolding(value: unknown, path: readonly string[] = []): readonly string[] {
  if (typeof value === "string") return value.includes(SECRET) ? [path.join(".")] : [];
  if (Array.isArray(value)) return value.flatMap((item) => pathsHolding(item, path));
  if (value === null || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, field]) => pathsHolding(field, [...path, key]));
}

const sorted = (paths: readonly string[]): readonly string[] => [...new Set(paths)].sort();

describe("maskedChunk", () => {
  const chunk = ParsedChunk.parse(sample(ParsedChunk));

  test("every string field of a parsed chunk is either an identifier or masked", () => {
    expect(sorted(pathsHolding(chunk))).toEqual(sorted([...IDENTIFIERS, ...MASKED]));
  });

  test("masks every text field and leaves the identifiers", () => {
    expect(sorted(pathsHolding(maskedChunk(chunk)))).toEqual(sorted(IDENTIFIERS));
  });

  test("cuts a long error text after masking it", () => {
    const long = `${SECRET} ${"x".repeat(5000)}`;
    const [row] = maskedChunk({
      ...chunk,
      toolCalls: chunk.toolCalls.flatMap((call) =>
        call.kind === "result" ? [{ ...call, errorText: long }] : [],
      ),
    }).toolCalls;
    expect(row?.kind === "result" ? row.errorText : null).toStartWith("X_TOKEN=[REDACTED] xxx");
    expect(row?.kind === "result" ? row.errorText : null).toContain("bytes cut");
  });
});
