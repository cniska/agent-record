import { describe, expect, test } from "bun:test";
import type { GateRow, GitRunRow, SessionRow, SignalRecord, VerdictRow } from "./query-signal-record";
import { SIGNALS, signalNamed } from "./query-signals";
import { timelineOf } from "./query-timeline";

const REPO = "/h/code/demo";
const ASKED = "Done. Should I push?";
const TOLD = "Done, pushed.";

const session = (id: string, start: string, more: Partial<SessionRow> = {}): SessionRow => ({
  id,
  parentId: null,
  tool: "claude",
  project: REPO,
  start,
  isReviewer: false,
  ...more,
});

const run = (sessionId: string, at: string, subcommand: GitRunRow["subcommand"], dir = REPO): GitRunRow => ({
  sessionId,
  at,
  subcommand,
  dir,
});

const recordOf = (more: Partial<SignalRecord>): SignalRecord => ({
  sessions: [],
  ownerMessages: [],
  rejections: [],
  gitRuns: [],
  routeReads: [],
  hookEvents: [],
  skillLoads: [],
  checkouts: [{ path: REPO, repo: REPO }],
  labels: new Map([[REPO, "me/demo"]]),
  newest: "2026-10-14T12:00:00.000Z",
  ...more,
});

const eventsOf = (name: string, record: SignalRecord) => signalNamed(name).events(timelineOf(record));

const rateOf = (name: string, record: SignalRecord) => {
  const signal = signalNamed(name);
  return signal.rate(signal.events(timelineOf(record)));
};

describe("counting the owner's interrupts per task", () => {
  const record = recordOf({
    sessions: [
      session("s", "2026-10-14T09:00:00.000Z"),
      session("sub", "2026-10-14T09:01:00.000Z", { parentId: "s" }),
    ],
    ownerMessages: [
      { sessionId: "s", at: "2026-10-14T09:00:00.000Z", text: "add the parser", agentBefore: null },
      { sessionId: "s", at: "2026-10-14T09:10:00.000Z", text: "the second", agentBefore: ASKED },
      { sessionId: "s", at: "2026-10-14T09:20:00.000Z", text: "no, the other file", agentBefore: TOLD },
      { sessionId: "s", at: "2026-10-14T09:30:00.000Z", text: "now add the printer", agentBefore: TOLD },
      {
        sessionId: "s",
        at: "2026-10-14T09:40:00.000Z",
        text: "<command-name>/clear</command-name>",
        agentBefore: TOLD,
      },
    ],
    rejections: [{ sessionId: "sub", at: "2026-10-14T09:35:00.000Z" }],
  });

  test("tags each interrupt by its cause, and a subagent's on its top-level session", () => {
    const kinds = eventsOf("owner-interrupts", record).map((e) => [e.kind, e.sessionId]);
    expect(kinds).toEqual([
      ["answer", "s"],
      ["correct", "s"],
      ["permission", "s"],
      ["task", "s"],
      ["task", "s"],
    ]);
  });

  test("divides the interrupts by the tasks of the sessions the owner typed in", () => {
    expect(rateOf("owner-interrupts", record)).toEqual({ value: 1.5, count: 3, of: 2 });
  });
});

describe("timing a task from its prompt to its last commit run on origin", () => {
  test("takes the first push in the repo at or after the last commit run, from any session", () => {
    const record = recordOf({
      sessions: [session("a", "2026-10-14T09:00:00.000Z"), session("b", "2026-10-14T11:00:00.000Z")],
      gitRuns: [
        run("a", "2026-10-14T09:10:00.000Z", "commit"),
        run("a", "2026-10-14T09:20:00.000Z", "commit", `${REPO}/src`),
        run("b", "2026-10-14T11:05:00.000Z", "push", `${REPO}/.claude/worktrees/x`),
      ],
    });
    expect(eventsOf("time-to-land", record).map((e) => [e.kind, e.minutes])).toEqual([["landed", 125]]);
  });

  test("counts a task whose commit run never reached origin apart, and leaves out one that made none", () => {
    const record = recordOf({
      sessions: [session("a", "2026-10-14T09:00:00.000Z"), session("b", "2026-10-14T10:00:00.000Z")],
      gitRuns: [run("a", "2026-10-14T09:10:00.000Z", "commit")],
    });
    expect(rateOf("time-to-land", record)).toEqual({ value: null, count: 0, of: 1 });
  });

  test("does not count a git run outside every checkout the record indexes", () => {
    const record = recordOf({
      sessions: [session("a", "2026-10-14T09:00:00.000Z")],
      gitRuns: [run("a", "2026-10-14T09:10:00.000Z", "commit", "/elsewhere")],
    });
    expect(eventsOf("time-to-land", record)).toEqual([]);
  });

  test("names the route by the first route file the task read", () => {
    const record = recordOf({
      sessions: [session("a", "2026-10-14T09:00:00.000Z"), session("b", "2026-10-14T09:00:00.000Z")],
      gitRuns: [
        run("a", "2026-10-14T09:10:00.000Z", "commit"),
        run("b", "2026-10-14T09:10:00.000Z", "commit"),
      ],
      routeReads: [
        { sessionId: "a", at: "2026-10-14T09:01:00.000Z", path: "/p/skills/task/references/feature.md" },
        { sessionId: "a", at: "2026-10-14T09:02:00.000Z", path: "/p/skills/task/references/review.md" },
      ],
    });
    expect(eventsOf("time-to-land", record).map((e) => [e.sessionId, e.route])).toEqual([
      ["a", "feature"],
      ["b", "none"],
    ]);
  });
});

describe("finding commit runs stranded off origin", () => {
  test("counts a run pushed after the hour and a last run never pushed, and skips the last hour", () => {
    const record = recordOf({
      sessions: [session("a", "2026-10-14T08:00:00.000Z")],
      gitRuns: [
        run("a", "2026-10-14T08:00:00.000Z", "commit"),
        run("a", "2026-10-14T08:30:00.000Z", "push"),
        run("a", "2026-10-14T09:00:00.000Z", "commit"),
        run("a", "2026-10-14T10:30:00.000Z", "push"),
        run("a", "2026-10-14T10:40:00.000Z", "commit"),
        run("a", "2026-10-14T11:30:00.000Z", "commit"),
      ],
    });
    expect(eventsOf("stranded-work", record).map((e) => [e.kind, e.minutes])).toEqual([
      ["pushed", 30],
      ["stranded", 90],
      ["stranded", null],
    ]);
    expect(rateOf("stranded-work", record)).toEqual({ value: 0.67, count: 2, of: 3 });
  });

  test("calls a session's last run never pushed ended unpushed", () => {
    const record = recordOf({
      sessions: [session("a", "2026-10-14T08:00:00.000Z")],
      gitRuns: [
        run("a", "2026-10-14T08:00:00.000Z", "commit"),
        run("a", "2026-10-14T09:00:00.000Z", "commit"),
      ],
    });
    expect(eventsOf("stranded-work", record).map((e) => e.kind)).toEqual(["stranded", "ended unpushed"]);
  });
});

describe("counting reviewer runs per commit run", () => {
  test("counts reviewer subagents against the commit runs", () => {
    const record = recordOf({
      sessions: [
        session("a", "2026-10-14T09:00:00.000Z"),
        session("r1", "2026-10-14T09:05:00.000Z", { parentId: "a", isReviewer: true }),
        session("r2", "2026-10-14T09:15:00.000Z", { parentId: "a", isReviewer: true }),
      ],
      gitRuns: [run("a", "2026-10-14T09:20:00.000Z", "commit")],
    });
    expect(rateOf("review-loops", record)).toEqual({ value: 2, count: 2, of: 1 });
  });
});

const OTHER = "/h/code/other";

const allow = (at: string, more: Partial<GateRow> = {}): GateRow => ({
  at,
  event: "gate",
  sessionId: "a",
  agent: null,
  gate: "commit",
  decision: "allow",
  reason: "accepted",
  repo: REPO,
  fingerprint: null,
  ...more,
});

const deny = (at: string, reason: string, more: Partial<GateRow> = {}): GateRow =>
  allow(at, { decision: "deny", reason, repo: null, ...more });

const said = (at: string, verdict: "accept" | "return", more: Partial<VerdictRow> = {}): VerdictRow => ({
  at,
  event: "verdict",
  sessionId: "a",
  agent: null,
  verdict,
  repo: REPO,
  fingerprint: "f",
  ...more,
});

const timed = (minute: number): string => `2026-10-14T09:${String(minute).padStart(2, "0")}:00.000Z`;

describe("judging each gate denial a false stop or upheld", () => {
  const record = recordOf({
    sessions: [session("a", "2026-10-14T08:00:00.000Z")],
    checkouts: [
      { path: REPO, repo: REPO },
      { path: OTHER, repo: OTHER },
    ],
    hookEvents: [
      deny(timed(1), "repo_unclear", { agent: "b1" }),
      allow(timed(2), { agent: "b1", reason: "no_code_change" }),
      deny(timed(3), "repo_not_found", { agent: "b2" }),
      said(timed(4), "accept", { agent: "r0", repo: OTHER }),
      allow(timed(5), { agent: "b2", repo: OTHER }),
      deny(timed(6), "changed_since_accept", { agent: "b3", repo: REPO, fingerprint: "f1" }),
      allow(timed(7), { agent: "b3", fingerprint: "f1" }),
      deny(timed(8), "multiple_commits", { agent: "b4" }),
      deny(timed(9), "missing_verdict", { agent: "r1", gate: "verdict" }),
      allow(timed(10), { agent: "r1", gate: "verdict", reason: "missing_verdict" }),
      deny(timed(11), "missing_repo", { agent: "r2", gate: "verdict" }),
      said(timed(12), "accept", { agent: "r2" }),
      deny(timed(13), "repo_unclear", { agent: "b5", repo: OTHER }),
      allow(timed(14), { agent: "b5", reason: "no_code_change" }),
      deny(timed(15), "gate_error", { agent: "b6", repo: OTHER }),
      deny(timed(16), "gate_error", { agent: "b6", repo: OTHER }),
      allow(timed(17), { agent: "b6", reason: "no_code_change" }),
      allow(timed(18), { agent: "b6", repo: OTHER, reason: "no_code_change" }),
      deny(timed(19), "multiple_commits", { agent: "b7" }),
    ],
  });

  test("calls a stop false only when the same agent got through in its repo with no review between", () => {
    expect(eventsOf("false-stops", record).map((e) => [e.at, e.kind])).toEqual([
      [timed(1), "commit repo_unclear"],
      [timed(3), "upheld"],
      [timed(6), "upheld"],
      [timed(8), "upheld"],
      [timed(9), "unfixed"],
      [timed(11), "upheld"],
      [timed(13), "upheld"],
      [timed(15), "commit gate_error"],
      [timed(19), "pending"],
    ]);
    expect(rateOf("false-stops", record)).toEqual({ value: 0.25, count: 2, of: 8 });
  });

  test("places a denial with no repo in the repo of its session's project, and one in an unindexed path in none", () => {
    const placed = recordOf({
      sessions: [session("a", "2026-10-14T08:00:00.000Z")],
      hookEvents: [deny(timed(1), "repo_unclear"), deny(timed(2), "not_accepted", { repo: "/elsewhere" })],
    });
    expect(eventsOf("false-stops", placed).map((e) => [e.repo, e.sessionId])).toEqual([
      [REPO, "a"],
      [null, "a"],
    ]);
  });
});

describe("counting the returns before each reviewed commit", () => {
  test("bounds a commit's returns by the session's previous allow in its repo, and counts a retry once", () => {
    const record = recordOf({
      sessions: [session("a", "2026-10-14T08:00:00.000Z")],
      hookEvents: [
        said(timed(1), "return"),
        said(timed(2), "return"),
        said(timed(3), "accept"),
        allow(timed(4), { fingerprint: "f" }),
        allow(timed(5), { fingerprint: "f" }),
        said(timed(6), "return", { sessionId: "elsewhere" }),
        said(timed(7), "return"),
        said(timed(8), "accept"),
        allow(timed(9), { reason: "no_code_change" }),
        allow(timed(10), { reason: "no_code_change" }),
        said(timed(11), "return"),
      ],
    });
    expect(eventsOf("review-returns", record).map((e) => [e.at, e.kind])).toEqual([
      [timed(1), "return"],
      [timed(2), "return"],
      [timed(4), "reviewed commit"],
      [timed(7), "return"],
      [timed(9), "reviewed commit"],
    ]);
    expect(rateOf("review-returns", record)).toEqual({ value: 1.5, count: 3, of: 2 });
  });
});

describe("counting blocks by source per task", () => {
  test("counts each source over the Claude tasks given since the first hook event, and their blocks only", () => {
    const record = recordOf({
      sessions: [
        session("old", "2026-10-13T08:00:00.000Z"),
        session("a", "2026-10-14T09:00:00.000Z"),
        session("codex", "2026-10-14T09:30:00.000Z", { tool: "codex" }),
      ],
      ownerMessages: [{ sessionId: "a", at: timed(2), text: "now add the printer", agentBefore: TOLD }],
      hookEvents: [
        { at: timed(1), event: "permission_prompt", sessionId: "a", agent: null },
        { at: timed(3), event: "permission_prompt", sessionId: "a", agent: null },
        { at: timed(4), event: "permission_denied", sessionId: "a", agent: null, reason: "rule" },
        deny(timed(5), "not_accepted", { repo: REPO, fingerprint: "f" }),
        deny(timed(6), "missing_verdict", { gate: "verdict" }),
        allow(timed(7), {}),
      ],
    });
    expect(eventsOf("blocks", record).map((e) => e.kind)).toEqual([
      "permission prompt",
      "auto-mode denial",
      "commit gate",
      "verdict gate",
      "task",
    ]);
    expect(rateOf("blocks", record)).toEqual({ value: 4, count: 4, of: 1 });
  });
});

describe("counting skill loads per task by version", () => {
  const V1 = "1a2b3c4d5e6f";
  const V2 = "9f8e7d6c5b4a";
  const record = recordOf({
    sessions: [
      session("s", "2026-10-14T09:00:00.000Z"),
      session("sub", "2026-10-14T09:05:00.000Z", { parentId: "s" }),
    ],
    ownerMessages: [
      { sessionId: "s", at: "2026-10-14T09:30:00.000Z", text: "now add the printer", agentBefore: TOLD },
    ],
    skillLoads: [
      {
        sessionId: "s",
        at: "2026-10-14T09:01:00.000Z",
        skill: "plan",
        bodySha256: V1,
        install: "41c40cc68eb7",
      },
      { sessionId: "sub", at: "2026-10-14T09:06:00.000Z", skill: "plan", bodySha256: V2, install: null },
      { sessionId: "s", at: "2026-10-14T09:31:00.000Z", skill: "build", bodySha256: null, install: null },
    ],
  });

  test("names each load by its skill, the start of its hash and its install, on its top-level session", () => {
    const kinds = eventsOf("skill-usage", record).map((e) => [e.kind, e.sessionId]);
    expect(kinds).toEqual([
      ["plan 1a2b3c4d/41c40cc68eb7", "s"],
      ["plan 9f8e7d6c/-", "s"],
      ["build -/-", "s"],
      ["task", "s"],
      ["task", "s"],
    ]);
  });

  test("divides the loads by the tasks", () => {
    expect(rateOf("skill-usage", record)).toEqual({ value: 1.5, count: 3, of: 2 });
  });
});

test("names every signal once", () => {
  const names = SIGNALS.map((s) => s.name);
  expect(new Set(names).size).toBe(names.length);
  expect(() => signalNamed("false-stop")).toThrow(expect.objectContaining({ code: "unknown_signal" }));
});
