import { describe, expect, test } from "bun:test";
import { docOf, textOf, withTokenizer } from "./query-recall-scrub.test-support";

describe("a scrubbed message", () => {
  test("tokenize as the record's index does: folded case and accents, split on punctuation", () => {
    expect(withTokenizer((tokens) => tokens("Café agent-record DIDN'T"))).toEqual([
      "cafe",
      "agent",
      "record",
      "didn",
      "t",
    ]);
  });

  test("keep its length and every searched word's count, phrases included, and nothing else", () => {
    const tokens = ["w1", null, "w2", "w3", null, "w2", null, "w1", null, null];
    const doc = docOf(tokens, ["w1", "w2-w3", "w2", "w9"]);
    expect(doc).toEqual({
      length: 10,
      spaced: true,
      grams: [
        ["w2-w3", 1],
        ["w1", 2],
        ["w2", 1],
      ],
    });
    expect(doc === null ? "" : textOf(doc)).toBe("w2 w3 x w1 x w1 x w2 x x");
  });

  test("lay the words out unspaced when spacing them would not fit its length", () => {
    const doc = docOf(["w1", "w2", "w1"], ["w1", "w2"]);
    expect(doc).toEqual({
      length: 3,
      spaced: false,
      grams: [
        ["w1", 2],
        ["w2", 1],
      ],
    });
    expect(doc === null ? "" : textOf(doc)).toBe("w1 w1 w2");
  });

  test("refuse a layout that would make a phrase it did not hold", () => {
    expect(docOf(["w1", "w2"], ["w2", "w1", "w2-w1"])).toBeNull();
  });
});
