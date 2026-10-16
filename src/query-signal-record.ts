import type { Database } from "bun:sqlite";
import { z } from "zod";
import { invariant, unreachable } from "./assert";
import { readRows, SqlFlag } from "./db";
import {
  Counted,
  DECISIONS,
  type Decision,
  GATES,
  type Gate,
  HOOK_EVENTS,
  VERDICTS,
  type Verdict,
} from "./ingest-event-kinds";
import { MID_TURN_PROMPT } from "./ingest-session-records";
import type { HOWS } from "./ingest-skill-load";
import { TOOLS } from "./ingest-tools";
import { callFailureSql } from "./query";
import { ESCAPE_REACH_DAYS } from "./query-escaped-defects";
import { AGENT_TAIL_CHARS, INTERRUPTED } from "./query-interrupt";

const text = z.string();
const maybeText = z.string().nullable();

const SessionRow = z.strictObject({
  id: text,
  parentId: maybeText,
  tool: z.enum(TOOLS),
  project: maybeText,
  start: maybeText,
  end: maybeText,
  agentType: maybeText,
});
export type SessionRow = Readonly<z.infer<typeof SessionRow>>;

const opening = { id: text, turnId: maybeText, sessionId: text, text };

const OpeningRow = z.strictObject(opening);
export type OpeningRow = Readonly<z.infer<typeof OpeningRow>>;

const OwnerMessageRow = z.strictObject({ ...opening, at: text, agentBefore: maybeText, midTurn: SqlFlag });
export type OwnerMessageRow = Readonly<z.infer<typeof OwnerMessageRow>>;

const timed = { sessionId: text, at: text };

const TimedRow = z.strictObject(timed);
export type TimedRow = Readonly<z.infer<typeof TimedRow>>;

const GitRunRow = z.strictObject({
  ...timed,
  subcommand: z.enum(["commit", "push"]),
  dir: text,
  callAt: maybeText,
  commitsInCall: z.number(),
  command: text,
});
export type GitRunRow = Readonly<z.infer<typeof GitRunRow>>;

const ReadRow = z.strictObject({ ...timed, path: text });
export type ReadRow = Readonly<z.infer<typeof ReadRow>>;

const CheckoutRow = z.strictObject({ path: text, repo: text });
export type CheckoutRow = Readonly<z.infer<typeof CheckoutRow>>;

const CommitRow = z.strictObject({ sha: text, repo: text, at: text, subject: text, kind: maybeText });
export type CommitRow = Readonly<z.infer<typeof CommitRow>>;

const CommitFileRow = z.strictObject({ sha: text, path: text });
export type CommitFileRow = Readonly<z.infer<typeof CommitFileRow>>;

const LoadRow = z.strictObject({
  ...timed,
  skill: text,
  bodySha256: maybeText,
  install: maybeText,
  preloaded: SqlFlag,
});
export type LoadRow = Readonly<z.infer<typeof LoadRow>>;

const ResponseRow = z.strictObject({ ...timed, output: z.number(), input: z.number() });
export type ResponseRow = Readonly<z.infer<typeof ResponseRow>>;

const TagRow = z.strictObject({ ...timed, key: text, value: text });
type TagRow = Readonly<z.infer<typeof TagRow>>;

const TAG = "tag";

const HookColumns = z.strictObject({
  at: text,
  event: z.enum(HOOK_EVENTS).exclude([TAG]),
  sessionId: text,
  agent: maybeText,
  gate: z.enum(GATES).nullable(),
  decision: z.enum(DECISIONS).nullable(),
  reason: maybeText,
  repo: maybeText,
  head: maybeText,
  fingerprint: maybeText,
  verdict: z.enum(VERDICTS).nullable(),
  counted: maybeText,
});
type HookColumns = Readonly<z.infer<typeof HookColumns>>;

const LabelRow = z.strictObject({ repo: text, label: text });

const NewestRow = z.strictObject({ ts: maybeText });

type HookActor = { readonly at: string; readonly sessionId: string; readonly agent: string | null };

export type GateRow = HookActor & {
  readonly event: "gate";
  readonly gate: Gate;
  readonly decision: Decision;
  readonly reason: string;
  readonly repo: string | null;
  readonly head: string | null;
  readonly fingerprint: string | null;
};

export type VerdictRow = HookActor & {
  readonly event: "verdict";
  readonly verdict: Verdict;
  readonly repo: string;
  readonly fingerprint: string;
  readonly counted: Counted | null;
};

export type HookRow =
  | GateRow
  | VerdictRow
  | (HookActor & { readonly event: "permission_prompt" })
  | (HookActor & { readonly event: "permission_denied"; readonly reason: string });

function hookRowOf(columns: HookColumns): HookRow {
  const { at, sessionId, agent } = columns;
  switch (columns.event) {
    case "gate": {
      const { gate, decision, reason, repo, head, fingerprint } = columns;
      invariant(gate !== null && decision !== null && reason !== null, "a gate event has its gate fields");
      return { at, sessionId, agent, event: "gate", gate, decision, reason, repo, head, fingerprint };
    }
    case "verdict": {
      const { verdict, repo, fingerprint, counted } = columns;
      invariant(verdict !== null && repo !== null && fingerprint !== null, "a verdict event has its fields");
      return {
        at,
        sessionId,
        agent,
        event: "verdict",
        verdict,
        repo,
        fingerprint,
        counted: counted === null ? null : Counted.parse(JSON.parse(counted)),
      };
    }
    case "permission_prompt":
      return { at, sessionId, agent, event: "permission_prompt" };
    case "permission_denied":
      invariant(columns.reason !== null, "an auto-mode denial has its reason");
      return { at, sessionId, agent, event: "permission_denied", reason: columns.reason };
    default:
      return unreachable(columns.event);
  }
}

export type SignalRecord = {
  readonly sessions: readonly SessionRow[];
  readonly ownerMessages: readonly OwnerMessageRow[];
  readonly openings: readonly OpeningRow[];
  readonly rejections: readonly TimedRow[];
  readonly gitRuns: readonly GitRunRow[];
  readonly compactions: readonly TimedRow[];
  readonly compactedSessionReads: readonly ReadRow[];
  readonly hookEvents: readonly HookRow[];
  readonly tags: readonly TagRow[];
  readonly skillLoads: readonly LoadRow[];
  readonly responses: readonly ResponseRow[];
  readonly subagentReturns: readonly TimedRow[];
  readonly checkouts: readonly CheckoutRow[];
  readonly commits: readonly CommitRow[];
  readonly commitFiles: readonly CommitFileRow[];
  readonly labels: ReadonlyMap<string, string>;
  readonly newest: string | null;
};

const READ_TOOL = "Read";

const INTERRUPTED_MARKER = `${INTERRUPTED}%`;

const OWNER = `s.parent_id IS NULL AND m.role = 'user' AND m.is_meta = 0 AND m.text IS NOT NULL
  AND m.denial_kind IS NULL AND (
    (s.tool = 'claude' AND (m.origin_kind = 'human'
      OR (m.origin_kind IS NULL AND m.prompt_source IN ('typed', 'queued'))
      OR m.text LIKE '${INTERRUPTED_MARKER}'))
    OR (s.tool = 'codex' AND m.prompt_source = 'typed' AND s.entrypoint IS NOT 'codex_exec')
    OR s.tool IN ('grok', 'pi', 'omp'))`;

const AGENT_BEFORE = `(SELECT substr(a.text, -${AGENT_TAIL_CHARS}) FROM message a
  WHERE a.session_id = m.session_id AND a.role = 'assistant' AND a.text IS NOT NULL AND a.text <> ''
    AND a.ts < m.ts
  ORDER BY a.ts DESC LIMIT 1)`;

const SUCCEEDED = `c.ts_result IS NOT NULL AND ${callFailureSql("c")} IS NULL`;

const PRELOAD = "preload" satisfies (typeof HOWS)[number];

const SUBAGENT_TOOL = "Agent";

function readOwnerMessages(
  db: Database,
  where: string,
  params: readonly string[],
): readonly OwnerMessageRow[] {
  return readRows<string[]>(
    db,
    `SELECT m.id, m.turn_id AS turnId, m.session_id AS sessionId, m.ts AS at, m.text,
            ${AGENT_BEFORE} AS agentBefore, m.prompt_source IS ? AS midTurn
     FROM message m JOIN session s ON s.id = m.session_id
     WHERE ${where} ORDER BY m.ts`,
  ).all(OwnerMessageRow, MID_TURN_PROMPT, ...params);
}

const FIRST_USER = (where: string) => `SELECT sessionId, id, turnId, text FROM (
  SELECT m.session_id AS sessionId, m.id, m.turn_id AS turnId, m.text,
    row_number() OVER (PARTITION BY m.session_id ORDER BY m.ts, m.src_line) AS n
  FROM message m JOIN session s ON s.id = m.session_id
  WHERE s.parent_id IS NULL AND m.role = 'user' AND m.is_meta = 0 AND m.text IS NOT NULL AND m.text <> ''
    AND ${where}
) WHERE n = 1`;

export const openingOf = (db: Database, sessionId: string): OpeningRow | null =>
  readRows<[string]>(db, FIRST_USER("m.session_id = ?1")).get(OpeningRow, sessionId);

export const ownerMessagesOf = (db: Database, sessionId: string): readonly OwnerMessageRow[] =>
  readOwnerMessages(db, `${OWNER} AND m.session_id = ?`, [sessionId]);

export function readSignalRecord(db: Database): SignalRecord {
  const sessions = readRows(
    db,
    `SELECT id, parent_id AS parentId, tool, project, ts_first AS start, ts_last AS end, agent_type AS agentType
       FROM session`,
  ).all(SessionRow);
  const ownerMessages = readOwnerMessages(db, OWNER, []);
  const openings = readRows(db, FIRST_USER("1")).all(OpeningRow);
  const rejections = readRows(
    db,
    `SELECT session_id AS sessionId, ts AS at FROM message WHERE denial_kind = 'user-rejected' ORDER BY ts`,
  ).all(TimedRow);
  const gitRuns = readRows(
    db,
    `SELECT c.session_id AS sessionId, c.ts_result AS at, g.subcommand, g.dir,
              c.ts_call AS callAt, c.command,
              (SELECT count(*) FROM git_command x WHERE x.tool_call_id = c.id AND x.subcommand = 'commit')
                AS commitsInCall
       FROM git_command g JOIN tool_call c ON c.id = g.tool_call_id
       WHERE g.subcommand IN ('commit', 'push') AND g.dir IS NOT NULL AND ${SUCCEEDED}
       ORDER BY c.ts_result`,
  ).all(GitRunRow);
  const compactions = readRows(
    db,
    "SELECT session_id AS sessionId, ts AS at FROM compaction ORDER BY ts",
  ).all(TimedRow);
  const compactedSessionReads = readRows<[string]>(
    db,
    `SELECT session_id AS sessionId, ts_call AS at, file_path AS path FROM tool_call
       WHERE tool_name = ? AND file_path IS NOT NULL AND ts_call IS NOT NULL
         AND session_id IN (SELECT session_id FROM compaction)
       ORDER BY ts_call`,
  ).all(ReadRow, READ_TOOL);
  const hookEvents = readRows<[string]>(
    db,
    `SELECT ts AS at, event, session AS sessionId, agent, gate, decision, reason, repo, head, fingerprint, verdict, counted
       FROM hook_event WHERE event <> ? ORDER BY ts, src_file, src_line`,
  )
    .all(HookColumns, TAG)
    .map(hookRowOf);
  const tags = readRows<[string]>(
    db,
    `SELECT session AS sessionId, ts AS at, tag_key AS key, tag_value AS value
       FROM hook_event WHERE event = ? ORDER BY ts, src_file, src_line`,
  ).all(TagRow, TAG);
  const skillLoads = readRows<[string]>(
    db,
    `SELECT session_id AS sessionId, ts AS at, skill_name AS skill, body_sha256 AS bodySha256, install,
            how = ? AS preloaded
     FROM skill_load ORDER BY ts`,
  ).all(LoadRow, PRELOAD);
  const responses = readRows(
    db,
    `SELECT session_id AS sessionId, ts AS at, output_tokens AS output,
              input_tokens + cache_read_tokens + cache_write_tokens AS input
       FROM usage ORDER BY session_id, ts, response_id`,
  ).all(ResponseRow);
  const subagentReturns = readRows<[string]>(
    db,
    `SELECT session_id AS sessionId, ts_result AS at FROM tool_call
       WHERE tool_name = ? AND ts_result IS NOT NULL ORDER BY ts_result`,
  ).all(TimedRow, SUBAGENT_TOOL);
  const checkouts = readRows(db, "SELECT path, repo FROM checkout").all(CheckoutRow);
  const commits = readRows(
    db,
    "SELECT sha, repo, ts AS at, subject, kind FROM repo_commit ORDER BY ts, sha",
  ).all(CommitRow);
  const firstHook = hookEvents[0]?.at ?? null;
  const commitFiles =
    firstHook === null
      ? []
      : readRows<[string]>(
          db,
          `SELECT f.sha, f.path FROM commit_file f JOIN repo_commit c ON c.sha = f.sha
             WHERE c.ts >= strftime('%Y-%m-%dT%H:%M:%fZ', ?, '-${ESCAPE_REACH_DAYS} days')`,
        ).all(CommitFileRow, firstHook);
  const labels = new Map(
    readRows(db, "SELECT repo, max(label) AS label FROM repo_commit WHERE label IS NOT NULL GROUP BY repo")
      .all(LabelRow)
      .map(({ repo, label }) => [repo, label]),
  );
  const newest = readRows(db, "SELECT max(ts) AS ts FROM message").get(NewestRow)?.ts ?? null;
  return {
    sessions,
    ownerMessages,
    openings,
    rejections,
    gitRuns,
    compactions,
    compactedSessionReads,
    hookEvents,
    tags,
    skillLoads,
    responses,
    subagentReturns,
    checkouts,
    commits,
    commitFiles,
    labels,
    newest,
  };
}
