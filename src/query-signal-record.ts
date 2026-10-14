import type { Database } from "bun:sqlite";
import { AGENT_TAIL_CHARS, INTERRUPTED } from "./query-interrupt";

export type SessionRow = {
  readonly id: string;
  readonly parentId: string | null;
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

type TimedRow = { readonly sessionId: string; readonly at: string };

export type GitRunRow = TimedRow & { readonly subcommand: "commit" | "push"; readonly dir: string };

type RouteReadRow = TimedRow & { readonly path: string };

export type CheckoutRow = { readonly path: string; readonly repo: string };

export type SignalRecord = {
  readonly sessions: readonly SessionRow[];
  readonly ownerMessages: readonly OwnerMessageRow[];
  readonly rejections: readonly TimedRow[];
  readonly gitRuns: readonly GitRunRow[];
  readonly routeReads: readonly RouteReadRow[];
  readonly checkouts: readonly CheckoutRow[];
  readonly labels: ReadonlyMap<string, string>;
  readonly newest: string | null;
};

const ROUTES_DIR = "/skills/task/references/";

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
      `SELECT id, parent_id AS parentId, project, ts_first AS start,
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
    .query<RouteReadRow, [string]>(
      `SELECT session_id AS sessionId, ts_call AS at, file_path AS path FROM tool_call
       WHERE tool_name = 'Read' AND instr(file_path, ?) > 0 AND ts_call IS NOT NULL ORDER BY ts_call`,
    )
    .all(ROUTES_DIR);
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
  return { sessions, ownerMessages, rejections, gitRuns, routeReads, checkouts, labels, newest };
}
