import type { ErrorRecord, PathFailure } from "./coded-error";
import type { SyncReport } from "./ingest-sync";

type FailureLine = { readonly path: string } & Omit<ErrorRecord, "meta">;

type DroppedLines = { readonly path: string; readonly lines: string };

type PrintedSync<Report extends SyncReport> = Omit<Report, "failures" | "dropped"> & {
  readonly failures: readonly FailureLine[] | readonly PathFailure[];
  readonly dropped: readonly DroppedLines[];
};

function failureLine({ path, error: { kind, code, message, resolve } }: PathFailure): FailureLine {
  return { path, kind, code, message, resolve };
}

export function printedSync<Report extends SyncReport>(report: Report, full: boolean): PrintedSync<Report> {
  return {
    ...report,
    failures: full ? report.failures : report.failures.map(failureLine),
    dropped: report.dropped.map(({ path, lines }) => ({ path, lines: lines.join(" ") })),
  };
}
