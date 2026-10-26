import { describe, expect, test } from "bun:test";
import type { SyncReport } from "./ingest-sync";
import { printedSync } from "./sync-view";

const REPORT: SyncReport = {
  archive: { files: 1, bytes: 10 },
  sources: [],
  eventLogs: 0,
  filesRead: 1,
  orphanSubagents: [],
  unlinkedSubagents: 0,
  failures: [
    {
      path: "/home/a.jsonl",
      error: {
        kind: "refusal",
        code: "source_unreadable",
        message: "cannot read /home/a.jsonl",
        meta: { path: "/home/a.jsonl" },
        resolve: "make /home/a.jsonl readable",
      },
    },
  ],
  dropped: [{ path: "/home/b.jsonl", lines: [3, 7, 9] }],
  git: { repos: 0, commits: 0, files: 0, unchanged: 0 },
  repoFiles: { repos: 0, files: 0, unchanged: 0 },
};

describe("a sync's printed report", () => {
  test("lists each failure as one flat line without its meta", () => {
    expect(printedSync(REPORT, false).failures).toEqual([
      {
        path: "/home/a.jsonl",
        kind: "refusal",
        code: "source_unreadable",
        message: "cannot read /home/a.jsonl",
        resolve: "make /home/a.jsonl readable",
      },
    ]);
  });

  test("keeps each failure's whole error with --full", () => {
    expect(printedSync(REPORT, true).failures).toEqual(REPORT.failures);
  });

  test("joins each file's dropped line numbers with spaces", () => {
    expect(printedSync(REPORT, false).dropped).toEqual([{ path: "/home/b.jsonl", lines: "3 7 9" }]);
  });

  test("keeps every other field in its place", () => {
    expect(Object.keys(printedSync(REPORT, false))).toEqual(Object.keys(REPORT));
  });
});
