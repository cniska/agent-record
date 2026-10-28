import { describe, expect, test } from "bun:test";
import { fixtureRecord, readFixture } from "./query-recall-fixture.test-support";
import { rankOf, recallAt5, recallOf } from "./query-recall.test-support";

const BASELINE = { found: 30, cases: 55 };

describe("search recall", () => {
  test("rank a case at the first row holding a message it expects", () => {
    expect(rankOf([["a"], ["b", "c"], ["c"]], ["c", "z"])).toBe(2);
    expect(rankOf([["a"]], ["z"])).toBeNull();
  });

  test("count a case found only when its message ranks within the first five", () => {
    const cases = [5, 6].map((id) => ({ id, searchedAt: "", words: "", expected: ["hit"] }));
    const ranked = [5, 6].map((rank) =>
      Array.from({ length: rank }, (_, index) => [index === rank - 1 ? "hit" : "x"]),
    );
    expect(recallOf(cases, ranked)).toEqual({ found: 1, cases: 2, missed: [{ id: 6, rank: 6 }] });
    expect(recallOf(cases, [[], []]).missed).toEqual([
      { id: 5, rank: null },
      { id: 6, rank: null },
    ]);
  });

  test("search finds the message an agent opened, within five hits, no less often than its baseline", () => {
    const fixture = readFixture();
    const db = fixtureRecord(fixture);
    const recall = recallAt5(db, fixture.cases);
    db.close();
    const missed = recall.missed.map(({ id, rank }) => `case ${id} at ${rank ?? "no rank"}`).join(", ");
    console.log(`search recall@5: ${recall.found}/${recall.cases}; missed ${missed}`);
    expect(recall.cases).toBeGreaterThan(0);
    expect(recall.found / recall.cases).toBeGreaterThanOrEqual(BASELINE.found / BASELINE.cases);
  });
});
