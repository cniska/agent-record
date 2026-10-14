import type { Database } from "bun:sqlite";
import { invariant, unreachable } from "./assert";
import type { Decision, Gate, HookEvent, Verdict } from "./ingest-event-kinds";
import type { Tool } from "./ingest-tools";
import { AGENT_TAIL_CHARS, INTERRUPTED } from "./query-interrupt";

export type SessionRow = {
  readonly id: string;
  readonly parentId: string | null;
  readonly tool: Tool;
  readonly project: string | null;
  readonly start: string | null;
  readonly isReviewer: boolean;
};

type OwnerMessageRow = {
  readonly sessionId: string;
  readonly at: string;
  readonly text: string;
  readonly agentBefore: string | null;
};

export type TimedRow = { readonly sessionId: string; readonly at: string };

export type GitRunRow = TimedRow & { readonly subcommand: "commit" | "push"; readonly dir: string };

export type ReadRow = TimedRow & { readonly path: string };

export type CheckoutRow = { readonly path: string; readonly repo: string };

type LoadRow = TimedRow & {
  readonly skill: string;
  readonly bodySha256: string | null;
  readonly install: string | null;
};

type HookColumns = {
  readonly at: string;
  readonly event: HookEvent;
  readonly sessionId: string;
  readonly agent: string | null;
  readonly gate: Gate | null;
  readonly decision: Decision | null;
  readonly reason: string | null;
  readonly repo: string | null;
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
      const { gate, decision, reason, repo, fingerprint } = columns;
      invariant(gate !== null && decision !== null && reason !== null, "a gate event has its gate fields");
      return { at, sessionId, agent, event: "gate", gate, decision, reason, repo, fingerprint };
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
  readonly checkouts: readonly CheckoutRow[];
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

const SUCCEEDED = `c.ts_result IS NOT NULL AND coalesce(c.is_error, 0) = 0
  AND coalesce(c.is_interrupted, 0) = 0 AND coalesce(c.exit_code, 0) = 0`;

const REVIEWER = "%reviewer%";

export function readSignalRecord(db: Database): SignalRecord {
  const sessions = db
    .query<Omit<SessionRow, "isReviewer"> & { readonly isReviewer: number }, [string]>(
      `SELECT id, parent_id AS parentId, tool, project, ts_first AS start,
              (parent_id IS NOT NULL AND agent_type LIKE ?) AS isReviewer
       FROM session`,
    )
    .all(REVIEWER)
    .map((session) => ({ ...session, isReviewer: session.isReviewer === 1 }));
  const ownerMessages = db
    .query<OwnerMessageRow, []>(
      `SELECT m.session_id AS sessionId, m.ts AS at, m.text, ${AGENT_BEFORE} AS agentBefore
       FROM message m JOIN session s ON s.id = m.session_id
       WHERE ${OWNER} ORDER BY m.ts`,
    )
    .all();
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
      `SELECT ts AS at, event, session AS sessionId, agent, gate, decision, reason, repo, fingerprint, verdict
       FROM hook_event ORDER BY ts, src_file, src_line`,
    )
    .all()
    .map(hookRowOf);
  const skillLoads = db
    .query<LoadRow, []>(
      `SELECT session_id AS sessionId, ts AS at, skill_name AS skill, body_sha256 AS bodySha256, install
       FROM skill_load ORDER BY ts`,
    )
    .all();
  const checkouts = db.query<CheckoutRow, []>("SELECT path, repo FROM checkout").all();
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
    checkouts,
    labels,
    newest,
  };
}
