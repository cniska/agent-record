import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { invariant } from "./assert";
import { readingRecord } from "./db-read";
import { NO_WAIT } from "./db-read.test-support";
import { SCHEMA_SQL } from "./db-schema";
import { ctx, SYNCED_SESSION, seeded, syncedRecord } from "./query.test-support";
import type { QueryResult } from "./query-contract";
import { findQuery } from "./query-registry";

const found = findQuery("thread");
invariant(found !== undefined, "the thread query is registered");
const thread = found;

function column(result: QueryResult, name: string): readonly unknown[] {
  const at = result.columns.indexOf(name);
  invariant(at !== -1, `thread prints a ${name} column`);
  return result.rows.map((row) => row[at]);
}

function withActions(): Database {
  const db = seeded();
  db.run(
    `INSERT INTO message (id, session_id, ts, role, text, src_file, src_line, denial_kind, user_feedback)
     VALUES ('m-denied', 's1', '2026-09-01T10:34:00.000Z', 'user', NULL, '/f.jsonl', 5, 'user-rejected', 'not that file')`,
  );
  db.run(
    `INSERT INTO message (id, session_id, ts, role, text, src_file, src_line)
     VALUES ('m-after', 's1', '2026-09-01T10:40:00.000Z', 'assistant', 'Edited the sync instead.', '/f.jsonl', 6)`,
  );
  const call = db.prepare(
    `INSERT INTO tool_call (id, session_id, ts_call, tool_name, file_path, command, is_error, exit_code, is_interrupted, src_file, src_line_call)
     VALUES (?, 's1', ?, ?, ?, ?, ?, ?, ?, '/f.jsonl', ?)`,
  );
  call.run("t-bash", "2026-09-01T10:32:00.000Z", "Bash", null, "bun test\nsrc", 1, 1, 0, 3);
  call.run("t-edit", "2026-09-01T10:33:00.000Z", "Edit", "/w/src/sync.ts", null, 0, null, 0, 4);
  call.run("t-search", "2026-09-01T10:35:00.000Z", "WebSearch", null, null, null, null, 1, 5);
  call.run("t-lost", null, "Read", "/w/no-time.ts", null, null, null, null, 7);
  return db;
}

describe("thread", () => {
  test("reads a whole session one row past the cap, so the cap can say rows were cut", () => {
    const whole = thread.run(withActions(), { ...ctx, arg: "s1", maxRows: 2 });
    expect(column(whole, "text")).toEqual([
      "Undo what an agent wrote without touching the user's own checkout.",
      "Bash: bun test src → exit 1",
      "Edit: /w/src/sync.ts",
    ]);
  });

  test("reads a session whose own id holds an at-sign", () => {
    const db = seeded();
    const id = "a0064e811b74a81cb@79e9c9bc-3a0b-46f6-b935-7a25be925124";
    db.run(
      `INSERT INTO session (id, tool, cwd, project, ts_first, ts_last)
       VALUES (?, 'claude', '/w', '/home/code/demo', '2026-09-01T10:00:00.000Z', '2026-09-01T11:00:00.000Z')`,
      [id],
    );
    db.run(
      `INSERT INTO message (id, session_id, ts, role, text, src_file, src_line)
       VALUES ('m-sub', ?, '2026-09-01T10:45:00.000Z', 'assistant', 'What the delegate settled.', '/f.jsonl', 3)`,
      [id],
    );
    const whole = thread.run(db, { ...ctx, arg: id });
    expect(whole.denominator).toContain("1 messages anyone said");
    expect(whole.denominator).not.toContain("centered on");

    const passage = thread.run(db, { ...ctx, arg: id, flags: { at: "2026-09-01T10:45:00.000Z" } });
    expect(passage.denominator).toContain("centered on 2026-09-01T10:45:00.000Z");
    expect(column(passage, "at")).toEqual(["2026-09-01T10:45:00.000Z"]);

    expect(thread.run(db, { ...ctx, arg: `${id}@2026-09-01T10:45:00.000Z` }).note).toBe(
      `no session starts with ${id}@2026-09-01T10:45:00.000Z`,
    );
    db.close();
  });

  test("reads tool calls and denials between what was said, in time order", () => {
    const db = withActions();
    const whole = thread.run(db, { ...ctx, arg: "s1" });
    expect(column(whole, "role")).toEqual(["assistant", "tool", "tool", "user", "tool", "assistant"]);
    expect(column(whole, "text")).toEqual([
      "Undo what an agent wrote without touching the user's own checkout.",
      "Bash: bun test src → exit 1",
      "Edit: /w/src/sync.ts",
      "denied (user-rejected): not that file",
      "WebSearch → interrupted",
      "Edited the sync instead.",
    ]);
    expect(whole.denominator).toBe(
      "session s1: 2 messages anyone said, 1 denials and 3 tool calls; 1 tool calls with no time are not shown",
    );
    expect(whole.note).toContain("A tool row names its command or file and how it ended, not its result.");
    db.close();
  });

  test("names a tool call whose name never arrived as unnamed", () => {
    const db = seeded();
    db.run(
      `INSERT INTO tool_call (id, session_id, ts_call, tool_name, command, src_file, src_line_call)
       VALUES ('t-nameless', 's1', '2026-09-01T10:32:00.000Z', NULL, 'ls', '/f.jsonl', 3)`,
    );
    expect(column(thread.run(db, { ...ctx, arg: "s1" }), "text")).toContain("(unnamed): ls");
    db.close();
  });

  test("puts what was said before the tool calls made at the same moment", () => {
    const db = withActions();
    db.run(
      `INSERT INTO tool_call (id, session_id, ts_call, tool_name, command, src_file, src_line_call)
       VALUES ('t-same', 's1', '2026-09-01T10:40:00.000Z', 'Bash', 'git commit', '/f.jsonl', 6)`,
    );
    const whole = thread.run(db, { ...ctx, arg: "s1" });
    expect(column(whole, "text").slice(-2)).toEqual(["Edited the sync instead.", "Bash: git commit"]);
    db.close();
  });

  test("centers on --at with half the rows on each side, and says how many it left out", () => {
    const db = withActions();
    const call = db.prepare(
      `INSERT INTO tool_call (id, session_id, ts_call, tool_name, file_path, src_file)
       VALUES (?, 's1', ?, 'Read', ?, '/f.jsonl')`,
    );
    for (let minute = 10; minute < 30; minute += 1) {
      call.run(`t-read-${minute}`, `2026-09-01T10:${minute}:00Z`, `/w/before-${minute}.ts`);
    }
    const passage = thread.run(db, {
      ...ctx,
      arg: "s1",
      flags: { at: "2026-09-01T10:34:00.000Z" },
      maxRows: 4,
    });
    expect(column(passage, "text")).toEqual([
      "Edit: /w/src/sync.ts",
      "denied (user-rejected): not that file",
      "WebSearch → interrupted",
      "Edited the sync instead.",
    ]);
    expect(passage.denominator).toEndWith(
      "centered on 2026-09-01T10:34:00.000Z; 22 earlier and 0 later rows not shown, --rows <n> to widen; 1 tool calls with no time are not shown",
    );

    const wide = thread.run(db, {
      ...ctx,
      arg: "s1",
      flags: { at: "2026-09-01T10:34:00.000Z" },
      maxRows: 60,
    });
    expect(wide.denominator).toEndWith(
      "centered on 2026-09-01T10:34:00.000Z; 1 tool calls with no time are not shown",
    );
    db.close();
  });

  test("reads an --at given to the minute, with Z or an offset, as that instant", () => {
    const db = withActions();
    const centeredOn = (at: string) => thread.run(db, { ...ctx, arg: "s1", flags: { at } }).denominator;
    const toTheSecond = centeredOn("2026-09-01T10:34:00.000Z");
    expect(toTheSecond).toContain("centered on 2026-09-01T10:34:00.000Z");
    expect(centeredOn("2026-09-01T10:34Z")).toBe(toTheSecond);
    expect(centeredOn("2026-09-01T12:34+02:00")).toBe(toTheSecond);
    db.close();
  });

  test.each(["yesterday", "2026-09-01T10:34", "2026-09-01T10:34:00", "2026-09-01", "2026-09-01T10Z"])(
    "refuses an --at of %p, naming the shape it takes",
    (at) => {
      const db = seeded();
      expect(() => thread.run(db, { ...ctx, arg: "s1", flags: { at } })).toThrow(
        expect.objectContaining({
          code: "not_a_time",
          message: `--at ${at} is not a time`,
          meta: { flag: "at", value: at },
          resolve:
            "--at <ts>, an ISO time with Z or an offset, to the minute or finer, such as 2026-09-01T10:30Z",
          kind: "refusal",
        }),
      );
      db.close();
    },
  );

  test("refuses a prefix two sessions share, naming them rather than picking one", () => {
    const db = seeded();
    db.run("INSERT INTO session (id, tool) VALUES ('s2', 'claude')");
    expect(() => thread.run(db, { ...ctx, arg: "s" })).toThrow(
      expect.objectContaining({
        code: "ambiguous_session",
        message: "s matches more than one session, among them s1 and s2",
        meta: { prefix: "s", matches: ["s1", "s2"] },
        resolve: "agent-record query thread <a longer prefix of one of: s1, s2>",
        kind: "refusal",
      }),
    );
    db.close();
  });

  test("matches an id prefix holding SQL wildcard characters as written", () => {
    const db = new Database(":memory:");
    try {
      db.run(SCHEMA_SQL);
      db.run("INSERT INTO session (id, tool) VALUES ('ab-1', 'claude'), ('aXb-2', 'claude')");
      const run = (arg: string) => thread.run(db, { ...ctx, arg });

      expect(run("a_").note).toBe("no session starts with a_");
      expect(run("a%")).toMatchObject({ columns: ["at", "role", "skill", "text"], rows: [] });
      expect(run("AB").denominator).toStartWith("session ab-1:");
    } finally {
      db.close();
    }
  });

  test("reads what was said, and centers on a timestamp when given one", () => {
    const root = mkdtempSync(join(tmpdir(), "agent-record-q-"));
    try {
      readingRecord(syncedRecord(root), NO_WAIT, (db) => {
        const whole = thread.run(db, { ...ctx, arg: SYNCED_SESSION.slice(0, 8) });
        expect(whole.rows.length).toBeGreaterThan(0);
        const texts = whole.rows.map((r) => String(r[3]));
        expect(texts.every((t) => t.length > 0)).toBe(true);

        const centered = thread.run(db, {
          ...ctx,
          arg: SYNCED_SESSION.slice(0, 8),
          flags: { at: "2026-09-16T10:04:00.000Z" },
        });
        expect(centered.denominator).toContain("centered on");

        const missing = thread.run(db, { ...ctx, arg: "zzzzzzzz" });
        expect(missing.rows).toEqual([]);
        expect(missing.note).toContain("no session starts with");
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
