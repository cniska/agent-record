import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { invariant } from "./assert";
import { byKind, lineOf, textAt, typeOf } from "./ingest-parse";

const Line = z.looseObject({ type: z.string() });

const Kinded = byKind(
  typeOf,
  { user: z.looseObject({ type: z.literal("user"), id: z.string().min(1) }) },
  z.looseObject({ type: z.string() }),
);

describe("reading a line by its kind", () => {
  test("reads a kept kind through its own schema", () => {
    expect(lineOf('{"type":"user","id":"u1"}', Kinded)).toEqual({ type: "user", id: "u1" });
  });

  test("refuses a kept kind its own schema rejects", () => {
    expect(lineOf('{"type":"user","id":""}', Kinded)).toBeNull();
  });

  test("reads a kind with no schema of its own through the fallback, whatever else it carries", () => {
    expect(lineOf('{"type":"mode","id":""}', Kinded)).toEqual({ type: "mode", id: "" });
  });

  test("refuses a line whose kind is not text when the fallback refuses it", () => {
    expect(lineOf('{"type":7}', Kinded)).toBeNull();
  });
});

describe("reading the text at a path", () => {
  test.each([
    ["text at the path", { a: { b: "x" } }, "x"],
    ["no key at the path", { a: {} }, ""],
    ["a value that is not text", { a: { b: 7 } }, ""],
    ["a value that is not an object on the way", { a: "x" }, ""],
    ["null on the way", { a: null }, ""],
  ])("reads %s", (_, value, text) => {
    expect(textAt(value, "a", "b")).toBe(text);
  });
});

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
