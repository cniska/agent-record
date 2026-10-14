import type { Database } from "bun:sqlite";
import { unreachable } from "./assert";
import { writeTransaction } from "./db";
import { type HookEventRow, parseEventChunk } from "./ingest-parse-events";
import { type ReadResult, readNewLines } from "./ingest-read-new";
import { advance, type Position } from "./ingest-read-plan";

type Columns = {
  readonly $gate: string | null;
  readonly $decision: string | null;
  readonly $reason: string | null;
  readonly $repo: string | null;
  readonly $head: string | null;
  readonly $fingerprint: string | null;
  readonly $verdict: string | null;
  readonly $tool: string | null;
  readonly $toolUse: string | null;
  readonly $rule: string | null;
};

const NO_COLUMNS: Columns = {
  $gate: null,
  $decision: null,
  $reason: null,
  $repo: null,
  $head: null,
  $fingerprint: null,
  $verdict: null,
  $tool: null,
  $toolUse: null,
  $rule: null,
};

function columnsOf(row: HookEventRow): Columns {
  switch (row.event) {
    case "gate":
      return {
        ...NO_COLUMNS,
        $gate: row.gate,
        $decision: row.decision,
        $reason: row.reason,
        $repo: row.repo,
        $head: row.head,
        $fingerprint: row.fingerprint,
      };
    case "verdict":
      return { ...NO_COLUMNS, $verdict: row.verdict, $repo: row.repo, $fingerprint: row.fingerprint };
    case "permission_prompt":
      return { ...NO_COLUMNS, $tool: row.tool };
    case "permission_denied":
      return { ...NO_COLUMNS, $tool: row.tool, $toolUse: row.toolUse, $reason: row.reason, $rule: row.rule };
    default:
      return unreachable(row);
  }
}

export function createEventIngester(db: Database) {
  const selectCursor = db.prepare<Position, [string]>(
    "SELECT bytes_ingested AS bytes, lines_ingested AS lines, NULL AS state FROM event_file WHERE path = ?",
  );
  const upsertCursor = db.prepare<void, [string, number, number]>(
    `INSERT INTO event_file (path, bytes_ingested, lines_ingested) VALUES (?1, ?2, ?3)
     ON CONFLICT(path) DO UPDATE SET bytes_ingested = ?2, lines_ingested = ?3`,
  );
  const deleteEvents = db.prepare<void, [string]>("DELETE FROM hook_event WHERE src_file = ?");
  const insertEvent = db.prepare(
    `INSERT INTO hook_event (src_file, src_line, ts, event, session, agent, cwd, gate, decision, reason,
       repo, head, fingerprint, verdict, tool, tool_use, rule)
     VALUES ($srcFile, $srcLine, $ts, $event, $session, $agent, $cwd, $gate, $decision, $reason,
       $repo, $head, $fingerprint, $verdict, $tool, $toolUse, $rule)`,
  );

  const rewindCursor = db.prepare<void, [string]>(
    "UPDATE event_file SET bytes_ingested = 0, lines_ingested = 0 WHERE path = ?",
  );

  const forget = (path: string): void => {
    deleteEvents.run(path);
    rewindCursor.run(path);
  };

  return {
    cursorOf: (path: string): Position | null => selectCursor.get(path),
    resetLog: (path: string): void => writeTransaction(db, () => forget(path)),
    commit: (path: string, reset: boolean, events: readonly HookEventRow[], to: Position): void =>
      writeTransaction(db, () => {
        if (reset) forget(path);
        upsertCursor.run(path, to.bytes, to.lines);
        for (const row of events) {
          insertEvent.run({
            $srcFile: path,
            $srcLine: row.srcLine,
            $ts: row.ts,
            $event: row.event,
            $session: row.session,
            $agent: row.agent,
            $cwd: row.cwd,
            ...columnsOf(row),
          });
        }
      }),
  };
}

export type EventIngester = ReturnType<typeof createEventIngester>;

export function ingestEventLog(ingester: EventIngester, path: string): ReadResult {
  const { reset, from, chunk } = readNewLines(path, ingester.cursorOf(path));
  if (from === null) {
    if (reset) ingester.resetLog(path);
    return { read: false, dropped: [] };
  }
  const parsed = parseEventChunk(chunk.lines, from.lines + 1);
  ingester.commit(path, reset, parsed.events, advance(from, chunk, null));
  return { read: true, dropped: parsed.dropped };
}
