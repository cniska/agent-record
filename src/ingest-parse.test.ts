import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { invariant } from "./assert";
import { lineOf } from "./ingest-parse";

const Line = z.looseObject({ type: z.string() });

describe("reading one line of a tool's file", () => {
  test("reads a line its schema accepts", () => {
    expect(lineOf('{"type":"user","extra":1}', Line)).toEqual({ type: "user", extra: 1 });
  });

  test("reads a line that is not JSON as nothing", () => {
    expect(lineOf('{"type":', Line)).toBeNull();
  });

  test("reads a line its schema rejects as nothing", () => {
    expect(lineOf('{"type":7}', Line)).toBeNull();
  });

  test("a reader error that is not a parse failure is not swallowed", () => {
    const Failing = z.string().transform(() => invariant(false, "a bug in the reader"));
    expect(() => lineOf('"text"', Failing)).toThrow(
      expect.objectContaining({ kind: "fault", code: "invariant_failed" }),
    );
  });
});
