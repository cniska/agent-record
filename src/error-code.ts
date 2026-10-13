export function errorCode(error: unknown): unknown {
  return error instanceof Error && "code" in error ? error.code : undefined;
}

export function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function isEnvironmentError(error: unknown): error is Error & { readonly errno: number } {
  return error instanceof Error && "errno" in error && typeof error.errno === "number";
}
