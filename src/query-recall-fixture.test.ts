import type { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { seeded } from "./query.test-support";
import { rankedCases, recallOf } from "./query-recall.test-support";
import { fixtureOf, fixtureRecord, liveCases } from "./query-recall-fixture.test-support";

const SESSION = "0a1b2c3d-4e5f";

function said(db: Database, id: string, at: string, text: string): void {
  db.run(
    `INSERT INTO message (id, session_id, ts, role, text, src_file, src_line)
     VALUES (?, ?, ?, 'assistant', ?, '/f.jsonl', 20)`,
    [id, SESSION, at, text],
  );
}

function ran(db: Database, id: string, at: string, command: string): void {
  db.run(
    `INSERT INTO tool_call (id, session_id, ts_call, tool_name, command, src_file, src_line_call)
     VALUES (?, ?, ?, 'Bash', ?, '/f.jsonl', 30)`,
    [id, SESSION, at, command],
  );
}

function recordOfUse(): Database {
  const db = seeded();
  db.run("INSERT INTO session (id, tool) VALUES (?, 'claude')", [SESSION]);
  said(db, "m-hit", "2026-09-02T09:00:00.000Z", "We keep the orchard bramble plan.");
  said(db, "m-rival", "2026-09-02T09:10:00.000Z", "The orchard again, with candlewick and more words.");
  said(db, "m-plain", "2026-09-02T09:20:00.000Z", "Nothing to see in this one.");
  said(db, "m-late", "2026-09-04T09:00:00.000Z", "orchard bramble after the search ran");
  ran(db, "t-search", "2026-09-03T10:00:00.000Z", 'agent-record query search "orchard bramble" | head');
  ran(
    db,
    "t-thread",
    "2026-09-03T10:01:00.000Z",
    "agent-record query thread 0a1b2c3d --at 2026-09-02T09:00:00.000Z",
  );
  ran(db, "t-plain", "2026-09-03T10:02:00.000Z", "agent-record query thread 0a1b2c3d --at 2026-09-02T09:20");
  return db;
}

describe("the recall fixture", () => {
  test("take as a case the message an agent opened after a search, when it carries a searched word", () => {
    const db = recordOfUse();
    expect(liveCases(db)).toEqual([
      { id: 1, searchedAt: "2026-09-03T10:00:00.000Z", words: "orchard bramble", expected: ["m-hit"] },
    ]);
    db.close();
  });

  test("hold no word anyone said, yet rank its messages as the record does", () => {
    const db = recordOfUse();
    const cases = liveCases(db);
    const ranked = rankedCases(db, cases);
    const fixture = fixtureOf(db, cases, ranked);
    const text = JSON.stringify(fixture);
    for (const word of ["orchard", "bramble", "candlewick", "keep", "plan"]) expect(text).not.toContain(word);
    expect(fixture.messages.map((message) => message.at)).toEqual([
      "2026-09-02T09:00:00.000Z",
      "2026-09-02T09:10:00.000Z",
    ]);
    const pinned = fixtureRecord(fixture);
    const live = ranked.map((ids) => ids.map((row) => row.map((id) => (id === "m-hit" ? "m1" : "m2"))));
    expect(rankedCases(pinned, fixture.cases)).toEqual(live);
    expect(recallOf(fixture.cases, rankedCases(pinned, fixture.cases))).toEqual(recallOf(cases, ranked));
    pinned.close();
    db.close();
  });
});
