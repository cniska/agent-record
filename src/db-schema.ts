import { DECISIONS, GATES, HOOK_EVENTS, VERDICTS } from "./ingest-event-kinds";
import { ROLES } from "./ingest-session-records";
import { HOWS } from "./ingest-skill-load";
import { KINDS, TOOLS } from "./ingest-tools";

const sqlList = (values: readonly string[]): string => values.map((value) => `'${value}'`).join(",");
export const SCHEMA_VERSION = 16;

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS source_file (
  path            TEXT PRIMARY KEY,
  tool            TEXT NOT NULL CHECK (tool IN (${sqlList(TOOLS)})),
  kind            TEXT NOT NULL CHECK (kind IN (${sqlList(KINDS)})),
  session_id      TEXT NOT NULL,
  bytes_ingested  INTEGER NOT NULL DEFAULT 0,
  lines_ingested  INTEGER NOT NULL DEFAULT 0,
  cursor_state    TEXT,
  ingested_at     TEXT
);
CREATE INDEX IF NOT EXISTS source_file_session ON source_file(session_id, kind);

CREATE TABLE IF NOT EXISTS session (
  id              TEXT PRIMARY KEY,
  tool            TEXT NOT NULL CHECK (tool IN (${sqlList(TOOLS)})),
  parent_id       TEXT REFERENCES session(id),
  agent_type      TEXT,
  spawn_call      TEXT,
  cwd             TEXT,
  worktree        TEXT,
  project         TEXT,
  git_branch      TEXT,
  cli_version     TEXT,
  entrypoint      TEXT,
  ts_first        TEXT,
  ts_last         TEXT,
  title           TEXT
);
CREATE INDEX IF NOT EXISTS session_project ON session(project, ts_first);
CREATE INDEX IF NOT EXISTS session_parent ON session(parent_id);

CREATE TABLE IF NOT EXISTS message (
  id              TEXT PRIMARY KEY,
  session_id      TEXT NOT NULL REFERENCES session(id),
  ts              TEXT NOT NULL,
  role            TEXT NOT NULL CHECK (role IN (${sqlList(ROLES)})),
  model           TEXT,
  turn_id         TEXT,
  prompt_source   TEXT,
  origin_kind     TEXT,
  is_meta         INTEGER NOT NULL DEFAULT 0,
  is_skill_body   INTEGER NOT NULL DEFAULT 0,
  attribution_skill TEXT,
  slash_command    TEXT,
  denial_kind     TEXT,
  user_feedback   TEXT,
  text            TEXT,
  text_chars      INTEGER,
  src_file        TEXT NOT NULL REFERENCES source_file(path) ON UPDATE CASCADE,
  src_line        INTEGER NOT NULL,
  extra           TEXT
);
CREATE INDEX IF NOT EXISTS message_session_ts ON message(session_id, ts);
CREATE INDEX IF NOT EXISTS message_attr ON message(attribution_skill);
CREATE INDEX IF NOT EXISTS message_src_file ON message(src_file);

CREATE TABLE IF NOT EXISTS usage (
  response_id     TEXT PRIMARY KEY,
  session_id      TEXT NOT NULL REFERENCES session(id),
  message_id      TEXT REFERENCES message(id),
  ts              TEXT NOT NULL,
  model           TEXT,
  input_tokens    INTEGER NOT NULL,
  cache_read_tokens   INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens  INTEGER NOT NULL DEFAULT 0,
  output_tokens   INTEGER NOT NULL,
  attribution_skill TEXT
);
CREATE INDEX IF NOT EXISTS usage_session ON usage(session_id, ts);
CREATE INDEX IF NOT EXISTS usage_model ON usage(model);
CREATE INDEX IF NOT EXISTS usage_message ON usage(message_id);

CREATE TABLE IF NOT EXISTS turn (
  session_id      TEXT NOT NULL REFERENCES session(id),
  turn_id         TEXT NOT NULL,
  ts_start        TEXT,
  ts_end          TEXT,
  duration_ms     INTEGER,
  message_count   INTEGER,
  status          TEXT,
  model           TEXT,
  time_to_first_token_ms INTEGER,
  PRIMARY KEY (session_id, turn_id)
);
CREATE INDEX IF NOT EXISTS turn_session ON turn(session_id, ts_end);

CREATE TABLE IF NOT EXISTS compaction (
  session_id      TEXT NOT NULL REFERENCES session(id),
  ts              TEXT NOT NULL,
  src_file        TEXT NOT NULL REFERENCES source_file(path) ON UPDATE CASCADE,
  src_line        INTEGER NOT NULL,
  PRIMARY KEY (src_file, src_line)
);
CREATE INDEX IF NOT EXISTS compaction_session ON compaction(session_id, ts);

CREATE TABLE IF NOT EXISTS tool_call (
  id              TEXT PRIMARY KEY,
  session_id      TEXT NOT NULL REFERENCES session(id),
  message_id      TEXT REFERENCES message(id),
  model           TEXT,
  attribution_skill TEXT,
  ts_call         TEXT,
  ts_result       TEXT,
  tool_name       TEXT,
  skill_name      TEXT,
  file_path       TEXT,
  command         TEXT,
  is_error        INTEGER,
  is_interrupted  INTEGER,
  exit_code       INTEGER,
  duration_ms     INTEGER,
  result_bytes    INTEGER,
  src_file        TEXT NOT NULL REFERENCES source_file(path) ON UPDATE CASCADE,
  src_line_call   INTEGER,
  src_line_result INTEGER
);
CREATE INDEX IF NOT EXISTS tool_call_session ON tool_call(session_id, ts_call);
CREATE INDEX IF NOT EXISTS tool_call_name ON tool_call(tool_name);
CREATE INDEX IF NOT EXISTS tool_call_file ON tool_call(file_path);
CREATE INDEX IF NOT EXISTS tool_call_src_file ON tool_call(src_file);
CREATE INDEX IF NOT EXISTS tool_call_message ON tool_call(message_id);

CREATE TABLE IF NOT EXISTS git_command (
  tool_call_id    TEXT NOT NULL REFERENCES tool_call(id) ON DELETE CASCADE,
  position        INTEGER NOT NULL,
  subcommand      TEXT NOT NULL,
  dir             TEXT,
  PRIMARY KEY (tool_call_id, position)
);
CREATE INDEX IF NOT EXISTS git_command_sub ON git_command(subcommand);

CREATE TABLE IF NOT EXISTS skill_load (
  session_id      TEXT NOT NULL REFERENCES session(id),
  message_id      TEXT REFERENCES message(id),
  tool_call_id    TEXT REFERENCES tool_call(id),
  anchor_id       TEXT NOT NULL AS (coalesce(message_id, tool_call_id)),
  ts              TEXT NOT NULL,
  model           TEXT,
  skill_name      TEXT NOT NULL,
  how             TEXT NOT NULL CHECK (how IN (${sqlList(HOWS)})),
  body_chars      INTEGER,
  body_sha256     TEXT,
  skill_path      TEXT,
  install         TEXT,
  UNIQUE (session_id, anchor_id, skill_name, how),
  CHECK ((message_id IS NULL) <> (tool_call_id IS NULL))
);
CREATE INDEX IF NOT EXISTS skill_load_name ON skill_load(skill_name, ts);
CREATE INDEX IF NOT EXISTS skill_load_message ON skill_load(message_id);
CREATE INDEX IF NOT EXISTS skill_load_tool_call ON skill_load(tool_call_id);

CREATE TABLE IF NOT EXISTS repo_commit (
  sha             TEXT PRIMARY KEY,
  repo            TEXT NOT NULL,
  label           TEXT,
  ts              TEXT NOT NULL,
  author          TEXT,
  subject         TEXT NOT NULL,
  kind            TEXT
);
CREATE INDEX IF NOT EXISTS repo_commit_repo_ts ON repo_commit(repo, ts);

CREATE TABLE IF NOT EXISTS commit_file (
  sha             TEXT NOT NULL REFERENCES repo_commit(sha) ON DELETE CASCADE,
  path            TEXT NOT NULL,
  PRIMARY KEY (sha, path)
);
CREATE INDEX IF NOT EXISTS commit_file_path ON commit_file(path);

CREATE TABLE IF NOT EXISTS repo_file (
  checkout        TEXT NOT NULL,
  path            TEXT NOT NULL,
  PRIMARY KEY (checkout, path)
);
CREATE INDEX IF NOT EXISTS repo_file_path ON repo_file(path);

CREATE TABLE IF NOT EXISTS checkout (
  path            TEXT PRIMARY KEY,
  repo            TEXT NOT NULL,
  head            TEXT,
  index_stat      TEXT
);

CREATE TABLE IF NOT EXISTS event_file (
  path            TEXT PRIMARY KEY,
  bytes_ingested  INTEGER NOT NULL DEFAULT 0,
  lines_ingested  INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS hook_event (
  src_file        TEXT NOT NULL REFERENCES event_file(path),
  src_line        INTEGER NOT NULL,
  ts              TEXT NOT NULL,
  event           TEXT NOT NULL CHECK (event IN (${sqlList(HOOK_EVENTS)})),
  session         TEXT NOT NULL,
  agent           TEXT,
  cwd             TEXT,
  gate            TEXT CHECK (gate IN (${sqlList(GATES)})),
  decision        TEXT CHECK (decision IN (${sqlList(DECISIONS)})),
  reason          TEXT,
  repo            TEXT,
  head            TEXT,
  fingerprint     TEXT,
  verdict         TEXT CHECK (verdict IN (${sqlList(VERDICTS)})),
  tool            TEXT,
  tool_use        TEXT,
  rule            TEXT,
  tag_key         TEXT,
  tag_value       TEXT,
  PRIMARY KEY (src_file, src_line),
  CHECK (event <> 'gate' OR (gate IS NOT NULL AND decision IS NOT NULL AND reason IS NOT NULL)),
  CHECK (event <> 'verdict' OR (verdict IS NOT NULL AND repo IS NOT NULL AND fingerprint IS NOT NULL)),
  CHECK (event <> 'permission_prompt' OR tool IS NOT NULL),
  CHECK (event <> 'permission_denied' OR (tool IS NOT NULL AND reason IS NOT NULL)),
  CHECK (event <> 'tag' OR (tag_key IS NOT NULL AND tag_value IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS hook_event_ts ON hook_event(ts);

CREATE VIRTUAL TABLE IF NOT EXISTS message_fts USING fts5(
  text,
  content = 'message',
  content_rowid = 'rowid',
  tokenize = 'unicode61'
);

CREATE TRIGGER IF NOT EXISTS message_fts_insert AFTER INSERT ON message BEGIN
  INSERT INTO message_fts (rowid, text) VALUES (new.rowid, new.text);
END;
CREATE TRIGGER IF NOT EXISTS message_fts_delete AFTER DELETE ON message BEGIN
  INSERT INTO message_fts (message_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
END;
CREATE TRIGGER IF NOT EXISTS message_fts_update AFTER UPDATE ON message WHEN old.text IS NOT new.text BEGIN
  INSERT INTO message_fts (message_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
  INSERT INTO message_fts (rowid, text) VALUES (new.rowid, new.text);
END;
`;
