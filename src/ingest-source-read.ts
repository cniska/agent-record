import { existsSync, readFileSync } from "node:fs";
import type { z } from "zod";
import { type Failure, refuseIngest } from "./ingest-contract";

function isEnvironmentError(error: unknown): error is Error & { readonly errno: number } {
  return error instanceof Error && "errno" in error && typeof error.errno === "number";
}

export function readingSource<T>(
  code: "source_unreadable" | "titles_unreadable",
  path: string,
  read: () => T,
): T {
  try {
    return read();
  } catch (error) {
    if (!isEnvironmentError(error)) throw error;
    throw refuseIngest(code, { path, detail: error.message });
  }
}

function issuesOf(error: z.ZodError): string {
  return error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ");
}

type JsonRead<T> =
  | { readonly kind: "read"; readonly value: T }
  | { readonly kind: "invalid"; readonly detail: string };

export function parseJson<T>(raw: string, schema: z.ZodType<T>): JsonRead<T> {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    return { kind: "invalid", detail: error.message };
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) return { kind: "invalid", detail: issuesOf(parsed.error) };
  return { kind: "read", value: parsed.data };
}

export function readSidecar<T>(path: string, schema: z.ZodType<T>, fail: Failure): T | null {
  if (!existsSync(path)) return null;
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    if (!isEnvironmentError(error)) throw error;
    fail(path, refuseIngest("sidecar_unreadable", { path, detail: error.message }));
    return null;
  }
  const read = parseJson(raw, schema);
  if (read.kind === "invalid") {
    fail(path, refuseIngest("sidecar_unreadable", { path, detail: read.detail }));
    return null;
  }
  return read.value;
}
