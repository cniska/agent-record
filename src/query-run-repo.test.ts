import { describe, expect, test } from "bun:test";
import { repoFinder } from "./query-run-repo";
import type { CheckoutRow, CommitRow, GitRunRow } from "./query-signal-record";
import { timelineOf } from "./query-timeline";

const REPO = "/h/code/demo";
const OTHER = "/h/code/other";
const GONE = "/h/trees/demo-a1/slice";

type Run = Partial<GitRunRow> & Pick<GitRunRow, "at">;

const run = (more: Run): GitRunRow => ({
  sessionId: "s",
  subcommand: "commit",
  dir: GONE,
  callAt: more.at,
  command: "",
  commitsInCall: more.subcommand === "push" ? 0 : 1,
  ...more,
});

const commit = (repo: string, at: string, subject: string): CommitRow => ({
  sha: `${repo}-${at}`,
  repo,
  at,
  subject,
  kind: null,
});

const committed = (at: string, subject: string, more: Partial<GitRunRow> = {}) =>
  run({ at, callAt: at, command: `git -C ${GONE} commit -m "${subject}"`, ...more });

const finds = (
  gitRuns: readonly GitRunRow[],
  commits: readonly CommitRow[],
  checkouts: readonly CheckoutRow[] = [{ path: REPO, repo: REPO }],
) => repoFinder({ checkouts, gitRuns, commits });

const AT = "2026-10-14T09:00:00.000Z";
const SUBJECT = "feat: add the parser";

describe("finding the repo of a dir no checkout covers", () => {
  test("a commit run whose subject and time match a repo's commit puts its dir, and a push there, in that repo", () => {
    const repoOf = finds(
      [committed(AT, SUBJECT), run({ at: AT, subcommand: "push" })],
      [commit(REPO, AT, SUBJECT)],
    );
    expect(repoOf(GONE)).toBe(REPO);
    expect(repoOf(`${GONE}/src`)).toBe(REPO);
  });

  test("a commit authored within the call's span matches, one authored before it does not", () => {
    const span = { callAt: "2026-10-14T08:59:58.000Z", at: "2026-10-14T09:00:03.500Z" };
    expect(finds([committed(AT, SUBJECT, span)], [commit(REPO, AT, SUBJECT)])(GONE)).toBe(REPO);
    const amended = commit(REPO, "2026-10-14T08:40:00.000Z", SUBJECT);
    expect(finds([committed(AT, SUBJECT, span)], [amended])(GONE)).toBeNull();
  });

  test("a dir a checkout covers keeps the checkout's repo", () => {
    const repoOf = finds([committed(AT, SUBJECT, { dir: REPO })], [commit(OTHER, AT, SUBJECT)]);
    expect(repoOf(REPO)).toBe(REPO);
  });

  test("a commit run whose call made more than one commit is no evidence", () => {
    const repoOf = finds([committed(AT, SUBJECT, { commitsInCall: 2 })], [commit(REPO, AT, SUBJECT)]);
    expect(repoOf(GONE)).toBeNull();
  });

  test("a subject only inside other words of the command is no evidence", () => {
    const repoOf = finds(
      [run({ at: AT, command: `git commit -m "fix: the fix list"` })],
      [commit(REPO, AT, "fix")],
    );
    expect(repoOf(GONE)).toBeNull();
  });

  test("a subject on a line of its own in a heredoc is evidence", () => {
    const command = `git commit -F - <<'EOF'\n${SUBJECT}\nEOF`;
    const repoOf = finds([run({ at: AT, command })], [commit(REPO, AT, SUBJECT)]);
    expect(repoOf(GONE)).toBe(REPO);
  });

  test("two repos with the commit's subject at that time leave the dir in no repo", () => {
    const repoOf = finds([committed(AT, SUBJECT)], [commit(REPO, AT, SUBJECT), commit(OTHER, AT, SUBJECT)]);
    expect(repoOf(GONE)).toBeNull();
  });

  test("a dir whose commit runs name two repos is in no repo", () => {
    const later = "2026-10-14T10:00:00.000Z";
    const repoOf = finds(
      [committed(AT, SUBJECT), committed(later, "fix: parse empty input")],
      [commit(REPO, AT, SUBJECT), commit(OTHER, later, "fix: parse empty input")],
    );
    expect(repoOf(GONE)).toBeNull();
  });
});

describe("placing a removed worktree's rows in its repo", () => {
  test("its commit runs, a session whose project it is and a hook line naming it count in the repo", () => {
    const timeline = timelineOf({
      sessions: [
        { id: "s", parentId: null, tool: "claude", project: GONE, start: AT, end: null, agentType: null },
      ],
      ownerMessages: [],
      openings: [],
      rejections: [],
      gitRuns: [committed(AT, SUBJECT)],
      tags: [],
      compactions: [],
      compactedSessionReads: [],
      commits: [commit(REPO, AT, SUBJECT)],
      commitFiles: [],
      responses: [],
      subagentReturns: [],
      hookEvents: [
        {
          at: AT,
          sessionId: "s",
          agent: null,
          event: "gate",
          gate: "commit",
          decision: "deny",
          reason: "repo_unclear",
          repo: GONE,
          head: null,
          fingerprint: null,
        },
      ],
      skillLoads: [
        { sessionId: "s", at: AT, skill: "build", bodySha256: null, install: null, preloaded: false },
      ],
      checkouts: [{ path: REPO, repo: REPO }],
      labels: new Map(),
      newest: AT,
    });
    expect(timeline.commitRuns.map((r) => r.repo)).toEqual([REPO]);
    expect(timeline.tasks.map((t) => t.repo)).toEqual([REPO]);
    expect(timeline.denials.map((d) => d.repo)).toEqual([REPO]);
    expect(timeline.skillLoads.map((l) => l.repo)).toEqual([REPO]);
  });
});
