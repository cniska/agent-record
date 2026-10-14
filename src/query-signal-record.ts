import type { Database } from "bun:sqlite";
import { invariant, unreachable } from "./assert";
import type { Decision, Gate, HookEvent, Verdict } from "./ingest-event-kinds";
import { MID_TURN_PROMPT } from "./ingest-session-records";
import type { HOWS } from "./ingest-skill-load";
import type { Tool } from "./ingest-tools";
import { callFailureSql } from "./query";
import { ESCAPE_REACH_DAYS } from "./query-escaped-defects";
import { AGENT_TAIL_CHARS, INTERRUPTED } from "./query-interrupt";

export type SessionRow = {
  readonly id: string;
  readonly parentId: string | null;
  readonly tool: Tool;
  readonly project: string | null;
  readonly start: string | null;
  readonly end: string | null;
  readonly agentType: string | null;
};

type OwnerMessageRow = {
  readonly sessionId: string;
  readonly at: string;
  readonly text: string;
  readonly agentBefore: string | null;
  readonly midTurn: boolean;
};

export type TimedRow = { readonly sessionId: string; readonly at: string };

export type GitRunRow = TimedRow & { readonly subcommand: "commit" | "push"; readonly dir: string };

export type ReadRow = TimedRow & { readonly path: string };

export type CheckoutRow = { readonly path: string; readonly repo: string };

export type CommitRow = {
  readonly sha: string;
  readonly repo: string;
  readonly at: string;
  readonly subject: string;
  readonly kind: string | null;
};

export type CommitFileRow = { readonly sha: string; readonly path: string };

export type LoadRow = TimedRow & {
  readonly skill: string;
  readonly bodySha256: string | null;
  readonly install: string | null;
  readonly preloaded: boolean;
};

export type ResponseRow = TimedRow & { readonly output: number; readonly input: number };

type HookColumns = {
  readonly at: string;
  readonly event: HookEvent;
  readonly sessionId: string;
  readonly agent: string | null;
  readonly gate: Gate | null;
  readonly decision: Decision | null;
  readonly reason: string | null;
  readonly repo: string | null;
  readonly head: string | null;
  readonly fingerprint: string | null;
  readonly verdict: Verdict | null;
};

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
      const { verdict, repo, fingerprint } = columns;
      invariant(verdict !== null && repo !== null && fingerprint !== null, "a verdict event has its fields");
      return { at, sessionId, agent, event: "verdict", verdict, repo, fingerprint };
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
  readonly rejections: readonly TimedRow[];
  readonly gitRuns: readonly GitRunRow[];
  readonly routeReads: readonly ReadRow[];
  readonly compactions: readonly TimedRow[];
  readonly compactedSessionReads: readonly ReadRow[];
  readonly hookEvents: readonly HookRow[];
  readonly skillLoads: readonly LoadRow[];
  readonly responses: readonly ResponseRow[];
  readonly subagentReturns: readonly TimedRow[];
  readonly checkouts: readonly CheckoutRow[];
  readonly commits: readonly CommitRow[];
  readonly commitFiles: readonly CommitFileRow[];
  readonly labels: ReadonlyMap<string, string>;
  readonly newest: string | null;
};

const ROUTES_DIR = "/skills/task/references/";

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

export function readSignalRecord(db: Database): SignalRecord {
  const sessions = db
    .query<SessionRow, []>(
      `SELECT id, parent_id AS parentId, tool, project, ts_first AS start, ts_last AS end, agent_type AS agentType
       FROM session`,
    )
    .all();
  const ownerMessages = db
    .query<Omit<OwnerMessageRow, "midTurn"> & { readonly midTurn: number }, [string]>(
      `SELECT m.session_id AS sessionId, m.ts AS at, m.text, ${AGENT_BEFORE} AS agentBefore,
              m.prompt_source IS ? AS midTurn
       FROM message m JOIN session s ON s.id = m.session_id
       WHERE ${OWNER} ORDER BY m.ts`,
    )
    .all(MID_TURN_PROMPT)
    .map((message) => ({ ...message, midTurn: message.midTurn === 1 }));
  const rejections = db
    .query<TimedRow, []>(
      `SELECT session_id AS sessionId, ts AS at FROM message WHERE denial_kind = 'user-rejected' ORDER BY ts`,
    )
    .all();
  const gitRuns = db
    .query<GitRunRow, []>(
      `SELECT c.session_id AS sessionId, c.ts_result AS at, g.subcommand, g.dir
       FROM git_command g JOIN tool_call c ON c.id = g.tool_call_id
       WHERE g.subcommand IN ('commit', 'push') AND g.dir IS NOT NULL AND ${SUCCEEDED}
       ORDER BY c.ts_result`,
    )
    .all();
  const routeReads = db
    .query<ReadRow, [string, string]>(
      `SELECT session_id AS sessionId, ts_call AS at, file_path AS path FROM tool_call
       WHERE tool_name = ? AND instr(file_path, ?) > 0 AND ts_call IS NOT NULL ORDER BY ts_call`,
    )
    .all(READ_TOOL, ROUTES_DIR);
  const compactions = db
    .query<TimedRow, []>("SELECT session_id AS sessionId, ts AS at FROM compaction ORDER BY ts")
    .all();
  const compactedSessionReads = db
    .query<ReadRow, [string]>(
      `SELECT session_id AS sessionId, ts_call AS at, file_path AS path FROM tool_call
       WHERE tool_name = ? AND file_path IS NOT NULL AND ts_call IS NOT NULL
         AND session_id IN (SELECT session_id FROM compaction)
       ORDER BY ts_call`,
    )
    .all(READ_TOOL);
  const hookEvents = db
    .query<HookColumns, []>(
      `SELECT ts AS at, event, session AS sessionId, agent, gate, decision, reason, repo, head, fingerprint, verdict
       FROM hook_event ORDER BY ts, src_file, src_line`,
    )
    .all()
    .map(hookRowOf);
  const skillLoads = db
    .query<Omit<LoadRow, "preloaded"> & { readonly preloaded: number }, [string]>(
      `SELECT session_id AS sessionId, ts AS at, skill_name AS skill, body_sha256 AS bodySha256, install,
              how = ? AS preloaded
       FROM skill_load ORDER BY ts`,
    )
    .all(PRELOAD)
    .map((load) => ({ ...load, preloaded: load.preloaded === 1 }));
  const responses = db
    .query<ResponseRow, []>(
      `SELECT session_id AS sessionId, ts AS at, output_tokens AS output,
              input_tokens + cache_read_tokens + cache_write_tokens AS input
       FROM usage ORDER BY session_id, ts, response_id`,
    )
    .all();
  const subagentReturns = db
    .query<TimedRow, [string]>(
      `SELECT session_id AS sessionId, ts_result AS at FROM tool_call
       WHERE tool_name = ? AND ts_result IS NOT NULL ORDER BY ts_result`,
    )
    .all(SUBAGENT_TOOL);
  const checkouts = db.query<CheckoutRow, []>("SELECT path, repo FROM checkout").all();
  const commits = db
    .query<CommitRow, []>("SELECT sha, repo, ts AS at, subject, kind FROM repo_commit ORDER BY ts, sha")
    .all();
  const firstHook = hookEvents[0]?.at ?? null;
  const commitFiles =
    firstHook === null
      ? []
      : db
          .query<CommitFileRow, [string]>(
            `SELECT f.sha, f.path FROM commit_file f JOIN repo_commit c ON c.sha = f.sha
             WHERE c.ts >= strftime('%Y-%m-%dT%H:%M:%fZ', ?, '-${ESCAPE_REACH_DAYS} days')`,
          )
          .all(firstHook);
  const labels = new Map(
    db
      .query<{ repo: string; label: string }, []>(
        "SELECT repo, max(label) AS label FROM repo_commit WHERE label IS NOT NULL GROUP BY repo",
      )
      .all()
      .map(({ repo, label }) => [repo, label]),
  );
  const newest = db.query<{ ts: string | null }, []>("SELECT max(ts) AS ts FROM message").get()?.ts ?? null;
  return {
    sessions,
    ownerMessages,
    rejections,
    gitRuns,
    routeReads,
    compactions,
    compactedSessionReads,
    hookEvents,
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
