import { describe, expect, test } from "bun:test";
import { advance, planRead } from "./ingest-read-plan";

const AT_100 = { path: "/a.jsonl", bytes: 100, lines: 7, state: "s" };
const START = { bytes: 0, lines: 0, state: null };
const FROM_100 = { bytes: 100, lines: 7, state: "s" };

describe("planning a read", () => {
  test.each([
    ["a file never read", null, 50, { reset: false, from: START }],
    ["an empty file never read", null, 0, { reset: false, from: null }],
    ["a file that shrank below the cursor", AT_100, 50, { reset: true, from: START }],
    ["a file that shrank to nothing", AT_100, 0, { reset: true, from: null }],
    ["a file that has not grown", AT_100, 100, { reset: false, from: null }],
    ["a file that grew", AT_100, 150, { reset: false, from: FROM_100 }],
  ])("plans %s", (_, cursor, size, plan) => {
    expect(planRead(cursor, size)).toEqual(plan);
  });

  test("moves past the whole lines a chunk read, keeping the parser's state", () => {
    expect(advance(FROM_100, { lines: ["a", "bb"], bytes: 5 }, "t")).toEqual({
      bytes: 105,
      lines: 9,
      state: "t",
    });
  });
});
