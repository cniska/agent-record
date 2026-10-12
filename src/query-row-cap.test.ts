import { describe, expect, test } from "bun:test";
import { capResult, DEFAULT_MAX_ROWS, rowsOf } from "./query-row-cap";

describe("--rows", () => {
  test("defaults to the cap, and takes a count", () => {
    expect(rowsOf(undefined)).toBe(DEFAULT_MAX_ROWS);
    expect(rowsOf("200")).toBe(200);
  });

  test("refuses a count that is not one", () => {
    expect(() => rowsOf("many")).toThrow("not a count");
    expect(() => rowsOf("0")).toThrow("not a count");
    expect(() => rowsOf("")).toThrow("not a count");
  });
});

function numbered(ns: readonly number[]) {
  return { denominator: `${ns.length} numbers`, columns: ["n"], rows: ns.map((n) => [n]), note: "counted" };
}

describe("capping the rows an agent is handed", () => {
  test("names the flag that widens it when rows were cut", () => {
    expect(capResult(numbered([1, 2, 3, 4, 5]), 2)).toEqual({
      denominator: "5 numbers",
      columns: ["n"],
      rows: [[1], [2]],
      more: "more rows than 2; --rows <n> to widen",
      note: "counted",
    });
  });

  test("says nothing about more rows when every row fit", () => {
    expect(capResult(numbered([1, 2]), 2).more).toBeNull();
  });
});
