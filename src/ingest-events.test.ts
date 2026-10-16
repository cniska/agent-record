import type { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { openDb, readRows } from "./db";
import { NO_WAIT_MS } from "./db-read.test-support";
import { createEventIngester, ingestEventLog } from "./ingest-events";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function scratch(): { readonly db: Database; readonly log: string } {
  const root = mkdtempSync(join(tmpdir(), "agent-record-events-"));
  roots.push(root);
  mkdirSync(join(root, "plugin"), { recursive: true });
  return {
    db: openDb(join(root, "sessions.db"), { heldRecordWaitMs: NO_WAIT_MS }),
    log: join(root, "plugin", "events.jsonl"),
  };
}

const prompt = (ts: string): string =>
  `${JSON.stringify({ v: 1, ts, event: "permission_prompt", session: "s1", agent: null, cwd: "/w", tool: "Bash" })}\n`;

const rows = (db: Database) =>
  readRows(db, "SELECT src_line, ts FROM hook_event ORDER BY src_line")
    .all(z.strictObject({ src_line: z.number(), ts: z.string() }))
    .map(({ src_line, ts }) => [src_line, ts]);

describe("reading a hook event log", () => {
  test("reads only the complete lines added since the last read", () => {
    const { db, log } = scratch();
    const ingester = createEventIngester(db);
    writeFileSync(log, prompt("2026-10-14T08:00:00Z"));
    expect(ingestEventLog(ingester, log)).toEqual({ read: true, dropped: [] });

    appendFileSync(log, `${prompt("2026-10-14T08:01:00Z")}{"v":1,"ts":"2026-10-14T08:02:00Z"`);
    ingestEventLog(ingester, log);
    expect(ingestEventLog(ingester, log)).toEqual({ read: false, dropped: [] });

    expect(rows(db)).toEqual([
      [1, "2026-10-14T08:00:00.000Z"],
      [2, "2026-10-14T08:01:00.000Z"],
    ]);
  });

  test("reports the lines it dropped by their line in the file", () => {
    const { db, log } = scratch();
    writeFileSync(log, `${prompt("2026-10-14T08:00:00Z")}{broken\n`);
    expect(ingestEventLog(createEventIngester(db), log)).toEqual({ read: true, dropped: [2] });
  });

  test("forgets the events of a log that shrank and reads it again from the start", () => {
    const { db, log } = scratch();
    const ingester = createEventIngester(db);
    writeFileSync(log, prompt("2026-10-14T08:00:00Z") + prompt("2026-10-14T08:01:00Z"));
    ingestEventLog(ingester, log);

    writeFileSync(log, prompt("2026-10-14T09:00:00Z"));
    ingestEventLog(ingester, log);
    expect(rows(db)).toEqual([[1, "2026-10-14T09:00:00.000Z"]]);
  });

  test("forgets a log's events when its archive copy is replaced, then reads the copy whole", () => {
    const { db, log } = scratch();
    const ingester = createEventIngester(db);
    writeFileSync(log, prompt("2026-10-14T08:00:00Z"));
    ingestEventLog(ingester, log);

    ingester.markReplaced(log);
    ingester.markReplaced(`${log}.other`);
    expect(rows(db)).toEqual([[1, "2026-10-14T08:00:00.000Z"]]);
    expect(db.query("SELECT path, copy_replaced FROM event_file").all()).toEqual([
      { path: log, copy_replaced: 1 },
    ]);
    writeFileSync(log, prompt("2026-10-14T10:00:00Z") + prompt("2026-10-14T10:01:00Z"));
    ingestEventLog(ingester, log);
    expect(rows(db)).toEqual([
      [1, "2026-10-14T10:00:00.000Z"],
      [2, "2026-10-14T10:01:00.000Z"],
    ]);
    expect(db.query("SELECT path, copy_replaced FROM event_file").all()).toEqual([
      { path: log, copy_replaced: 0 },
    ]);
  });
});
