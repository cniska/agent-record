import { describe, expect, test } from "bun:test";
import type { GitRunRow, SessionRow, SignalRecord } from "./query-signal-record";
import { SIGNALS, signalNamed } from "./query-signals";
import { timelineOf } from "./query-timeline";

const REPO = "/h/code/demo";
const ASKED = "Done. Should I push?";
const TOLD = "Done, pushed.";

const session = (id: string, start: string, more: Partial<SessionRow> = {}): SessionRow => ({
  id,
  parentId: null,
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

test("names every signal once", () => {
  const names = SIGNALS.map((s) => s.name);
  expect(new Set(names).size).toBe(names.length);
  expect(() => signalNamed("false-stops")).toThrow(expect.objectContaining({ code: "unknown_signal" }));
});
