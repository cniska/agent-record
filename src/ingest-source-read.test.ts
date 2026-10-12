import { describe, expect, test } from "bun:test";
import { statSync } from "node:fs";
import { invariant } from "./assert";
import { readingSource } from "./ingest-source-read";

describe("reading a source", () => {
  test("refuses a file the system cannot read, naming it", () => {
    expect(() => readingSource("source_unreadable", "/nonexistent", () => statSync("/nonexistent"))).toThrow(
      expect.objectContaining({
        kind: "refusal",
        code: "source_unreadable",
        meta: { path: "/nonexistent", detail: expect.stringContaining("ENOENT") },
      }),
    );
  });

  test("lets a fault through unchanged rather than calling it unreadable", () => {
    expect(() => readingSource("source_unreadable", "/x", () => invariant(false, "a bug"))).toThrow(
      expect.objectContaining({ kind: "fault", code: "invariant_failed" }),
    );
  });

  test("lets a programming error that carries a code through unchanged", () => {
    expect(() => readingSource("source_unreadable", "/x", () => Buffer.alloc(-1))).toThrow(
      expect.objectContaining({ code: "ERR_OUT_OF_RANGE" }),
    );
  });
});
