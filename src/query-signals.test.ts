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
  end: null,
  agentType: null,
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
  openings: [],
  rejections: [],
  gitRuns: [],
  tags: [],
  compactions: [],
  compactedSessionReads: [],
  commits: [],
  commitFiles: [],
  responses: [],
  subagentReturns: [],
  hookEvents: [],
  skillLoads: [],
  checkouts: [{ path: REPO, repo: REPO }],
  labels: new Map([[REPO, "me/demo"]]),
  newest: "2026-10-14T12:00:00.000Z",
  ...more,
});

const measuredOf = (name: string, record: SignalRecord) => signalNamed(name).measure(timelineOf(record));

const eventsOf = (name: string, record: SignalRecord) => measuredOf(name, record).events;

const detailOf = (name: string, record: SignalRecord) => {
  const measured = measuredOf(name, record);
  return measured.detail(measured.events);
};

const rateOf = (name: string, record: SignalRecord) => {
  const measured = measuredOf(name, record);
  return measured.rate(measured.events);
};

describe("counting the owner's interrupts per task", () => {
  const record = recordOf({
    sessions: [
      session("s", "2026-10-14T09:00:00.000Z"),
      session("sub", "2026-10-14T09:01:00.000Z", { parentId: "s" }),
    ],
    ownerMessages: [
      {
        id: "m1",
        turnId: null,
        sessionId: "s",
        at: "2026-10-14T09:00:00.000Z",
        text: "add the parser",
        agentBefore: null,
        midTurn: false,
      },
      {
        id: "m2",
        turnId: null,
        sessionId: "s",
        at: "2026-10-14T09:10:00.000Z",
        text: "the second",
        agentBefore: ASKED,
        midTurn: false,
      },
      {
        id: "m3",
        turnId: null,
        sessionId: "s",
        at: "2026-10-14T09:20:00.000Z",
        text: "no, the other file",
        agentBefore: TOLD,
        midTurn: false,
      },
      {
        id: "m4",
        turnId: null,
        sessionId: "s",
        at: "2026-10-14T09:30:00.000Z",
        text: "now add the printer",
        agentBefore: TOLD,
        midTurn: false,
      },
      {
        id: "m5",
        turnId: null,
        sessionId: "s",
        at: "2026-10-14T09:40:00.000Z",
        text: "<command-name>/clear</command-name>",
        agentBefore: TOLD,
        midTurn: false,
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

describe("counting a message the owner typed while a turn ran", () => {
  const typed = (at: string, text: string, agentBefore: string | null, midTurn: boolean) => ({
    id: at,
    turnId: null,
    sessionId: "s",
    at,
    text,
    agentBefore,
    midTurn,
  });
  const record = recordOf({
    sessions: [session("s", "2026-10-14T09:00:00.000Z")],
    ownerMessages: [
      typed("2026-10-14T09:00:00.000Z", "add the parser", null, false),
      typed("2026-10-14T09:01:00.000Z", "and the printer too", null, true),
      typed("2026-10-14T09:02:00.000Z", "use the lexer as well", TOLD, true),
      typed("2026-10-14T09:03:00.000Z", "no, commit msgs should be lowercase", TOLD, true),
    ],
  });

  test("counts it within the running task, never as a task's start", () => {
    expect(eventsOf("owner-interrupts", record).map((e) => [e.kind, e.at])).toEqual([
      ["correct", "2026-10-14T09:03:00.000Z"],
      ["task", "2026-10-14T09:00:00.000Z"],
    ]);
    expect(rateOf("owner-interrupts", record)).toEqual({ value: 1, count: 1, of: 1 });
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

  test("tags a task with the first value of each key written in it, a subagent's line too", () => {
    const record = recordOf({
      sessions: [
        session("a", "2026-10-14T09:00:00.000Z"),
        session("w", "2026-10-14T09:00:30.000Z", { parentId: "a" }),
        session("b", "2026-10-14T09:00:00.000Z"),
      ],
      gitRuns: [
        run("a", "2026-10-14T09:10:00.000Z", "commit"),
        run("b", "2026-10-14T09:10:00.000Z", "commit"),
      ],
      tags: [
        { sessionId: "w", at: "2026-10-14T09:01:00.000Z", key: "route", value: "feature" },
        { sessionId: "a", at: "2026-10-14T09:02:00.000Z", key: "route", value: "review" },
        { sessionId: "a", at: "2026-10-14T09:02:00.000Z", key: "size", value: "small" },
      ],
    });
    expect(eventsOf("time-to-land", record).map((e) => [e.sessionId, Object.fromEntries(e.tags)])).toEqual([
      ["a", { route: "feature", size: "small" }],
      ["b", {}],
    ]);
  });

  test("keeps apart the tasks of two sessions whose prompts share an id, as a fork copies it", () => {
    const opening = (sessionId: string) => ({
      id: `${sessionId}-m1`,
      turnId: "p1",
      sessionId,
      text: "fix it",
    });
    const record = recordOf({
      sessions: [session("a", "2026-10-14T09:00:00.000Z"), session("b", "2026-10-14T09:00:00.000Z")],
      openings: [opening("a"), opening("b")],
      gitRuns: [
        run("a", "2026-10-14T09:10:00.000Z", "commit"),
        run("a", "2026-10-14T09:15:00.000Z", "push"),
        run("b", "2026-10-14T09:20:00.000Z", "commit"),
      ],
      tags: [{ sessionId: "a", at: "2026-10-14T09:02:00.000Z", key: "route", value: "feature" }],
    });
    expect(
      eventsOf("time-to-land", record).map((e) => [
        e.sessionId,
        e.kind,
        e.minutes,
        Object.fromEntries(e.tags),
      ]),
    ).toEqual([
      ["a", "landed", 15, { route: "feature" }],
      ["b", "not landed", null, {}],
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
  head: null,
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
  counted: null,
  ...more,
});

const NO_FINDINGS = { critical: 0, major: 0, minor: 0, fix: 0, consider: 0, unrated: 0 };

describe("summing the findings verdicts counted", () => {
  test("sums each counted verdict's findings, conflicts and cited rules, and skips a verdict that counted none", () => {
    const record = recordOf({
      sessions: [session("a", "2026-10-14T08:00:00.000Z")],
      hookEvents: [
        said("2026-10-14T09:00:00.000Z", "return", {
          counted: {
            findings: { ...NO_FINDINGS, major: 2, minor: 1 },
            conflicts: 1,
            rules: ["Clear names", "Clear names"],
          },
        }),
        said("2026-10-14T09:10:00.000Z", "return", {
          counted: { findings: { ...NO_FINDINGS, unrated: 1 }, conflicts: 0, rules: [] },
        }),
        said("2026-10-14T09:20:00.000Z", "accept", {
          counted: { findings: NO_FINDINGS, conflicts: 0, rules: [] },
        }),
        said("2026-10-14T09:30:00.000Z", "accept"),
      ],
    });
    expect(rateOf("review-findings", record)).toEqual({ value: 1.33, count: 4, of: 3 });
    const cited = eventsOf("review-findings", record).filter((e) => e.rule !== null);
    expect(cited.map((e) => [e.kind, e.rule])).toEqual([
      ["cited", "Clear names"],
      ["cited", "Clear names"],
    ]);
    expect(eventsOf("review-findings", record).filter((e) => e.kind === "conflict")).toHaveLength(1);
  });
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
      ownerMessages: [
        {
          id: "m6",
          turnId: null,
          sessionId: "a",
          at: timed(2),
          text: "now add the printer",
          agentBefore: TOLD,
          midTurn: false,
        },
      ],
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
      {
        id: "m7",
        turnId: null,
        sessionId: "s",
        at: "2026-10-14T09:30:00.000Z",
        text: "now add the printer",
        agentBefore: TOLD,
        midTurn: false,
      },
    ],
    skillLoads: [
      {
        sessionId: "s",
        at: "2026-10-14T09:01:00.000Z",
        skill: "plan",
        bodySha256: V1,
        install: "abcdef012345",
        preloaded: false,
      },
      {
        sessionId: "sub",
        at: "2026-10-14T09:06:00.000Z",
        skill: "plan",
        bodySha256: V2,
        install: null,
        preloaded: true,
      },
      {
        sessionId: "s",
        at: "2026-10-14T09:31:00.000Z",
        skill: "build",
        bodySha256: null,
        install: null,
        preloaded: false,
      },
    ],
  });

  test("names each load by its skill, the start of its hash and its install, on its top-level session", () => {
    const kinds = eventsOf("skill-usage", record).map((e) => [e.kind, e.sessionId]);
    expect(kinds).toEqual([
      ["plan 1a2b3c4d/abcdef012345", "s"],
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

describe("counting files read again after a compaction", () => {
  const read = (sessionId: string, minute: number, path: string) => ({ sessionId, at: timed(minute), path });
  const record = recordOf({
    sessions: [
      session("a", "2026-10-14T08:00:00.000Z"),
      session("sub", "2026-10-14T08:30:00.000Z", { parentId: "a" }),
    ],
    compactions: [
      { sessionId: "a", at: timed(10) },
      { sessionId: "a", at: timed(20) },
      { sessionId: "sub", at: timed(30) },
    ],
    compactedSessionReads: [
      read("a", 1, "/r/one.ts"),
      read("a", 2, "/r/two.ts"),
      read("a", 11, "/r/one.ts"),
      read("a", 12, "/r/one.ts"),
      read("a", 13, "/r/new.ts"),
      read("a", 21, "/r/two.ts"),
      read("a", 22, "/r/new.ts"),
      read("sub", 25, "/r/sub.ts"),
      read("a", 31, "/r/sub.ts"),
    ],
  });

  test("counts each file read before a compaction, since the one before, and again before the next, once", () => {
    expect(
      eventsOf("lost-context", record).map((e) => [e.at, e.kind, e.minutes, e.text, e.sessionId]),
    ).toEqual([
      [timed(10), "compaction", null, null, "a"],
      [timed(10), "re-read", 1, "/r/one.ts", "a"],
      [timed(20), "compaction", null, null, "a"],
      [timed(20), "re-read", 2, "/r/new.ts", "a"],
      [timed(30), "compaction", null, null, "a"],
    ]);
  });

  test("divides the re-reads by the compactions", () => {
    expect(rateOf("lost-context", record)).toEqual({ value: 0.67, count: 2, of: 3 });
  });
});

describe("counting fix commits that point back at an earlier accepted commit", () => {
  const sha = (digit: string) => digit.repeat(40);
  const commit = (digit: string, minute: number, subject: string, repo = REPO) => ({
    sha: sha(digit),
    repo,
    at: timed(minute),
    subject,
    kind: subject.split(":")[0] ?? null,
  });
  const files = (digit: string, ...paths: string[]) =>
    paths.map((path) => ({ sha: sha(digit), path: `${REPO}/${path}` }));
  const record = recordOf({
    sessions: [session("a", "2026-10-14T08:00:00.000Z")],
    hookEvents: [
      allow(timed(0), { agent: "w1" }),
      allow(timed(2)),
      allow(timed(4), { reason: "no_code_change", agent: "w2" }),
      allow(timed(6), { repo: null, head: sha("1") }),
      allow(timed(8)),
      allow(timed(11), { agent: "w1" }),
    ],
    commits: [
      { ...commit("0", 0, "fix: before the log"), at: "2026-10-14T08:30:00.000Z" },
      commit("1", 1, "feat: add a"),
      commit("2", 3, "docs: note b"),
      commit("3", 5, "fix: a again"),
      commit("4", 5, "fix: a again"),
      commit("5", 7, "fix: b and the readme"),
      commit("6", 9, "fix: undo 1111111"),
      commit("7", 10, "feat: elsewhere", OTHER),
      commit("8", 12, "fix: a by its author"),
    ],
    commitFiles: [
      ...files("0", "src/a.ts"),
      ...files("1", "src/a.ts", "src/a.test.ts", "README.md"),
      ...files("2", "src/b.ts"),
      ...files("3", "src/a.ts"),
      ...files("4", "src/a.ts"),
      ...files("5", "src/b.ts", "src/a.test.ts", "README.md"),
      ...files("8", "src/a.ts"),
    ],
  });

  test("names the earlier commit a fix by another agent shares a file with, or names in its subject", () => {
    expect(eventsOf("escaped-defects", record).map((e) => [e.at, e.kind, e.minutes, e.text])).toEqual([
      [timed(1), "accepted commit", null, "11111111"],
      [timed(3), "accepted commit", null, "22222222"],
      [timed(7), "accepted commit", null, "55555555"],
      [timed(9), "accepted commit", null, "66666666"],
      [timed(12), "accepted commit", null, "88888888"],
      [timed(5), "shared file", 4, "33333333 fix: a again <- 11111111"],
      [timed(9), "names commit", 8, "66666666 fix: undo 1111111 <- 11111111"],
    ]);
  });

  test("divides the escapes by the accepted commits", () => {
    expect(rateOf("escaped-defects", record)).toEqual({ value: 0.4, count: 2, of: 5 });
  });
});

describe("costing each step of every loop by its tokens and minutes", () => {
  const load = (sessionId: string, minute: number, skill: string, digit: string, preloaded = false) => ({
    sessionId,
    at: timed(minute),
    skill,
    bodySha256: digit.repeat(12),
    install: null,
    preloaded,
  });
  const spent = (sessionId: string, minute: number, output: number, input: number) => ({
    sessionId,
    at: timed(minute),
    output,
    input,
  });
  const record = recordOf({
    sessions: [
      session("a", timed(0)),
      session("w", timed(10), { parentId: "a", agentType: "general-purpose" }),
      session("r", timed(20), { parentId: "a", agentType: "acme:checker" }),
      session("e", timed(25), { parentId: "a", agentType: "Explore" }),
    ],
    ownerMessages: [
      {
        id: "m8",
        turnId: null,
        sessionId: "a",
        at: timed(0),
        text: "add the parser",
        agentBefore: null,
        midTurn: false,
      },
      {
        id: "m9",
        turnId: null,
        sessionId: "a",
        at: timed(40),
        text: "now add the printer",
        agentBefore: TOLD,
        midTurn: false,
      },
    ],
    subagentReturns: [{ sessionId: "a", at: timed(30) }],
    skillLoads: [
      load("a", 0, "plan", "a"),
      load("w", 11, "deploy", "b"),
      load("w", 12, "lint", "c"),
      load("r", 20, "style", "d", true),
    ],
    responses: [
      spent("a", 1, 10, 1000),
      spent("a", 31, 10, 2000),
      spent("a", 45, 10, 3000),
      spent("w", 10, 2, 200),
      spent("w", 11, 5, 500),
      spent("w", 13, 5, 600),
      spent("w", 14, 5, 700),
      spent("r", 22, 20, 800),
      spent("e", 26, 1, 100),
    ],
    hookEvents: [allow(timed(35))],
    commits: [
      { sha: "1".repeat(40), repo: REPO, at: timed(36), subject: "feat: add the parser", kind: "feat" },
    ],
  });

  test("names each stretch by a namespaced agent type after its colon, or else by the last skill loaded, timed from the owner or a subagent's return", () => {
    expect(eventsOf("step-cost", record).map((e) => [e.at, e.kind, e.minutes, e.version, e.text])).toEqual([
      [timed(1), "plan", 2, "plan aaaaaaaa", "output 20, input 3000, plan aaaaaaaa"],
      [timed(45), "plan", 5, "plan aaaaaaaa", "output 10, input 3000, plan aaaaaaaa"],
      [timed(10), "general-purpose", 0, null, "output 2, input 200, -"],
      [timed(11), "deploy", 1, "deploy bbbbbbbb", "output 5, input 500, deploy bbbbbbbb"],
      [timed(13), "lint", 3, "lint cccccccc", "output 10, input 1300, lint cccccccc"],
      [timed(22), "checker", 2, "style dddddddd", "output 20, input 800, style dddddddd"],
      [timed(26), "Explore", 1, null, "output 1, input 100, -"],
    ]);
  });

  test("divides the input by the accepted commits of the tasks the steps ran in", () => {
    expect(rateOf("step-cost", record)).toEqual({ value: 8900, count: 8900, of: 1 });
    expect(detailOf("step-cost", record)).toBe(
      "per accepted commit output 68, minutes 14; per task over 2 tasks input 4450, output 34, minutes 7; " +
        "most input per accepted commit: plan 6000, lint 1300, checker 800, deploy 500, general-purpose 200",
    );
  });
});

describe("counting the owner's asks for another model's read per task", () => {
  const said = (at: string, text: string) => ({
    id: at,
    turnId: null,
    sessionId: "s",
    at,
    text,
    agentBefore: TOLD,
    midTurn: false,
  });
  const record = recordOf({
    sessions: [session("s", "2026-10-14T09:00:00.000Z")],
    ownerMessages: [
      {
        id: "m10",
        turnId: null,
        sessionId: "s",
        at: "2026-10-14T09:00:00.000Z",
        text: "add the parser",
        agentBefore: null,
        midTurn: false,
      },
      said("2026-10-14T09:10:00.000Z", "ask fable to design this"),
      said("2026-10-14T09:20:00.000Z", "what does fable think?"),
      said("2026-10-14T09:30:00.000Z", "what did fable's review say"),
      said("2026-10-14T09:40:00.000Z", "get a second opinion on this"),
      said("2026-10-14T09:50:00.000Z", "# Handoff\n\nAsk fable to plan it."),
      said("2026-10-14T10:00:00.000Z", '<pasted_content id="1">ask fable</pasted_content id="1">\nship it'),
      said("2026-10-14T10:10:00.000Z", "<command-name>/fable</command-name> ask fable"),
    ],
  });

  test("counts an ask by its verb, Fable as the subject, Fable's view or the phrase, not a quote or a paste", () => {
    expect(eventsOf("second-read-asks", record).flatMap((e) => (e.kind === "ask" ? [e.text] : []))).toEqual([
      "ask fable to design this",
      "what does fable think?",
      "get a second opinion on this",
    ]);
  });

  test("divides the asks by the tasks of the sessions the owner typed in", () => {
    expect(rateOf("second-read-asks", record)).toEqual({ value: 0.43, count: 3, of: 7 });
  });
});

test("names every signal once", () => {
  const names = SIGNALS.map((s) => s.name);
  expect(new Set(names).size).toBe(names.length);
  expect(() => signalNamed("false-stop")).toThrow(expect.objectContaining({ code: "unknown_signal" }));
});
