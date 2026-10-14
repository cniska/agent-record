import { afterEach, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join, relative } from "node:path";
import { rebuild, removeScratch, rowsOf, scratchHome, sync, withICloudDrive } from "./cli";
import { archivedEventLog, eventLogPath, gate, verdict, withEventLog } from "./hook-events";

afterEach(removeScratch);

const SESSION = "0b8f2c1e-7d4a-4e2b-9c3f-5a6d7e8f9a0b";
const OTHER_INSTALL = "cniska-skills-inline";
const OTHER_PLUGIN = "other-plugin-market";
const REPO = "/Users/x/code/demo";

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
