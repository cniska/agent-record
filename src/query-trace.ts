import type { Database } from "bun:sqlite";
import { z } from "zod";
import { invariant, unreachable } from "./assert";
import { readRows } from "./db";
import {
  DECISIONS,
  GATES as GATE_KINDS,
  type Gate,
  VERDICTS as VERDICT_KINDS,
  type Verdict,
} from "./ingest-event-kinds";
import { subagentSessionIdSql } from "./ingest-ids";
import { HOWS } from "./ingest-skill-load";
import { callFailureSql, cellOf, sessionByPrefix } from "./query";
import { type Query, refuseQuery } from "./query-contract";
import {
  type RootRow,
  readTasks,
  rootOf,
  type TaskId,
  type TaskStart,
  taskAt,
  taskByPrefix,
} from "./query-task";

type LineKey =
  | "at"
  | "session"
  | "parent"
  | "task"
  | "seq"
  | "step"
  | "phase"
  | "ms"
  | "outcome"
  | "code"
  | "error";

type Fields<T> = Extract<keyof T, LineKey> extends never ? T : never;

type Step<Start, Result = Readonly<Record<never, never>>> = {
  readonly start: Fields<Start>;
  readonly result: Fields<Result>;
};

const text = z.string();
const maybeText = z.string().nullable();

const tokens = {
  inputTokens: z.number(),
  cacheReadTokens: z.number(),
  cacheWriteTokens: z.number(),
  outputTokens: z.number(),
};

const Tokens = z.strictObject(tokens);
type Tokens = Readonly<z.infer<typeof Tokens>>;

type Called = { readonly call: string; readonly name: string | null };

type How = (typeof HOWS)[number];

type Steps = {
  readonly agent: Step<{ readonly agentType: string | null; readonly model: string | null }, Tokens>;
  readonly tool: Step<
    {
      readonly call: string;
      readonly name: string | null;
      readonly target: string | null;
      readonly git: string | null;
    },
    Called
  >;
  readonly skill: Step<
    { readonly name: string; readonly how: How; readonly call: string | null },
    { readonly name: string }
  >;
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

const HOST_REFUSAL = "host";

const TREE = `WITH RECURSIVE tree(id) AS (
  SELECT ?1 UNION SELECT s.id FROM session s JOIN tree ON s.parent_id = tree.id
)`;

const SessionRow = z.strictObject({
  id: text,
  parent: maybeText,
  agentType: maybeText,
  first: text,
  last: text,
  model: maybeText,
  spawnFailure: maybeText,
  ...tokens,
});
type SessionRow = Readonly<z.infer<typeof SessionRow>>;

const SESSIONS = `${TREE}
SELECT s.id, s.parent_id AS parent, s.agent_type AS agentType, s.ts_first AS first, s.ts_last AS last,
  (SELECT u.model FROM usage u WHERE u.session_id = s.id AND u.model IS NOT NULL ORDER BY u.ts LIMIT 1) AS model,
  ${callFailureSql("spawn")} AS spawnFailure,
  coalesce((SELECT sum(u.input_tokens) FROM usage u WHERE u.session_id = s.id), 0) AS inputTokens,
  coalesce((SELECT sum(u.cache_read_tokens) FROM usage u WHERE u.session_id = s.id), 0) AS cacheReadTokens,
  coalesce((SELECT sum(u.cache_write_tokens) FROM usage u WHERE u.session_id = s.id), 0) AS cacheWriteTokens,
  coalesce((SELECT sum(u.output_tokens) FROM usage u WHERE u.session_id = s.id), 0) AS outputTokens
FROM tree JOIN session s ON s.id = tree.id
LEFT JOIN tool_call spawn ON spawn.id = s.spawn_call AND spawn.session_id = s.parent_id
WHERE s.ts_first IS NOT NULL AND s.ts_last IS NOT NULL`;

const CallRow = z.strictObject({
  id: text,
  session: text,
  name: maybeText,
  target: maybeText,
  git: maybeText,
  called: text,
  returned: maybeText,
  denial: maybeText,
  hostRefused: z.number().nullable(),
  failure: maybeText,
});
type CallRow = Readonly<z.infer<typeof CallRow>>;

const CALL_OUTCOME = `c.id, c.session_id AS session, c.ts_call AS called, c.ts_result AS returned,
  coalesce(c.skill_name, c.file_path) AS target,
  ${callFailureSql("c")} AS failure, c.host_refused AS hostRefused,
  (SELECT m.denial_kind FROM message m
   WHERE m.src_file = c.src_file AND m.src_line = c.src_line_result AND m.denial_kind IS NOT NULL) AS denial`;

const GIT_RUN_SEPARATOR = " ";

const CALLS = `${TREE}
SELECT ${CALL_OUTCOME}, c.tool_name AS name,
  (SELECT group_concat(g.subcommand, '${GIT_RUN_SEPARATOR}' ORDER BY g.position)
   FROM git_command g WHERE g.tool_call_id = c.id) AS git
FROM tree JOIN tool_call c ON c.session_id = tree.id
WHERE c.ts_call IS NOT NULL`;

const SkillRow = z.strictObject({ session: text, at: text, name: text, how: z.enum(HOWS), call: maybeText });
type SkillRow = Readonly<z.infer<typeof SkillRow>>;

const SKILLS = `${TREE}
SELECT l.session_id AS session, l.ts AS at, l.skill_name AS name, l.how, l.tool_call_id AS call
FROM tree JOIN skill_load l ON l.session_id = tree.id`;

const CompactionRow = z.strictObject({ session: text, at: text });
type CompactionRow = Readonly<z.infer<typeof CompactionRow>>;

const COMPACTIONS = `${TREE}
SELECT c.session_id AS session, c.ts AS at FROM tree JOIN compaction c ON c.session_id = tree.id`;

const VerdictRow = z.strictObject({ session: text, at: text, repo: text, verdict: z.enum(VERDICT_KINDS) });
type VerdictRow = Readonly<z.infer<typeof VerdictRow>>;

const GateRow = z.strictObject({
  session: text,
  at: text,
  gate: z.enum(GATE_KINDS),
  decision: z.enum(DECISIONS),
  reason: text,
  repo: maybeText,
});
type GateRow = Readonly<z.infer<typeof GateRow>>;

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
  if (call.hostRefused === 1) return { kind: "refused", code: HOST_REFUSAL };
  return failedOr(call.failure);
}

function agentStep(session: SessionRow, waiting: ReadonlySet<string>): Taken {
  const { inputTokens, cacheReadTokens, cacheWriteTokens, outputTokens } = session;
  return {
    step: "agent",
    session: session.id,
    at: session.first,
    start: { agentType: session.agentType, model: session.model },
    ended: waiting.has(session.id)
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
      : { at: call.returned, outcome: callOutcome(call), result: { call: call.id, name: call.name } };
  const { id, session, called: at } = call;
  return {
    step: "tool",
    session,
    at,
    start: { call: id, name: call.name, target: call.target, git: call.git },
    ended,
  };
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

function skillStep(row: SkillRow): Taken {
  return {
    step: "skill",
    session: row.session,
    at: row.at,
    start: { name: row.name, how: row.how, call: row.call },
    ended: { at: row.at, outcome: OK, result: { name: row.name } },
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

function outcomeFields(outcome: Outcome): Readonly<Record<"outcome" | "code" | "error", string | null>> {
  switch (outcome.kind) {
    case "ok":
      return { outcome: outcome.kind, code: null, error: null };
    case "refused":
      return { outcome: outcome.kind, code: outcome.code, error: null };
    case "failed":
      return { outcome: outcome.kind, code: null, error: outcome.error };
    default:
      return unreachable(outcome);
  }
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
    {
      order: order.ended,
      line: { at, ...head, phase: "ended" as const, ms, ...outcomeFields(outcome), ...result },
    },
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

type Window = { readonly from: TaskStart; readonly to: TaskStart | null };

type Picked =
  | { readonly kind: "task"; readonly root: string; readonly task: TaskId; readonly window: Window }
  | { readonly kind: "subagent"; readonly root: string; readonly task: TaskId };

const UsageRow = z.strictObject({ at: text, model: maybeText, ...tokens });

const LineRow = z.strictObject({ at: text });

const ROOT_USAGE = `SELECT ts AS at, model, input_tokens AS inputTokens, cache_read_tokens AS cacheReadTokens,
  cache_write_tokens AS cacheWriteTokens, output_tokens AS outputTokens
FROM usage WHERE session_id = ?1 ORDER BY ts`;

const ROOT_LINES = "SELECT ts AS at FROM message WHERE session_id = ?1 ORDER BY ts";

const ms = (at: string): number => Date.parse(at);

const within =
  (window: Window | null) =>
  (at: string): boolean =>
    window === null || (ms(at) >= window.from.ms && (window.to === null || ms(at) < window.to.ms));

type Placement =
  | { readonly kind: "root"; readonly id: string; readonly first: string }
  | {
      readonly kind: "subagent";
      readonly root: string;
      readonly first: string;
      readonly branchFirst: string;
    };

function placementOf(traced: string, root: RootRow): Placement | null {
  if (root.first === null) return null;
  if (root.id === traced) return { kind: "root", id: root.id, first: root.first };
  if (root.branchFirst === null) return null;
  return { kind: "subagent", root: root.id, first: root.first, branchFirst: root.branchFirst };
}

function pick(db: Database, traced: string, picked: string | undefined, placement: Placement): Picked {
  switch (placement.kind) {
    case "subagent": {
      if (picked !== undefined) throw refuseQuery("task_of_subagent", { session: traced });
      const starts = readTasks(db, placement.root, placement.first);
      return { kind: "subagent", root: placement.root, task: taskAt(starts, ms(placement.branchFirst)).id };
    }
    case "root": {
      const starts = readTasks(db, placement.id, placement.first);
      const from = picked === undefined ? starts.at(-1) : taskByPrefix(starts, placement.id, picked);
      invariant(from !== undefined, "a session has at least one task");
      const to = starts[starts.indexOf(from) + 1] ?? null;
      return { kind: "task", root: placement.id, task: from.id, window: { from, to } };
    }
    default:
      return unreachable(placement);
  }
}

function topChildOf(sessions: ReadonlyMap<string, SessionRow>, root: string): (id: string) => string {
  return (id) => {
    let at = id;
    for (let parent = sessions.get(at)?.parent ?? null; parent !== null && parent !== root;) {
      at = parent;
      parent = sessions.get(at)?.parent ?? null;
    }
    return at;
  };
}

function rootInTask(db: Database, root: SessionRow, window: Window, waiting: boolean): Taken {
  const inTask = within(window);
  const usage = readRows<[string]>(db, ROOT_USAGE)
    .all(UsageRow, root.id)
    .filter((row) => inTask(row.at));
  const lines = readRows<[string]>(db, ROOT_LINES)
    .all(LineRow, root.id)
    .filter((row) => inTask(row.at));
  const sum = (field: keyof Tokens) => usage.reduce((total, row) => total + row[field], 0);
  const last = window.to === null ? root.last : (lines.at(-1)?.at ?? window.from.at);
  return {
    step: "agent",
    session: root.id,
    at: window.from.at,
    start: { agentType: root.agentType, model: usage.find((row) => row.model !== null)?.model ?? null },
    ended: waiting
      ? null
      : {
          at: last,
          outcome: OK,
          result: {
            inputTokens: sum("inputTokens"),
            cacheReadTokens: sum("cacheReadTokens"),
            cacheWriteTokens: sum("cacheWriteTokens"),
            outputTokens: sum("outputTokens"),
          },
        },
  };
}

function stepsUnder(
  db: Database,
  traced: string,
  window: Window | null,
): {
  readonly taken: readonly Taken[];
  readonly sessions: ReadonlyMap<string, SessionRow>;
} {
  const rows = readRows<[string]>(db, SESSIONS).all(SessionRow, traced);
  const all = new Map(rows.map((row) => [row.id, row]));
  const topChild = topChildOf(all, traced);
  const inTask = within(window);
  const startedInTask = (row: SessionRow): boolean => {
    const top = all.get(topChild(row.id));
    invariant(top !== undefined, "a session's top child is in its tree");
    return inTask(top.first);
  };
  const sessions = new Map(
    rows.filter((row) => row.id === traced || startedInTask(row)).map((row) => [row.id, row]),
  );
  const keeps = (t: Taken) => (t.session === traced ? inTask(t.at) : sessions.has(t.session));
  const calls = readRows<[string]>(db, CALLS).all(CallRow, traced).map(callStep).filter(keeps);
  const waiting = new Set(calls.filter((c) => c.ended === null).map((c) => c.session));
  const agents = [...sessions.values()].map((row) =>
    row.id === traced && window !== null
      ? rootInTask(db, row, window, waiting.has(row.id))
      : agentStep(row, waiting),
  );
  const others = [
    ...readRows<[string]>(db, SKILLS).all(SkillRow, traced).map(skillStep),
    ...readRows<[string]>(db, COMPACTIONS).all(CompactionRow, traced).map(compactStep),
    ...readRows<[string]>(db, VERDICTS).all(VerdictRow, traced).map(verdictStep),
    ...readRows<[string]>(db, GATES).all(GateRow, traced).map(gateStep),
  ].filter(keeps);
  return { taken: [...agents, ...calls, ...others], sessions };
}

function describe(traced: string, picked: Picked, subagents: number): string {
  switch (picked.kind) {
    case "task":
      return `task ${picked.task} of session ${traced}, from ${picked.window.from.at}, and the ${subagents} subagents started in it`;
    case "subagent":
      return `session ${traced} and the ${subagents} subagents under it, in task ${picked.task} of ${picked.root}`;
    default:
      return unreachable(picked);
  }
}

type TraceField = LineKey | { [N in StepName]: keyof Steps[N]["start"] | keyof Steps[N]["result"] }[StepName];

const TRACE_FIELDS: Readonly<Record<TraceField, null>> = {
  at: null,
  session: null,
  parent: null,
  task: null,
  seq: null,
  step: null,
  phase: null,
  ms: null,
  outcome: null,
  code: null,
  error: null,
  name: null,
  call: null,
  agentType: null,
  model: null,
  target: null,
  git: null,
  how: null,
  repo: null,
  verdict: null,
  gate: null,
  inputTokens: null,
  cacheReadTokens: null,
  cacheWriteTokens: null,
  outputTokens: null,
};

const TRACE_COLUMNS: readonly string[] = Object.keys(TRACE_FIELDS);

export const trace: Query<"task"> = {
  name: "trace",
  summary:
    "trace the steps of one task of a session, or of a subagent and every subagent under it, one row per step start or end",
  usage: "agent-record query trace <id-prefix> [--task <id-prefix>] [--rows <n>]",
  flags: ["task"],
  run: (db, ctx) => {
    const prefix = ctx.arg;
    const traced = sessionByPrefix(db, "trace", prefix);
    if (traced === null) {
      return {
        denominator: "0 sessions",
        columns: TRACE_COLUMNS,
        rows: [],
        note: `no session starts with ${prefix}`,
      };
    }
    const placement = placementOf(traced, rootOf(db, traced));
    if (placement === null) {
      return {
        denominator: `session ${traced}: 0 steps`,
        columns: TRACE_COLUMNS,
        rows: [],
        note: `session ${traced}, or the branch of its top-level session it runs in, has no timed line, so it falls in no task`,
      };
    }
    const picked = pick(db, traced, ctx.flags.task, placement);
    const { taken, sessions } = stepsUnder(db, traced, picked.kind === "task" ? picked.window : null);
    const lines = linesOf(taken, sessions, picked.task);
    const running = taken.filter((t) => t.ended === null).length;
    return {
      denominator: `${describe(traced, picked, sessions.size - 1)}: ${taken.length} steps, ${running} still running`,
      columns: TRACE_COLUMNS,
      rows: lines.map((line) => TRACE_COLUMNS.map((column) => cellOf(line[column] ?? null))),
      note:
        "Each row is a step's start or end, in time order, with null in each column its step does not fill. A top-level session's task runs from one task prompt to the " +
        "next, with the subagents started in it; the latest is traced unless --task names another, as query tasks " +
        "lists them. An agent has ended, at its last line, once every tool call it " +
        "made has returned. A refused tool call's code is the tool's denial kind, or host when Claude Code refused " +
        "it before it ran, not a hook's reason. gate and verdict steps appear only where a hook event log recorded them.",
    };
  },
};
