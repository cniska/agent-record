import { z } from "zod";
import { parseJson } from "./ingest-source-read";
import { Timestamp } from "./timestamp";

export function lineOf<T>(raw: string, schema: z.ZodType<T>): T | null {
  const read = parseJson(raw, schema);
  return read.kind === "read" ? read.value : null;
}

export function textAt(value: unknown, ...path: readonly string[]): string {
  let at = value;
  for (const key of path) at = typeof at === "object" && at !== null ? Reflect.get(at, key) : undefined;
  return typeof at === "string" ? at : "";
}

export function typeOf(value: unknown): string {
  return textAt(value, "type");
}

export function byKind<Kept extends Readonly<Record<string, z.ZodType>>, Unkept extends z.ZodType>(
  kindOf: (value: unknown) => string,
  kept: Kept,
  unkept: Unkept,
) {
  const schemas = new Map<string, Kept[keyof Kept]>();
  for (const kind in kept) schemas.set(kind, kept[kind]);
  return z.unknown().transform((value, ctx): z.output<Kept[keyof Kept]> | z.output<Unkept> => {
    const schema: Kept[keyof Kept] | Unkept = schemas.get(kindOf(value)) ?? unkept;
    const read = schema.safeParse(value);
    if (read.success) return read.data;
    for (const { message, path } of read.error.issues) ctx.addIssue({ code: "custom", message, path });
    return z.NEVER;
  });
}

export const UnkeptLine = z
  .looseObject({ timestamp: Timestamp.optional() })
  .transform((line) => ({ kind: "unkept" as const, ts: line.timestamp ?? null }));

export const UnkeptPart = z.unknown().transform(() => ({ kind: "unkept" as const }));

export const TextPart = z
  .looseObject({ type: z.literal("text"), text: z.string().optional() })
  .transform((part) => ({ kind: "text" as const, text: part.text ?? null }));

export function nonEmpty(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

export function jsonOrNull(value: Record<string, unknown>): string | null {
  const kept: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    if (v !== undefined && v !== null) kept[k] = v;
  }
  return Object.keys(kept).length > 0 ? JSON.stringify(kept) : null;
}
