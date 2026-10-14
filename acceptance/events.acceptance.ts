import { afterEach, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join, relative } from "node:path";
import { withClaudeSessions } from "./claude-sessions";
import {
  type Home,
  QUERY_RESULT,
  rebuild,
  removeScratch,
  rowsOf,
  runCli,
  scratchHome,
  succeeded,
  sync,
  withICloudDrive,
} from "./cli";
import { archivedEventLog, eventLogPath, gate, type HookLine, verdict, withEventLog } from "./hook-events";

afterEach(removeScratch);

const SESSION = "0b8f2c1e-7d4a-4e2b-9c3f-5a6d7e8f9a0b";
const OTHER_INSTALL = "cniska-skills-inline";
const OTHER_PLUGIN = "other-plugin-market";
const REPO = "/Users/x/code/demo";
const OTHER_REPO = "/Users/x/code/other";

const HOOK_EVENTS = `select src_line, ts, event, session, agent, gate, decision, reason, repo, head, fingerprint,
  verdict, tool, tool_use, rule from hook_event order by src_file, src_line`;

test("AC-46 a sync archives and reads every cniska-skills event log, reports its bad lines, and a rebuild or a reset log keeps them", () => {
  const home = withICloudDrive(scratchHome());
  withEventLog(home, SESSION, [
    gate("2026-10-14T08:00:00Z", {
      decision: "deny",
      reason: "changed_since_accept",
      repo: REPO,
      head: "10db26e",
      fingerprint: "f1",
    }),
    verdict("2026-10-14T08:01:00Z", { verdict: "accept", repo: REPO, fingerprint: "f1", agent: "a1" }),
    { ts: "2026-10-14T08:02:00Z", event: "permission_prompt", tool: "Bash" },
    {
      ts: "2026-10-14T08:03:00Z",
      event: "permission_denied",
      tool: "Bash",
      tool_use: "toolu_1",
      reason: "rule",
      rule: "no-force-push",
    },
    { ts: "2026-10-14T08:04:00Z", event: "gate", gate: "commit", decision: "maybe", reason: "accepted" },
    { ts: "2026-10-14T08:05:00Z", event: "permission_prompt", tool: "Bash", v: 2 },
    { ts: "2026-10-14T08:06:00Z", event: "push", ref: "main" },
  ]);
  withEventLog(
    home,
    SESSION,
    [{ ts: "2026-10-14T09:00:00Z", event: "permission_prompt", tool: "Edit" }],
    OTHER_INSTALL,
  );
  withEventLog(
    home,
    SESSION,
    [{ ts: "2026-10-14T09:00:00Z", event: "permission_prompt", tool: "Edit" }],
    OTHER_PLUGIN,
  );

  const synced = sync(home);
  expect(synced.eventLogs).toBe(2);
  expect(synced.dropped).toEqual([{ path: archivedEventLog(home), lines: [5, 6] }]);
  for (const install of [undefined, OTHER_INSTALL]) {
    const copy = archivedEventLog(home, install);
    expect(readFileSync(copy, "utf8")).toBe(readFileSync(eventLogPath(home, install), "utf8"));
    expect(readFileSync(join(home.mirror, "archive", relative(home.archive, copy)), "utf8")).toBe(
      readFileSync(copy, "utf8"),
    );
  }
  expect(existsSync(archivedEventLog(home, OTHER_PLUGIN))).toBe(false);
  expect(
    existsSync(join(home.mirror, "archive", relative(home.archive, archivedEventLog(home, OTHER_PLUGIN)))),
  ).toBe(false);

  const events = rowsOf(home, HOOK_EVENTS);
  expect(events).toEqual([
    [
      1,
      "2026-10-14T08:00:00.000Z",
      "gate",
      SESSION,
      null,
      "commit",
      "deny",
      "changed_since_accept",
      REPO,
      "10db26e",
      "f1",
      null,
      null,
      null,
      null,
    ],
    [
      2,
      "2026-10-14T08:01:00.000Z",
      "verdict",
      SESSION,
      "a1",
      null,
      null,
      null,
      REPO,
      null,
      "f1",
      "accept",
      null,
      null,
      null,
    ],
    [
      3,
      "2026-10-14T08:02:00.000Z",
      "permission_prompt",
      SESSION,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      "Bash",
      null,
      null,
    ],
    [
      4,
      "2026-10-14T08:03:00.000Z",
      "permission_denied",
      SESSION,
      null,
      null,
      null,
      "rule",
      null,
      null,
      null,
      null,
      "Bash",
      "toolu_1",
      "no-force-push",
    ],
    [
      1,
      "2026-10-14T09:00:00.000Z",
      "permission_prompt",
      SESSION,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      "Edit",
      null,
      null,
    ],
  ]);

  withEventLog(home, SESSION, [{ ts: "2026-10-14T10:00:00Z", event: "permission_prompt", tool: "Write" }]);
  expect(sync(home)).toMatchObject({ filesRead: 1, dropped: [] });
  const grown = rowsOf(home, HOOK_EVENTS);
  expect(grown).toHaveLength(6);

  rmSync(eventLogPath(home));
  rmSync(eventLogPath(home, OTHER_INSTALL));
  expect(rebuild(home).eventLogs).toBe(2);
  expect(rowsOf(home, HOOK_EVENTS)).toEqual(grown);

  withEventLog(home, SESSION, [{ ts: "2026-10-14T11:00:00Z", event: "permission_prompt", tool: "Read" }]);
  sync(home);
  const kept = rowsOf(home, HOOK_EVENTS);
  expect(kept).toHaveLength(7);
  expect(kept).toEqual(expect.arrayContaining(grown));
});

const query = (home: Home, args: readonly string[]) =>
  succeeded(runCli(home, ["query", ...args]), "query", QUERY_RESULT);

const at = (minute: number): string => `2026-10-14T09:${String(minute).padStart(2, "0")}:00Z`;

const synced = (lines: readonly HookLine[]): Home => {
  const home = withEventLog(scratchHome(), SESSION, lines);
  sync(home);
  return home;
};

test("AC-47 false-stops counts a stop false only when the work got past the gate with nothing it checks changed", () => {
  const home = synced([
    gate(at(1), { decision: "deny", reason: "repo_unclear", agent: "b1" }),
    gate(at(2), { decision: "deny", reason: "repo_unclear", agent: "b1" }),
    gate(at(3), { decision: "allow", reason: "no_code_change", agent: "b1", repo: REPO }),
    gate(at(4), { decision: "deny", reason: "repo_not_found", agent: "b2" }),
    verdict(at(5), { verdict: "accept", repo: REPO, agent: "r0" }),
    gate(at(6), { decision: "allow", reason: "accepted", agent: "b2", repo: REPO, fingerprint: "f0" }),
    gate(at(7), {
      decision: "deny",
      reason: "changed_since_accept",
      agent: "b3",
      repo: REPO,
      fingerprint: "f1",
    }),
    verdict(at(8), { verdict: "accept", repo: REPO, agent: "r1", fingerprint: "f1" }),
    gate(at(9), { decision: "allow", reason: "accepted", agent: "b3", repo: REPO, fingerprint: "f1" }),
    gate(at(10), { decision: "deny", reason: "gate_error", agent: "b5", repo: REPO }),
    gate(at(11), { decision: "allow", reason: "no_code_change", agent: "b5", repo: OTHER_REPO }),
    gate(at(12), { decision: "allow", reason: "no_code_change", agent: "b5", repo: REPO }),
    gate(at(13), { decision: "deny", reason: "missing_verdict", agent: "r2", gate: "verdict" }),
    gate(at(14), { decision: "allow", reason: "missing_verdict", agent: "r2", gate: "verdict" }),
    gate(at(15), { decision: "deny", reason: "missing_repo", agent: "r3", gate: "verdict" }),
    verdict(at(16), { verdict: "return", repo: REPO, agent: "r3" }),
    gate(at(17), { decision: "deny", reason: "multiple_commits", agent: "b4" }),
  ]);

  const weekly = query(home, ["signal", "false-stops"]);
  expect(weekly.rows).toEqual([
    ["2026-10-12", 0.33, 2, 6, "upheld 3, unfixed 1, pending 1, commit repo_unclear 1, commit gate_error 1"],
  ]);
  const listed = query(home, ["signal-events", "false-stops"]);
  expect(listed.rows.map(([when, kind]) => [when, kind])).toEqual([
    ["2026-10-14T09:17:00.000Z", "pending"],
    ["2026-10-14T09:15:00.000Z", "upheld"],
    ["2026-10-14T09:13:00.000Z", "unfixed"],
    ["2026-10-14T09:10:00.000Z", "commit gate_error"],
    ["2026-10-14T09:07:00.000Z", "upheld"],
    ["2026-10-14T09:04:00.000Z", "upheld"],
    ["2026-10-14T09:01:00.000Z", "commit repo_unclear"],
  ]);
});

test("AC-48 review-returns counts the returns before each reviewed commit, a retry and an unreviewed allow apart", () => {
  const home = synced([
    verdict(at(1), { verdict: "return", repo: REPO }),
    verdict(at(2), { verdict: "return", repo: REPO }),
    verdict(at(3), { verdict: "accept", repo: REPO, fingerprint: "f1" }),
    gate(at(4), { decision: "allow", reason: "accepted", repo: REPO, fingerprint: "f1" }),
    gate(at(5), { decision: "allow", reason: "accepted", repo: REPO, fingerprint: "f1" }),
    verdict(at(6), { verdict: "return", repo: REPO }),
    verdict(at(7), { verdict: "accept", repo: REPO, fingerprint: "f2" }),
    gate(at(8), { decision: "allow", reason: "no_code_change", repo: REPO }),
    gate(at(9), { decision: "allow", reason: "no_code_change", repo: REPO }),
    verdict(at(10), { verdict: "return", repo: REPO }),
  ]);

  expect(query(home, ["signal", "review-returns"]).rows).toEqual([
    ["2026-10-12", 1.5, 3, 2, "return 3, reviewed commit 2"],
  ]);
});

test("AC-49 blocks counts each source per Claude task given since the log began", () => {
  const home = withClaudeSessions(scratchHome(), [
    {
      id: SESSION,
      cwd: "/Users/x/code/demo",
      steps: [
        { owner: "add the parser", at: at(0) },
        { agent: "Done, wrote it.", at: at(1) },
        { owner: "now add the printer", at: at(10) },
        { agent: "Done, added it.", at: at(11) },
        { owner: "now add the linter", at: at(20) },
        { agent: "Done, added it.", at: at(21) },
      ],
    },
    {
      id: "1c9d3e2f-8e5b-4f3c-ad40-6b7e8f9a0b1c",
      cwd: "/Users/x/code/demo",
      steps: [
        { owner: "tidy the readme", at: "2026-10-13T09:00:00Z" },
        { agent: "Tidied.", at: "2026-10-13T09:01:00Z" },
      ],
    },
  ]);
  withEventLog(home, SESSION, [
    { ts: at(5), event: "permission_prompt", tool: "Read" },
    { ts: at(12), event: "permission_prompt", tool: "Bash" },
    { ts: at(13), event: "permission_denied", tool: "Bash", tool_use: "toolu_1", reason: "rule", rule: "x" },
    gate(at(14), { decision: "deny", reason: "not_accepted", repo: REPO, fingerprint: "f1" }),
    gate(at(15), { decision: "deny", reason: "missing_verdict", gate: "verdict", agent: "r1" }),
  ]);
  sync(home);

  expect(query(home, ["signal", "blocks"]).rows).toEqual([
    ["2026-10-12", 2, 4, 2, "task 2, permission prompt 1, auto-mode denial 1, commit gate 1, verdict gate 1"],
  ]);
});
