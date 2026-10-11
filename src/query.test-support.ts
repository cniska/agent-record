import { Database } from "bun:sqlite";
import { SCHEMA_SQL } from "./db-schema";
import type { QueryContext } from "./query";

export function seeded(): Database {
  const db = new Database(":memory:");
  db.run(SCHEMA_SQL);
  db.run(
    `INSERT INTO session (id, tool, cwd, project, started_at, last_seen_at)
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

export const ctx: QueryContext = { arg: null, home: "/home", maxRows: 40 };
