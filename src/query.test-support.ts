import { Database } from "bun:sqlite";
import { openDb } from "./db";
import { SCHEMA_SQL } from "./db-schema";
import { scratchEnv, writeClaudeTranscript, writeCodexRollout } from "./fixtures.test-support";
import { probeCheckout } from "./git-probe";
import type { Failure } from "./ingest-contract";
import { ingestCommits } from "./ingest-git";
import { sync } from "./ingest-sync";
import { dbPath } from "./paths";
import type { QueryContext } from "./query-contract";

export const SYNCED_SESSION = "11111111-2222-3333-4444-555555555555";

export function seeded(): Database {
  const db = new Database(":memory:");
  db.run(SCHEMA_SQL);
  db.run(
    `INSERT INTO session (id, tool, cwd, project, ts_first, ts_last)
     VALUES ('s1', 'claude', '/w', '/home/code/demo', '2026-09-01T10:00:00Z', '2026-09-01T11:00:00Z')`,
  );
  db.run(
    `INSERT INTO source_file (path, tool, kind, session_id) VALUES ('/f.jsonl', 'claude', 'transcript', 's1')`,
  );
  db.run(
    `INSERT INTO message (id, session_id, ts, role, text, src_file, src_line)
     VALUES ('m-said', 's1', '2026-09-01T10:30:00Z', 'assistant', ?, '/f.jsonl', 1)`,
    ["Undo what an agent wrote without touching the user's own checkout."],
  );
  db.run(
    `INSERT INTO message (id, session_id, ts, role, text, src_file, src_line, is_meta)
     VALUES ('m-meta', 's1', '2026-09-01T10:31:00Z', 'user', ?, '/f.jsonl', 2, 1)`,
    ["Injected reminder about the checkout."],
  );
  return db;
}

export function recordCommits(db: Database, checkouts: readonly string[], fail: Failure): void {
  ingestCommits(db, checkouts.map(probeCheckout), fail);
}

export const ctx: QueryContext = { arg: "", flags: {}, home: "/home", maxRows: 40 };

export function syncedRecord(root: string): string {
  const env = scratchEnv(root);
  writeClaudeTranscript(env, "-Users-x-code-demo", SYNCED_SESSION);
  writeCodexRollout(env, "sessions", "01a0a651-086e-7150-8650-cef0f4025a58");
  const path = dbPath(env);
  const db = openDb(path);
  sync(db, env);
  db.close();
  return path;
}
