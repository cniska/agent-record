import type { z } from "zod";

export function issuesOf(error: z.ZodError): string {
  return error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ");
}

export function errorCode(error: unknown): unknown {
  return error instanceof Error && "code" in error ? error.code : undefined;
}

export function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function isEnvironmentError(error: unknown): error is Error & { readonly errno: number } {
  return error instanceof Error && "errno" in error && typeof error.errno === "number";
}
