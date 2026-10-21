import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import { type ClaudeSession, type Step, withClaudeSessions } from "./claude-sessions";
import {
  commitTo,
  type Home,
  landAndRemoveWorktree,
  QUERY_RESULT,
  rebuild,
  refused,
  removeScratchDirs,
  runCli,
  scratchDir,
  scratchDirOutsideTemp,
  scratchHome,
  scratchRepo,
  scratchWorktree,
  succeeded,
  sync,
} from "./cli";
import { gate, verdict, withEventLog } from "./hook-events";

afterEach(removeScratchDirs);

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
  expect(events.columns).toEqual(["at", "kind", "repo", "tags", "minutes", "session", "text"]);
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
  const elsewhere = scratchDir();
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

test("AC-70 a commit run in a worktree removed before sync counts in the repo its commit landed in, and so does its push", () => {
  const repo = appRepo();
  const subject = "feat: add the parser";
  const worktree = scratchWorktree(repo, join(scratchDirOutsideTemp(), "trees", "slice"), {
    subject,
    file: "src/parser.ts",
    at: "2026-09-16T09:00:01Z",
  });
  landAndRemoveWorktree(repo, worktree);
  const home = synced([
    {
      id: "work",
      cwd: repo,
      steps: [
        { owner: "add the parser", at: "2026-09-16T08:50:00Z" },
        ran(`git -C ${worktree} commit -m "${subject}"`, "2026-09-16T09:00:00Z", "2026-09-16T09:00:02Z"),
        ran(`git -C ${worktree} push`, "2026-09-16T09:30:00Z", "2026-09-16T09:30:00Z"),
      ],
    },
    { id: "after", cwd: repo, steps: [later("2026-09-16T14:00:00Z")] },
  ]);

  expect(query(home, ["signal", "stranded-work", "--by", "repo"]).rows).toEqual([
    ["2026-09-14", repo, "acme/app", 0, 0, 1, "pushed 1"],
  ]);
});

const counts = (more: Readonly<Record<string, number>> = {}) => ({
  critical: 0,
  major: 0,
  minor: 0,
  fix: 0,
  consider: 0,
  unrated: 0,
  ...more,
});

test("AC-43 review-findings sums the findings counted verdicts carry, by kind, rule and repo, through a rebuild", () => {
  const repo = appRepo();
  const other = "/Users/x/code/elsewhere";
  const home = withEventLog(withClaudeSessions(scratchHome(), []), "judged", [
    verdict("2026-09-16T10:00:00Z", {
      verdict: "return",
      repo,
      agent: "judge-1",
      findings: counts({ critical: 1, major: 1, minor: 1 }),
      conflicts: 1,
      rules: ["Clear names", "Clear names", "One source"],
    }),
    verdict("2026-09-16T10:05:00Z", {
      verdict: "return",
      repo,
      agent: "judge-2",
      findings: counts({ fix: 1, consider: 1, unrated: 1 }),
      conflicts: 0,
      rules: ["Root causes"],
    }),
    verdict("2026-09-16T10:10:00Z", {
      verdict: "accept",
      repo: other,
      agent: "judge-3",
      findings: counts(),
      conflicts: 0,
      rules: [],
    }),
    verdict("2026-09-16T10:15:00Z", { verdict: "accept", repo, agent: "judge-4" }),
    verdict("2026-09-16T10:20:00Z", {
      verdict: "accept",
      repo,
      agent: "judge-5",
      findings: counts({ major: -1 }),
    }),
  ]);
  const report = sync(home);
  const counted = () => query(home, ["signal", "review-findings"]).rows;
  const weekly = [
    [
      "2026-09-14",
      2,
      6,
      3,
      "cited 4, verdict 3, critical 1, major 1, minor 1, fix 1, consider 1, unrated 1, conflict 1",
    ],
  ];

  expect(report.dropped).toHaveLength(1);
  expect(counted()).toEqual(weekly);
  const byRule = query(home, ["signal", "review-findings", "--by", "rule"]);
  expect(byRule.columns).toEqual(["week", "rule", "value", "count", "of", "kinds"]);
  expect(byRule.rows.map(([week, rule, , count, of, kinds]) => [week, rule, count, of, kinds])).toEqual([
    [
      "2026-09-14",
      null,
      6,
      3,
      "verdict 3, critical 1, major 1, minor 1, fix 1, consider 1, unrated 1, conflict 1",
    ],
    ["2026-09-14", "Clear names", 0, 0, "cited 2"],
    ["2026-09-14", "One source", 0, 0, "cited 1"],
    ["2026-09-14", "Root causes", 0, 0, "cited 1"],
  ]);
  const byRepo = query(home, ["signal", "review-findings", "--by", "repo"]);
  expect(byRepo.rows.map(([week, shown, , , count, of]) => [week, shown, count, of])).toEqual([
    ["2026-09-14", repo, 6, 2],
    ["2026-09-14", null, 0, 1],
  ]);
  expect(
    query(home, ["signal-events", "review-findings"])
      .rows.filter(([, kind]) => kind === "cited")
      .map(([, , , , , , text]) => text),
  ).toEqual(["Root causes", "Clear names", "Clear names", "One source"]);

  rebuild(home);
  expect(counted()).toEqual(weekly);
});

const twoWeeks = (repo: string): readonly ClaudeSession[] => [
  {
    id: "first",
    cwd: repo,
    steps: [
      { owner: "add the parser", at: "2026-09-16T09:00:00Z" },
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

test("AC-44 signal splits each week by repo or a tag's key, newest first, and refuses an unknown name or --by", () => {
  const repo = appRepo();
  const home = withEventLog(withClaudeSessions(scratchHome(), twoWeeks(repo)), "first", [
    { ts: "2026-09-16T09:01:00Z", event: "tag", key: "route", value: "feature" },
    { ts: "2026-09-16T09:02:00Z", event: "tag", key: "route", value: "review" },
    { ts: "2026-09-16T09:03:00Z", event: "tag", key: "repo", value: "elsewhere" },
    { ts: "2026-09-16T09:04:00Z", event: "tag", key: "count", value: "3" },
  ]);
  sync(home);

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
  const byRoute = query(home, ["signal", "time-to-land", "--by", "route"]);
  expect(byRoute.columns).toEqual(["week", "route", "value", "count", "of", "kinds"]);
  expect(byRoute.rows.map(([week, route, value]) => [week, route, value])).toEqual([
    ["2026-09-21", "none", 1470],
    ["2026-09-14", "feature", 30],
  ]);

  const unknown = refused(runCli(home, ["query", "signal", "false-stop"]), "query");
  expect({ code: unknown.code, resolve: unknown.resolve }).toEqual({
    code: "unknown_signal",
    resolve:
      "one of: owner-interrupts, time-to-land, stranded-work, review-findings, false-stops, review-returns, blocks, " +
      "skill-usage, lost-context, escaped-defects, step-cost, second-read-asks",
  });
  for (const by of ["day", "count"]) {
    const grouping = refused(runCli(home, ["query", "signal", "stranded-work", "--by", by]), "query");
    expect({ code: grouping.code, resolve: grouping.resolve }).toEqual({
      code: "unknown_grouping",
      resolve: "--by <week|repo|version|rule|route>",
    });
  }
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
    "review-findings",
    "false-stops",
    "review-returns",
    "blocks",
    "skill-usage",
    "lost-context",
    "escaped-defects",
    "step-cost",
    "second-read-asks",
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
          agentType: "acme:checker",
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

test("AC-51 --skill keeps the tasks that loaded a skill and before-after names the versions on each side", () => {
  const repo = appRepo([{ subject: "change the plan skill", at: "2026-09-18T00:00:00Z" }]);
  const plan = {
    skill: "acme:plan",
    dir: "/Users/x/.claude/plugins/cache/m/acme/aaa/skills/plan",
    body: "# Plan\n\nWrite the plan.",
  };
  const home = synced([
    {
      id: "first",
      cwd: repo,
      steps: [
        { owner: "add the parser", at: "2026-09-16T09:00:00Z" },
        { ...plan, at: "2026-09-16T09:01:00Z" },
        ran("git commit -m a && git push", "2026-09-16T09:30:00Z", "2026-09-16T09:30:00Z"),
      ],
    },
    {
      id: "second",
      cwd: repo,
      steps: [
        { owner: "add the printer", at: "2026-09-21T09:00:00Z" },
        { ...plan, at: "2026-09-21T09:01:00Z" },
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
  ]);

  const scoped = query(home, ["signal", "stranded-work", "--skill", "plan"]);
  expect(scoped.rows).toEqual([
    ["2026-09-21", 1, 1, 1, "stranded 1"],
    ["2026-09-14", 0, 0, 1, "pushed 1"],
  ]);
  expect(scoped.denominator).toEndWith(", in the tasks that loaded plan");

  const sha = succeeded(
    runCli(home, ["sql", "SELECT sha FROM repo_commit WHERE subject = 'change the plan skill'"]),
    "sql",
    QUERY_RESULT,
  ).rows[0]?.[0];
  if (typeof sha !== "string") throw new Error("the fixture commit is in the record");
  const prefix = sha.slice(0, 8);

  const stale = query(home, ["before-after", prefix, "--skill", "plan"]);
  expect(stale.rows.find(([name]) => name === "stranded-work")?.filter((_, i) => i !== 1)).toEqual([
    "stranded-work",
    0,
    1,
    0,
    1,
    1,
    1,
  ]);
  expect(stale.denominator).toEndWith(
    "; in the tasks that loaded plan, versions before 002f7b2a/aaa 1, after 002f7b2a/aaa 1",
  );
  expect(stale.note).toEndWith(
    "Not installed yet: the after window ran only versions of plan the before window ran.",
  );

  const unloaded = query(home, ["before-after", prefix, "--skill", "plan", "--from", "2026-09-22T00:00:00Z"]);
  expect(unloaded.denominator).toEndWith("versions before 002f7b2a/aaa 1, after none");
  expect(unloaded.note).toEndWith("No task of the after window loaded plan.");

  const codes = [
    ["signal", "stranded-work", "--skill", "acme:plan"],
    ["before-after", prefix, "--skill", "review"],
  ].map((args) => refused(runCli(home, ["query", ...args]), "query").code);
  expect(codes).toEqual(["unknown_skill", "unknown_skill"]);
});

test("AC-54 lost-context counts the files a session read again after a compaction, per compaction", () => {
  const home = synced([
    {
      id: "long",
      cwd: "/Users/x/code/demo",
      steps: [
        { owner: "add the parser", at: "2026-09-16T09:00:00Z" },
        { read: "/Users/x/code/demo/src/one.ts", at: "2026-09-16T09:01:00Z" },
        { read: "/Users/x/code/demo/src/two.ts", at: "2026-09-16T09:02:00Z" },
        { compacted: "2026-09-16T09:10:00Z" },
        { read: "/Users/x/code/demo/src/one.ts", at: "2026-09-16T09:13:00Z" },
        { read: "/Users/x/code/demo/src/one.ts", at: "2026-09-16T09:14:00Z" },
        { read: "/Users/x/code/demo/src/new.ts", at: "2026-09-16T09:15:00Z" },
        { compacted: "2026-09-16T09:20:00Z" },
        { read: "/Users/x/code/demo/src/two.ts", at: "2026-09-16T09:21:00Z" },
      ],
      subagents: [
        {
          id: "helper",
          agentType: "Explore",
          steps: [
            { read: "/Users/x/code/demo/src/one.ts", at: "2026-09-16T09:03:00Z" },
            { compacted: "2026-09-16T09:04:00Z" },
          ],
        },
      ],
    },
  ]);

  const counted = () => query(home, ["signal", "lost-context"]).rows;
  expect(counted()).toEqual([["2026-09-14", 0.33, 1, 3, "compaction 3, re-read 1"]]);
  const events = query(home, ["signal-events", "lost-context"]).rows;
  expect(events.map(([at, kind, , , minutes, session, text]) => [at, kind, minutes, session, text])).toEqual([
    ["2026-09-16T09:20:00.000Z", "compaction", null, "long", null],
    ["2026-09-16T09:10:00.000Z", "compaction", null, "long", null],
    ["2026-09-16T09:10:00.000Z", "re-read", 3, "long", "/Users/x/code/demo/src/one.ts"],
    ["2026-09-16T09:04:00.000Z", "compaction", null, "long", null],
  ]);

  rebuild(home);
  expect(counted()).toEqual([["2026-09-14", 0.33, 1, 3, "compaction 3, re-read 1"]]);
});

test("AC-55 escaped-defects counts the fixes that share a file with, or name, an earlier accepted commit", () => {
  const at = (minute: number, second = 0) =>
    `2026-09-16T09:${String(minute).padStart(2, "0")}:${String(second).padStart(2, "0")}Z`;
  const repo = scratchRepo(join(scratchDirOutsideTemp(), "app"), ORIGIN, [
    { subject: "start", file: "f0.txt", at: "2026-09-01T00:00:00Z" },
    { subject: "feat: add the parser", file: "src/parser.ts", at: at(1) },
    { subject: "docs: describe the parser", file: "docs/parser.md", at: at(3) },
    { subject: "fix: parse empty input", file: "src/parser.ts", at: at(5) },
    { subject: "fix: correct the docs", file: "docs/parser.md", at: at(7) },
  ]);
  const session = "build";
  const home = withClaudeSessions(scratchHome(), [
    { id: session, cwd: repo, steps: [{ owner: "add the parser", at: at(0) }] },
  ]);
  const allowed = (
    minute: number,
    reason: string,
    agent: string,
    more: Record<string, string | null> = { repo },
  ) => gate(at(minute, 30), { decision: "allow", reason, agent, ...more });
  withEventLog(home, session, [
    allowed(0, "accepted", "w1"),
    allowed(2, "accepted", "w1"),
    allowed(4, "no_code_change", "w2"),
    allowed(6, "accepted", "w2"),
  ]);
  sync(home);
  const shaOf = (subject: string): string => {
    const sha = succeeded(
      runCli(home, ["sql", `SELECT sha FROM repo_commit WHERE subject = '${subject}'`]),
      "sql",
      QUERY_RESULT,
    ).rows[0]?.[0];
    if (typeof sha !== "string") throw new Error(`the commit ${subject} is in the record`);
    return sha;
  };
  const feat = shaOf("feat: add the parser").slice(0, 8);
  commitTo(repo, { subject: `fix: undo ${feat}`, file: "src/other.ts", at: at(9) });
  withEventLog(home, session, [
    allowed(8, "accepted", "w2", { repo: null, head: shaOf("fix: correct the docs") }),
  ]);
  sync(home);

  const counted = () => query(home, ["signal", "escaped-defects"]).rows;
  expect(counted()).toEqual([["2026-09-14", 0.5, 2, 4, "accepted commit 4, names commit 1, shared file 1"]]);
  const events = query(home, ["signal-events", "escaped-defects"]).rows;
  expect(events.map(([when, kind, , , minutes, , text]) => [when, kind, minutes, text])).toEqual([
    [`2026-09-16T09:09:00.000Z`, "accepted commit", null, shaOf(`fix: undo ${feat}`).slice(0, 8)],
    [
      `2026-09-16T09:09:00.000Z`,
      "names commit",
      8,
      `${shaOf(`fix: undo ${feat}`).slice(0, 8)} fix: undo ${feat} <- ${feat}`,
    ],
    [`2026-09-16T09:07:00.000Z`, "accepted commit", null, shaOf("fix: correct the docs").slice(0, 8)],
    [
      `2026-09-16T09:05:00.000Z`,
      "shared file",
      4,
      `${shaOf("fix: parse empty input").slice(0, 8)} fix: parse empty input <- ${feat}`,
    ],
    [`2026-09-16T09:03:00.000Z`, "accepted commit", null, shaOf("docs: describe the parser").slice(0, 8)],
    [`2026-09-16T09:01:00.000Z`, "accepted commit", null, feat],
  ]);

  rebuild(home);
  expect(counted()).toEqual([["2026-09-14", 0.5, 2, 4, "accepted commit 4, names commit 1, shared file 1"]]);
});

test("AC-56 step-cost gives each step's tokens and minutes per accepted commit, split by version", () => {
  const cache = (name: string) => `/Users/x/.claude/plugins/cache/m/acme/aaa/skills/${name}`;
  const at = (minute: number) => `2026-09-16T09:${String(minute).padStart(2, "0")}:00Z`;
  const spent = (input: number) => ({
    input_tokens: input / 4,
    cache_read_input_tokens: input / 2,
    cache_creation_input_tokens: input / 4,
    output_tokens: input / 100,
  });
  const loaded = (skill: string, minute: number): Step => ({
    skill: `acme:${skill}`,
    at: at(minute),
    dir: cache(skill),
    body: `# ${skill}\n\nDo the ${skill} step.`,
  });
  const answered = (minute: number, input: number): Step => ({
    agent: "Done.",
    at: at(minute),
    usage: spent(input),
  });
  const repo = scratchRepo(join(scratchDirOutsideTemp(), "app"), ORIGIN, [
    { subject: "start", file: "f0.txt", at: "2026-09-01T00:00:00Z" },
    { subject: "feat: add the parser", file: "src/parser.ts", at: at(40) },
  ]);
  const home = withClaudeSessions(scratchHome(), [
    {
      id: "lead",
      cwd: repo,
      steps: [{ owner: "add the parser", at: at(0) }, loaded("plan", 1), answered(2, 4000)],
      subagents: [
        {
          id: "w1",
          agentType: "general-purpose",
          steps: [
            { owner: "write the parser", at: at(10) },
            loaded("deploy", 11),
            answered(12, 1000),
            loaded("lint", 13),
            answered(15, 2000),
          ],
        },
        {
          id: "r1",
          agentType: "acme:checker",
          steps: [
            { owner: "check the change", at: at(20) },
            {
              preload: "acme:style",
              at: at(20),
              dir: cache("style"),
              body: "# Style\n\nKeep the style.",
            },
            answered(23, 800),
          ],
        },
        {
          id: "e1",
          agentType: "Explore",
          steps: [{ owner: "find the parser", at: at(25) }, answered(26, 400)],
        },
      ],
    },
  ]);
  withEventLog(home, "lead", [gate(`2026-09-16T09:39:30Z`, { decision: "allow", reason: "accepted", repo })]);
  sync(home);

  const counted = () => query(home, ["signal", "step-cost"]).rows;
  const weekly = [
    [
      "2026-09-14",
      8200,
      8200,
      1,
      "plan 1, Explore 1, checker 1, deploy 1, lint 1; " +
        "per accepted commit output 82, minutes 11; per task over 1 tasks input 8200, output 82, minutes 11; " +
        "most input per accepted commit: plan 4000, lint 2000, deploy 1000, checker 800, Explore 400",
    ],
  ];
  expect(counted()).toEqual(weekly);
  const byVersion = query(home, ["signal", "step-cost", "--by", "version"]);
  expect(byVersion.columns).toEqual(["week", "version", "value", "count", "of", "kinds"]);
  expect(
    byVersion.rows.map(([week, version, value, count, of]) => [week, version, value, count, of]),
  ).toEqual([
    ["2026-09-14", "plan b5a44357", 4000, 4000, 1],
    ["2026-09-14", "lint cf41f9a0", 2000, 2000, 1],
    ["2026-09-14", "deploy acb9ecb7", 1000, 1000, 1],
    ["2026-09-14", "style 0dd3d547", 800, 800, 1],
    ["2026-09-14", null, 400, 400, 1],
  ]);
  const events = query(home, ["signal-events", "step-cost"]).rows;
  expect(events.map(([when, kind, , , minutes, , text]) => [when, kind, minutes, text])).toEqual([
    ["2026-09-16T09:26:00.000Z", "Explore", 1, "output 4, input 400, -"],
    ["2026-09-16T09:23:00.000Z", "checker", 3, "output 8, input 800, style 0dd3d547"],
    ["2026-09-16T09:15:00.000Z", "lint", 3, "output 20, input 2000, lint cf41f9a0"],
    ["2026-09-16T09:12:00.000Z", "deploy", 2, "output 10, input 1000, deploy acb9ecb7"],
    ["2026-09-16T09:02:00.000Z", "plan", 2, "output 40, input 4000, plan b5a44357"],
  ]);

  rebuild(home);
  expect(counted()).toEqual(weekly);
});

test("AC-57 second-read-asks counts the owner's asks for another model's read per task, not a quote or a paste", () => {
  const home = synced([
    {
      id: "asked",
      cwd: "/Users/x/code/demo",
      steps: [
        { owner: "add the parser", at: "2026-09-16T09:00:00Z" },
        { agent: "Here is a design.", at: "2026-09-16T09:01:00Z" },
        { owner: "ask fable to validate the design", at: "2026-09-16T09:02:00Z" },
        { agent: "Fable agreed.", at: "2026-09-16T09:03:00Z" },
        { owner: "what did fable's review say", at: "2026-09-16T09:04:00Z" },
        { agent: "It found nothing.", at: "2026-09-16T09:05:00Z" },
        { owner: "# Handoff\n\nAsk fable to plan the printer.", at: "2026-09-16T09:06:00Z" },
      ],
    },
  ]);

  expect(query(home, ["signal", "second-read-asks"]).rows).toEqual([
    ["2026-09-14", 0.25, 1, 4, "task 4, ask 1"],
  ]);
  const events = query(home, ["signal-events", "second-read-asks"]).rows;
  expect(events.flatMap(([at, kind, , , , , text]) => (kind === "ask" ? [[at, text]] : []))).toEqual([
    ["2026-09-16T09:02:00.000Z", "ask fable to validate the design"],
  ]);
});

test("AC-58 a message the owner queued while a turn ran is searched and counted within its task, through sync and rebuild", () => {
  const home = synced([
    {
      id: "queue",
      cwd: "/Users/x/code/demo",
      steps: [
        { owner: "add the parser", at: "2026-09-16T09:00:00Z" },
        { agent: "Writing it now.", at: "2026-09-16T09:01:00Z" },
        { queued: "no, commit msgs should be lowercase", at: "2026-09-16T09:02:00Z", from: "owner" },
        {
          queued: "<task-notification>lowercase build finished</task-notification>",
          at: "2026-09-16T09:03:00Z",
          from: "harness",
        },
        { queued: "and add the printer too", at: "2026-09-16T09:04:00Z", from: "owner" },
        { agent: "Lowercased.", at: "2026-09-16T09:05:00Z" },
      ],
    },
  ]);
  const found = () =>
    query(home, ["search", "lowercase"]).rows.map(([session, at, role, , , text]) => [
      session,
      at,
      role,
      text,
    ]);
  const queuedHit = [["queue", "2026-09-16T09:02:00.000Z", "user", "no, commit msgs should be [lowercase]"]];

  expect(found()).toEqual(queuedHit);
  const interrupts = query(home, ["signal-events", "owner-interrupts"]).rows;
  expect(interrupts.map(([at, kind, , , , , text]) => [at, kind, text])).toEqual([
    ["2026-09-16T09:02:00.000Z", "correct", "no, commit msgs should be lowercase"],
    ["2026-09-16T09:00:00.000Z", "task", null],
  ]);
  expect(query(home, ["signal", "owner-interrupts"]).rows).toEqual([
    ["2026-09-14", 1, 1, 1, "task 1, correct 1"],
  ]);

  rebuild(home);
  expect(found()).toEqual(queuedHit);
});
