import { refuseIngest } from "./ingest-contract";

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
