import type { z } from "zod";
import { parseJson } from "./ingest-source-read";

export function lineOf<T>(raw: string, schema: z.ZodType<T>): T | null {
  const read = parseJson(raw, schema);
  return read.kind === "read" ? read.value : null;
}

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
