import { describe, expect, test } from "bun:test";
import { TOOLS } from "./ingest-tools";

describe("the tool vocabulary", () => {
  test("is the tools, spelled as the database spells them", () => {
    expect([...TOOLS]).toEqual(["claude", "codex", "grok", "pi", "omp"]);
  });
});
