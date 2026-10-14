import type { Database } from "bun:sqlite";
import type { Decision, Gate, Verdict } from "./ingest-event-kinds";
import { subagentSessionIdSql } from "./ingest-ids";
import { callFailureSql, sessionByPrefix } from "./query";
import type { Query } from "./query-contract";

type LineKey = "at" | "session" | "parent" | "task" | "seq" | "step" | "phase" | "ms" | "outcome";

type Fields<T> = Extract<keyof T, LineKey> extends never ? T : never;

type Step<Start, Result = Readonly<Record<never, never>>> = {
  readonly start: Fields<Start>;
  readonly result: Fields<Result>;
};

type Tokens = {
  readonly inputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly outputTokens: number;
};

type Called = { readonly call: string };

type Steps = {
  readonly agent: Step<{ readonly agentType: string | null; readonly model: string | null }, Tokens>;
  readonly tool: Step<{ readonly call: string; readonly name: string | null }, Called>;
  readonly commit: Step<{ readonly call: string; readonly dir: string | null }, Called>;
  readonly push: Step<{ readonly call: string; readonly dir: string | null }, Called>;
  readonly verdict: Step<{ readonly repo: string }, { readonly verdict: Verdict }>;
  readonly gate: Step<{ readonly gate: Gate; readonly repo: string | null }>;
  readonly compact: Step<Readonly<Record<never, never>>>;
};

type StepName = keyof Steps;

type Outcome =
  | { readonly kind: "ok" }
  | { readonly kind: "refused"; readonly code: string }
  | { readonly kind: "failed"; readonly error: string };

type Ending<N extends StepName> = {
  readonly at: string;
  readonly outcome: Outcome;
  readonly result: Steps[N]["result"];
};

type Taken = {
  [N in StepName]: {
    readonly step: N;
    readonly session: string;
    readonly at: string;
    readonly start: Steps[N]["start"];
    readonly ended: Ending<N> | null;
  };
}[StepName];

const NOTHING = {};

const OK: Outcome = { kind: "ok" };

const TREE = `WITH RECURSIVE tree(id) AS (
  SELECT ?1 UNION SELECT s.id FROM session s JOIN tree ON s.parent_id = tree.id
)`;

type SessionRow = {
  readonly id: string;
  readonly parent: string | null;
  readonly agentType: string | null;
  readonly first: string;
  readonly last: string;
  readonly model: string | null;
  readonly openCalls: number;
  readonly spawnFailure: string | null;
} & Tokens;

const SESSIONS = `${TREE}
SELECT s.id, s.parent_id AS parent, s.agent_type AS agentType, s.ts_first AS first, s.ts_last AS last,
  (SELECT u.model FROM usage u WHERE u.session_id = s.id AND u.model IS NOT NULL ORDER BY u.ts LIMIT 1) AS model,
  (SELECT count(*) FROM tool_call c WHERE c.session_id = s.id AND c.ts_call IS NOT NULL AND c.ts_result IS NULL)
    AS openCalls,
  ${callFailureSql("spawn")} AS spawnFailure,
  coalesce((SELECT sum(u.input_tokens) FROM usage u WHERE u.session_id = s.id), 0) AS inputTokens,
  coalesce((SELECT sum(u.cache_read_tokens) FROM usage u WHERE u.session_id = s.id), 0) AS cacheReadTokens,
  coalesce((SELECT sum(u.cache_write_tokens) FROM usage u WHERE u.session_id = s.id), 0) AS cacheWriteTokens,
  coalesce((SELECT sum(u.output_tokens) FROM usage u WHERE u.session_id = s.id), 0) AS outputTokens
FROM tree JOIN session s ON s.id = tree.id
LEFT JOIN tool_call spawn ON spawn.id = s.spawn_call AND spawn.session_id = s.parent_id
WHERE s.ts_first IS NOT NULL AND s.ts_last IS NOT NULL`;

type CallRow = {
  readonly id: string;
  readonly session: string;
  readonly name: string | null;
  readonly dir: string | null;
  readonly subcommand: string | null;
  readonly called: string;
  readonly returned: string | null;
  readonly denial: string | null;
  readonly failure: string | null;
};

const CALL_OUTCOME = `c.id, c.session_id AS session, c.ts_call AS called, c.ts_result AS returned,
  ${callFailureSql("c")} AS failure,
  (SELECT m.denial_kind FROM message m
   WHERE m.src_file = c.src_file AND m.src_line = c.src_line_result AND m.denial_kind IS NOT NULL) AS denial`;

const CALLS = `${TREE}
SELECT ${CALL_OUTCOME}, c.tool_name AS name, NULL AS dir, NULL AS subcommand
FROM tree JOIN tool_call c ON c.session_id = tree.id
WHERE c.ts_call IS NOT NULL
UNION ALL
SELECT ${CALL_OUTCOME}, c.tool_name AS name, g.dir, g.subcommand
FROM tree JOIN tool_call c ON c.session_id = tree.id
JOIN git_command g ON g.tool_call_id = c.id AND g.subcommand IN ('commit', 'push')
WHERE c.ts_call IS NOT NULL`;

type CompactionRow = { readonly session: string; readonly at: string };

const COMPACTIONS = `${TREE}
SELECT c.session_id AS session, c.ts AS at FROM tree JOIN compaction c ON c.session_id = tree.id`;

type VerdictRow = {
  readonly session: string;
  readonly at: string;
  readonly repo: string;
  readonly verdict: Verdict;
};

type GateRow = {
  readonly session: string;
  readonly at: string;
  readonly gate: Gate;
  readonly decision: Decision;
  readonly reason: string;
  readonly repo: string | null;
};

const ACTOR = `CASE WHEN h.agent IS NULL THEN h.session ELSE ${subagentSessionIdSql("h.agent", "h.session")} END`;

const hookEvents = (event: "gate" | "verdict", fields: string): string => `${TREE}
SELECT tree.id AS session, h.ts AS at, ${fields}
FROM hook_event h JOIN tree ON tree.id = ${ACTOR}
WHERE h.event = '${event}'`;

const VERDICTS = hookEvents("verdict", "h.repo, h.verdict");

const GATES = hookEvents("gate", "h.gate, h.decision, h.reason, h.repo");

function failedOr(failure: string | null): Outcome {
  return failure === null ? OK : { kind: "failed", error: failure };
}

function callOutcome(call: CallRow): Outcome {
  if (call.denial !== null) return { kind: "refused", code: call.denial };
  return failedOr(call.failure);
}

function agentStep(session: SessionRow): Taken {
  const { inputTokens, cacheReadTokens, cacheWriteTokens, outputTokens } = session;
  return {
    step: "agent",
    session: session.id,
    at: session.first,
    start: { agentType: session.agentType, model: session.model },
    ended:
      session.openCalls > 0
        ? null
        : {
            at: session.last,
            outcome: failedOr(session.spawnFailure),
            result: { inputTokens, cacheReadTokens, cacheWriteTokens, outputTokens },
          },
  };
}

function callStep(call: CallRow): Taken {
  const ended =
    call.returned === null
      ? null
      : { at: call.returned, outcome: callOutcome(call), result: { call: call.id } };
  const { id, session, called: at } = call;
  if (call.subcommand === "commit" || call.subcommand === "push")
    return { step: call.subcommand, session, at, start: { call: id, dir: call.dir }, ended };
  return { step: "tool", session, at, start: { call: id, name: call.name }, ended };
}

function verdictStep(row: VerdictRow): Taken {
  return {
    step: "verdict",
    session: row.session,
    at: row.at,
    start: { repo: row.repo },
    ended: { at: row.at, outcome: OK, result: { verdict: row.verdict } },
  };
}

function gateStep(row: GateRow): Taken {
  const outcome: Outcome = row.decision === "deny" ? { kind: "refused", code: row.reason } : OK;
  return {
    step: "gate",
    session: row.session,
    at: row.at,
    start: { gate: row.gate, repo: row.repo },
    ended: { at: row.at, outcome, result: NOTHING },
  };
}

function compactStep(row: CompactionRow): Taken {
  return {
    step: "compact",
    session: row.session,
    at: row.at,
    start: NOTHING,
    ended: { at: row.at, outcome: OK, result: NOTHING },
  };
}

type Line = {
  readonly at: string;
  readonly session: string;
  readonly parent: string | null;
  readonly task: string;
  readonly step: StepName;
  readonly phase: "started" | "ended";
} & Readonly<Record<string, unknown>>;

type Placed = { readonly order: number; readonly line: Line };

const AGENT_OPENS_ITS_SESSION = -1;

const AGENT_CLOSES_ITS_SESSION = Number.MAX_SAFE_INTEGER;

function orderOf(t: Taken, index: number): { readonly started: number; readonly ended: number } {
  if (t.step === "agent") return { started: AGENT_OPENS_ITS_SESSION, ended: AGENT_CLOSES_ITS_SESSION };
  return { started: 2 * index, ended: 2 * index + 1 };
}

function placed(t: Taken, index: number, parent: string | null, task: string): readonly Placed[] {
  const head = { session: t.session, parent, task, step: t.step };
  const order = orderOf(t, index);
  const started = {
    order: order.started,
    line: { at: t.at, ...head, phase: "started" as const, ...t.start },
  };
  if (t.ended === null) return [started];
  const { at, outcome, result } = t.ended;
  const ms = Date.parse(at) - Date.parse(t.at);
  return [
    started,
    { order: order.ended, line: { at, ...head, phase: "ended" as const, ms, outcome, ...result } },
  ];
}

function linesOf(
  taken: readonly Taken[],
  sessions: ReadonlyMap<string, SessionRow>,
  task: string,
): readonly Line[] {
  const all = taken.flatMap((t, index) => placed(t, index, sessions.get(t.session)?.parent ?? null, task));
  all.sort((a, b) => Date.parse(a.line.at) - Date.parse(b.line.at) || a.order - b.order);
  const seqs = new Map<string, number>();
  return all.map(({ line: { at, session, parent, task: lineTask, ...rest } }) => {
    const seq = (seqs.get(session) ?? 0) + 1;
    seqs.set(session, seq);
    return { at, session, parent, task: lineTask, seq, ...rest };
  });
}

function stepsUnder(
  db: Database,
  task: string,
): {
  readonly taken: readonly Taken[];
  readonly sessions: ReadonlyMap<string, SessionRow>;
} {
  const rows = db.query<SessionRow, [string]>(SESSIONS).all(task);
  const sessions = new Map(rows.map((row) => [row.id, row]));
  const agents = rows.map(agentStep);
  const calls = db.query<CallRow, [string]>(CALLS).all(task).map(callStep);
  const compactions = db.query<CompactionRow, [string]>(COMPACTIONS).all(task).map(compactStep);
  const verdicts = db.query<VerdictRow, [string]>(VERDICTS).all(task).map(verdictStep);
  const gates = db.query<GateRow, [string]>(GATES).all(task).map(gateStep);
  return { taken: [...agents, ...calls, ...compactions, ...verdicts, ...gates], sessions };
}

export const trace: Query = {
  name: "trace",
  summary: "trace the steps of a session and every subagent under it, each row one JSON line",
  usage: "agent-record query trace <id-prefix> [--rows <n>]",
  flags: [],
  run: (db, ctx) => {
    const prefix = ctx.arg;
    const task = sessionByPrefix(db, "trace", prefix);
    if (task === null) {
      return {
        denominator: "0 sessions",
        columns: ["line"],
        rows: [],
        note: `no session starts with ${prefix}`,
      };
    }
    const { taken, sessions } = stepsUnder(db, task);
    const lines = linesOf(taken, sessions, task);
    const running = taken.filter((t) => t.ended === null).length;
    return {
      denominator: `session ${task} and the ${sessions.size - 1} subagents under it: ${taken.length} steps, ${running} still running`,
      columns: ["line"],
      rows: lines.map((line) => [JSON.stringify(line)]),
      note:
        "Each row is one JSON line, in time order. An agent has ended, at its last line, once every tool call it " +
        "made has returned. A refused tool call's code is the tool's denial kind, not a hook's reason. gate and " +
        "verdict steps appear only where a hook event log recorded them.",
    };
  },
};
