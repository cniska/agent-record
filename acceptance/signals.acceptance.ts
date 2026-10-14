import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import { type ClaudeSession, type Step, withClaudeSessions } from "./claude-sessions";
import {
  type Home,
  QUERY_RESULT,
  refused,
  removeScratch,
  runCli,
  scratchDirOutsideTemp,
  scratchHome,
  scratchRepo,
  scratchTempDir,
  succeeded,
  sync,
} from "./cli";

afterEach(removeScratch);

const query = (home: Home, args: readonly string[]) =>
  succeeded(runCli(home, ["query", ...args]), "query", QUERY_RESULT);

const synced = (sessions: readonly ClaudeSession[]): Home => {
  const home = withClaudeSessions(scratchHome(), sessions);
  sync(home);
  return home;
};

const ORIGIN = "git@github.com:acme/app.git";

const appRepo = (commits: { readonly subject: string; readonly at: string }[] = []): string =>
  scratchRepo(
    join(scratchDirOutsideTemp(), "app"),
    ORIGIN,
    [{ subject: "start", at: "2026-09-01T00:00:00Z" }, ...commits].map((c, i) => ({
      ...c,
      file: `f${i}.txt`,
    })),
  );

const ran = (bash: string, at: string, done: string): Step => ({ bash, at, done });

const later = (at: string): Step => ({ owner: "thanks, that is all for today", at });

test("AC-40 owner-interrupts counts one interrupt of each cause over two tasks, none from a subagent", () => {
  const home = synced([
    {
      id: "ask",
      cwd: "/Users/x/code/demo",
      steps: [
        { owner: "add the parser", at: "2026-09-16T09:00:00Z" },
        { agent: "Which file should hold it?", at: "2026-09-16T09:01:00Z" },
        { owner: "the second one", at: "2026-09-16T09:02:00Z" },
        { agent: "Done, wrote it.", at: "2026-09-16T09:03:00Z" },
        { owner: "no, put it in src", at: "2026-09-16T09:04:00Z" },
        { agent: "Moved. Ready to push.", at: "2026-09-16T09:05:00Z" },
        { owner: "go ahead", at: "2026-09-16T09:06:00Z" },
        { agent: "Pushing.", at: "2026-09-16T09:07:00Z" },
        { owner: "[Request interrupted by user]", at: "2026-09-16T09:08:00Z" },
        { rejected: "rm -rf build", at: "2026-09-16T09:09:00Z" },
        { agent: "Stopped.", at: "2026-09-16T09:10:00Z" },
        { owner: "now add the printer", at: "2026-09-16T09:11:00Z" },
      ],
      subagents: [
        {
          id: "helper",
          agentType: "Explore",
          steps: [
            { owner: "look around", at: "2026-09-16T09:01:30Z" },
            { agent: "Should I look further?", at: "2026-09-16T09:01:40Z" },
            { owner: "yes", at: "2026-09-16T09:01:50Z" },
          ],
        },
      ],
    },
  ]);

  const weekly = query(home, ["signal", "owner-interrupts"]);
  expect(weekly.columns).toEqual(["week", "value", "count", "of", "kinds"]);
  expect(weekly.rows).toEqual([
    ["2026-09-14", 2.5, 5, 2, "task 2, stop 1, permission 1, answer 1, correct 1, unblock 1"],
  ]);

  const events = query(home, ["signal-events", "owner-interrupts"]);
  expect(events.columns).toEqual(["at", "kind", "repo", "route", "minutes", "session", "text"]);
  expect(events.rows.map(([at, kind, , , , session, text]) => [at, kind, session, text])).toEqual([
    ["2026-09-16T09:11:00.000Z", "task", "ask", null],
    ["2026-09-16T09:09:00.000Z", "permission", "ask", null],
    ["2026-09-16T09:08:00.000Z", "stop", "ask", "[Request interrupted by user]"],
    ["2026-09-16T09:06:00.000Z", "unblock", "ask", "go ahead"],
    ["2026-09-16T09:04:00.000Z", "correct", "ask", "no, put it in src"],
    ["2026-09-16T09:02:00.000Z", "answer", "ask", "the second one"],
    ["2026-09-16T09:00:00.000Z", "task", "ask", null],
  ]);
});

test("AC-41 time-to-land gives the median minutes of the landed tasks and counts one not landed", () => {
  const repo = appRepo();
  const elsewhere = scratchTempDir();
  const home = synced([
    {
      id: "pushes",
      cwd: repo,
      steps: [
        { owner: "task one", at: "2026-09-16T10:00:00Z" },
        ran("git commit -m a && git push", "2026-09-16T10:05:00Z", "2026-09-16T10:06:00Z"),
      ],
    },
    {
      id: "cds",
      cwd: elsewhere,
      steps: [
        { owner: "task two", at: "2026-09-16T11:00:00Z" },
        ran(`cd ${repo} && git commit -m b`, "2026-09-16T11:09:00Z", "2026-09-16T11:10:00Z"),
      ],
    },
    {
      id: "lands",
      cwd: repo,
      steps: [
        { owner: "push what is there", at: "2026-09-16T12:00:00Z" },
        ran("git push", "2026-09-16T12:29:00Z", "2026-09-16T12:30:00Z"),
      ],
    },
    {
      id: "strands",
      cwd: repo,
      steps: [
        { owner: "task four", at: "2026-09-16T13:00:00Z" },
        ran("git commit -m d", "2026-09-16T13:04:00Z", "2026-09-16T13:05:00Z"),
      ],
    },
  ]);

  expect(query(home, ["signal", "time-to-land"]).rows).toEqual([
    ["2026-09-14", 48, 2, 3, "landed 2, not landed 1"],
  ]);
  const events = query(home, ["signal-events", "time-to-land"]).rows;
  expect(events.map(([, kind, , , minutes, session]) => [session, kind, minutes])).toEqual([
    ["strands", "not landed", null],
    ["cds", "landed", 90],
    ["pushes", "landed", 6],
  ]);
});

test("AC-42 stranded-work counts two stranded commit runs of three, one of them ended unpushed", () => {
  const repo = appRepo();
  const home = synced([
    {
      id: "work",
      cwd: repo,
      steps: [
        { owner: "ship the three slices", at: "2026-09-16T08:50:00Z" },
        ran("git commit -m a", "2026-09-16T09:00:00Z", "2026-09-16T09:00:00Z"),
        ran("git push", "2026-09-16T09:30:00Z", "2026-09-16T09:30:00Z"),
        ran("git commit -m b", "2026-09-16T10:00:00Z", "2026-09-16T10:00:00Z"),
        ran("git push", "2026-09-16T11:30:00Z", "2026-09-16T11:30:00Z"),
        ran("git commit -m c", "2026-09-16T12:00:00Z", "2026-09-16T12:00:00Z"),
      ],
    },
    { id: "after", cwd: repo, steps: [later("2026-09-16T14:00:00Z")] },
  ]);

  expect(query(home, ["signal", "stranded-work"]).rows).toEqual([
    ["2026-09-14", 0.67, 2, 3, "pushed 1, stranded 1, ended unpushed 1"],
  ]);
});

test("AC-43 review-loops gives two reviewer runs per commit run", () => {
  const repo = appRepo();
  const home = synced([
    {
      id: "reviewed",
      cwd: repo,
      steps: [
        { owner: "build it and have it reviewed", at: "2026-09-16T09:00:00Z" },
        ran("git commit -m a", "2026-09-16T09:30:00Z", "2026-09-16T09:30:00Z"),
      ],
      subagents: [
        {
          id: "r1",
          agentType: "cniska-skills:reviewer",
          steps: [{ agent: "Fix: x", at: "2026-09-16T09:10:00Z" }],
        },
        {
          id: "r2",
          agentType: "cniska-skills:reviewer",
          steps: [{ agent: "Accept", at: "2026-09-16T09:20:00Z" }],
        },
        { id: "e1", agentType: "Explore", steps: [{ agent: "Found it", at: "2026-09-16T09:05:00Z" }] },
      ],
    },
  ]);

  expect(query(home, ["signal", "review-loops"]).rows).toEqual([
    ["2026-09-14", 2, 2, 1, "reviewer run 2, commit run 1"],
  ]);
});

const ROUTE = "/Users/x/.claude/plugins/cniska-skills/skills/task/references/feature.md";

const twoWeeks = (repo: string): readonly ClaudeSession[] => [
  {
    id: "first",
    cwd: repo,
    steps: [
      { owner: "add the parser", at: "2026-09-16T09:00:00Z" },
      { read: ROUTE, at: "2026-09-16T09:01:00Z" },
      ran("git commit -m a && git push", "2026-09-16T09:30:00Z", "2026-09-16T09:30:00Z"),
    ],
  },
  {
    id: "second",
    cwd: repo,
    steps: [
      { owner: "add the printer", at: "2026-09-21T09:00:00Z" },
      ran("git commit -m b", "2026-09-21T09:30:00Z", "2026-09-21T09:30:00Z"),
    ],
  },
  {
    id: "third",
    cwd: repo,
    steps: [
      { owner: "add the linter", at: "2026-09-23T09:00:00Z" },
      ran("git commit -m c && git push", "2026-09-23T09:30:00Z", "2026-09-23T09:30:00Z"),
      later("2026-09-23T12:00:00Z"),
    ],
  },
];

test("AC-44 signal splits each week by repo or route, newest first, and refuses an unknown name or --by", () => {
  const repo = appRepo();
  const home = synced(twoWeeks(repo));

  expect(query(home, ["signal", "stranded-work"]).rows).toEqual([
    ["2026-09-21", 0.5, 1, 2, "pushed 1, stranded 1"],
    ["2026-09-14", 0, 0, 1, "pushed 1"],
  ]);
  const byRepo = query(home, ["signal", "stranded-work", "--by", "repo"]);
  expect(byRepo.columns).toEqual(["week", "repo", "label", "value", "count", "of", "kinds"]);
  expect(byRepo.rows.map(([week, shown, label]) => [week, shown, label])).toEqual([
    ["2026-09-21", repo, "acme/app"],
    ["2026-09-14", repo, "acme/app"],
  ]);
  expect(
    query(home, ["signal", "time-to-land", "--by", "route"]).rows.map(([week, route, value]) => [
      week,
      route,
      value,
    ]),
  ).toEqual([
    ["2026-09-21", "none", 1470],
    ["2026-09-14", "feature", 30],
  ]);

  const unknown = refused(runCli(home, ["query", "signal", "false-stop"]), "query");
  expect({ code: unknown.code, resolve: unknown.resolve }).toEqual({
    code: "unknown_signal",
    resolve:
      "one of: owner-interrupts, time-to-land, stranded-work, review-loops, false-stops, review-returns, blocks, " +
      "skill-usage",
  });
  const grouping = refused(runCli(home, ["query", "signal", "stranded-work", "--by", "day"]), "query");
  expect({ code: grouping.code, resolve: grouping.resolve }).toEqual({
    code: "unknown_grouping",
    resolve: "--by <week|repo|route>",
  });
});

test("AC-45 before-after compares every signal on either side of a commit, from --from when given to the second or the minute", () => {
  const repo = appRepo([{ subject: "change the workflow", at: "2026-09-18T00:00:00Z" }]);
  const home = synced(twoWeeks(repo));
  const sha = succeeded(
    runCli(home, ["sql", "SELECT sha FROM repo_commit WHERE subject = 'change the workflow'"]),
    "sql",
    QUERY_RESULT,
  ).rows[0]?.[0];
  if (typeof sha !== "string") throw new Error("the fixture commit is in the record");
  const prefix = sha.slice(0, 8);

  const around = query(home, ["before-after", prefix]);
  expect(around.columns).toEqual([
    "signal",
    "value",
    "before",
    "after",
    "before_count",
    "before_of",
    "after_count",
    "after_of",
  ]);
  const stranded = (rows: typeof around.rows) =>
    rows.find(([name]) => name === "stranded-work")?.filter((_, i) => i !== 1);
  expect(stranded(around.rows)).toEqual(["stranded-work", 0, 0.5, 0, 1, 1, 2]);
  expect(around.rows.map(([name]) => name)).toEqual([
    "owner-interrupts",
    "time-to-land",
    "stranded-work",
    "review-loops",
    "false-stops",
    "review-returns",
    "blocks",
    "skill-usage",
  ]);
  expect(around.denominator).toBe(
    `commit ${sha} at 2026-09-18T00:00:00.000Z; before 2026-09-04T00:00:00.000Z to 2026-09-18T00:00:00.000Z, ` +
      "after 2026-09-18T00:00:00.000Z to 2026-09-23T12:00:00.001Z",
  );

  const fromLater = query(home, ["before-after", prefix, "--from", "2026-09-22T00:00:00Z"]);
  expect(stranded(fromLater.rows)).toEqual(["stranded-work", 0, 0, 0, 1, 0, 1]);
  const fromMinute = query(home, ["before-after", prefix, "--from", "2026-09-22T00:00Z"]);
  expect(fromMinute.rows).toEqual(fromLater.rows);
  expect(fromMinute.denominator).toBe(fromLater.denominator);

  const codes = [
    ["before-after", "0000000"],
    ["before-after", prefix, "--days", "0"],
    ["before-after", prefix, "--from", "2026-09-01T00:00:00Z"],
    ["before-after", prefix, "--from", "2026-09-22T00:00"],
  ].map((args) => refused(runCli(home, ["query", ...args]), "query").code);
  expect(codes).toEqual(["unknown_commit", "not_a_count", "from_before_commit", "not_a_time"]);
});

test("AC-50 skill-usage counts each skill version loaded per task, an agent's preload too", () => {
  const cache = (install: string, name: string) =>
    `/Users/x/.claude/plugins/cache/m/acme/${install}/skills/${name}`;
  const plan = "# Plan\n\nWrite the plan.";
  const home = synced([
    {
      id: "first",
      cwd: "/Users/x/code/demo",
      steps: [
        { owner: "plan the parser", at: "2026-09-16T09:00:00Z" },
        {
          skill: "acme:plan",
          at: "2026-09-16T09:01:00Z",
          dir: cache("aaa", "plan"),
          body: `${plan}\n\n\nARGUMENTS: the parser`,
        },
        { skill: "plan", at: "2026-09-16T09:02:00Z", dir: cache("aaa", "plan"), body: `${plan}\n` },
      ],
      subagents: [
        {
          id: "judge",
          agentType: "acme:reviewer",
          steps: [
            { owner: "review the plan", at: "2026-09-16T09:03:00Z" },
            {
              preload: "acme:review",
              at: "2026-09-16T09:03:01Z",
              dir: cache("aaa", "review"),
              body: "# Review\n\nJudge the change.",
            },
          ],
        },
      ],
    },
    {
      id: "second",
      cwd: "/Users/x/code/demo",
      steps: [
        { owner: "plan the printer", at: "2026-09-22T09:00:00Z" },
        {
          skill: "acme:plan",
          at: "2026-09-22T09:01:00Z",
          dir: cache("bbb", "plan"),
          body: "# Plan\n\nWrite the plan, then ask.",
        },
      ],
    },
  ]);

  expect(query(home, ["signal", "skill-usage"]).rows).toEqual([
    ["2026-09-21", 1, 1, 1, "task 1, plan ed00dff6/bbb 1"],
    ["2026-09-14", 3, 3, 1, "plan 002f7b2a/aaa 2, task 1, review 43e4e411/aaa 1"],
  ]);
});
