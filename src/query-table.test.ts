import { describe, expect, test } from "bun:test";
import { recordsOf, unprintableColumn } from "./query-table";

describe("a column that cannot print as a table column", () => {
  test("is one that reads as a whole number after a column that does not", () => {
    expect(unprintableColumn(["a", "2"])).toEqual({ kind: "reordered", column: "2" });
    expect(unprintableColumn(["week", "0", "value"])).toEqual({ kind: "reordered", column: "0" });
  });

  test("is one named twice", () => {
    expect(unprintableColumn(["a", "b", "a"])).toEqual({ kind: "repeated", column: "a" });
  });

  test("is none when every column is named once and keeps its place", () => {
    expect(unprintableColumn(["1"])).toBeNull();
    expect(unprintableColumn(["1", "2", "a"])).toBeNull();
    expect(unprintableColumn(["a", "01", "-1", "1.5"])).toBeNull();
  });
});

describe("the rows a query prints", () => {
  test("are records keyed by column, in column order", () => {
    const records = recordsOf(["n", "s"], [[1, "x"]]);
    expect(records).toEqual([{ n: 1, s: "x" }]);
    expect(records.map((record) => Object.keys(record))).toEqual([["n", "s"]]);
  });

  test("refuse to be built from columns that would print out of order", () => {
    expect(() => recordsOf(["a", "2"], [])).toThrow("invariant");
  });

  test("refuse to be built from a column named twice", () => {
    expect(() => recordsOf(["a", "a"], [])).toThrow("invariant");
  });
});
