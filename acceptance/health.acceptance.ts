import { afterEach, expect, test } from "bun:test";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import {
  doctor,
  type Home,
  holdingRecord,
  livePath,
  refused,
  removeScratch,
  runCli,
  schemaVersion,
  scratchHome,
  setSchemaVersion,
  succeeded,
  sync,
  syncedHome,
  withFixtures,
  withICloudDrive,
  withLaunchctl,
  withSyncFinishedAt,
} from "./cli";
import { CLAUDE, LONG } from "./fixture-names";

afterEach(removeScratch);

const UNREADABLE_SCHEMA_VERSION = 999;

const AGENT_INSTALL = z.union([
  z.strictObject({ path: z.string(), unchanged: z.literal(true) }),
  z.strictObject({ path: z.string(), unchanged: z.literal(false), next: z.string(), remove: z.string() }),
]);

const agentInstall = (home: Home) => succeeded(runCli(home, ["agent", "install"]), "agent", AGENT_INSTALL);

const SOURCE_SYNC = [process.execPath, join(import.meta.dir, "..", "src", "cli.ts"), "sync"];

const plistOf = (home: Home) => join(home.root, "Library", "LaunchAgents", "dev.agentrecord.sync.plist");

const doctorCheck = (home: Home, name: string) => {
  const { exitCode, report } = doctor(home);
  return { exitCode, check: report.checks.find((check) => check.name === name) };
};

const withUnreadableSession = (home: Home): string => {
  withFixtures(home, [CLAUDE, LONG]);
  const unreadable = livePath(home, LONG);
  chmodSync(unreadable, 0o000);
  return unreadable;
};

const syncRefusedOverSchemaVersion = (home: Home) => {
  setSchemaVersion(home, UNREADABLE_SCHEMA_VERSION);
  return refused(runCli(home, ["sync"]), "sync");
};

test("AC-18 doctor with no record fails the record and sync checks with their fixes and exits 1", () => {
  const home = scratchHome();
  expect(doctor(home)).toEqual({
    exitCode: 1,
    report: {
      checks: [
        {
          name: "record",
          state: "fail",
          detail: expect.stringContaining("no database at"),
          fix: "agent-record sync",
        },
        { name: "sync", state: "fail", detail: "no sync has ever finished", fix: "agent-record sync" },
        {
          name: "agent",
          state: "warn",
          detail: "no launchd agent, so the record syncs only when something runs agent-record sync",
          fix: "claude plugin install cniska-record@cniska, or agent-record agent install to sync while Claude Code is not running",
        },
        {
          name: "mirror",
          state: "warn",
          detail: `the archive cannot be mirrored to ${home.mirror}: there is no folder at ${dirname(home.mirror)}`,
          fix: expect.stringContaining("turn on iCloud Drive"),
        },
      ],
      failing: 2,
    },
  });
});

test("AC-18 doctor after a sync with a loaded agent passes every check and exits 0", () => {
  const home = withLaunchctl(syncedHome(withICloudDrive(scratchHome())), true);
  agentInstall(home);
  expect(doctor(home)).toEqual({
    exitCode: 0,
    report: {
      checks: [
        { name: "record", state: "ok", detail: `schema version ${schemaVersion(home)}`, fix: null },
        { name: "sync", state: "ok", detail: "last sync finished 0 hours ago", fix: null },
        { name: "agent", state: "ok", detail: "the launchd agent is loaded", fix: null },
        {
          name: "mirror",
          state: "ok",
          detail: `the whole archive was last mirrored to ${home.mirror} 0 hours ago`,
          fix: null,
        },
      ],
      failing: 0,
    },
  });
});

test("AC-18 doctor warns of a stale sync stamp and exits 0", () => {
  const home = withSyncFinishedAt(syncedHome(), "2026-01-01T00:00:00.000Z");
  expect(doctorCheck(home, "sync")).toEqual({
    exitCode: 0,
    check: {
      name: "sync",
      state: "warn",
      detail: expect.stringMatching(/^last sync finished \d+ hours ago$/),
      fix: "agent-record sync, and fix any error it reports",
    },
  });
});

test("AC-18 doctor fails a failed sync with the refusal's fix and warns of failed files", () => {
  const failed = syncedHome();
  const error = syncRefusedOverSchemaVersion(failed);
  expect(doctorCheck(failed, "sync")).toEqual({
    exitCode: 1,
    check: {
      name: "sync",
      state: "fail",
      detail: `the last sync failed: ${error.message}`,
      fix: "run an agent-record that reads schema version 999",
    },
  });

  const withFailedFiles = scratchHome();
  const unreadable = withUnreadableSession(withFailedFiles);
  sync(withFailedFiles);
  expect(doctorCheck(withFailedFiles, "sync")).toEqual({
    exitCode: 0,
    check: {
      name: "sync",
      state: "warn",
      detail: `1 file failed in the last sync, first ${unreadable}`,
      fix: "agent-record sync, and read the failures it reports",
    },
  });
});

test("AC-18 doctor names the fix for each launchd agent state", () => {
  const home = withLaunchctl(syncedHome(), false);
  const plist = plistOf(home);
  expect(doctorCheck(home, "agent").check).toMatchObject({
    state: "warn",
    fix: expect.stringContaining("agent-record agent install"),
  });

  agentInstall(home);
  expect(doctorCheck(home, "agent").check).toEqual({
    name: "agent",
    state: "warn",
    detail: "the launchd agent is written but not loaded",
    fix: `launchctl bootstrap gui/$(id -u) ${plist}`,
  });

  withLaunchctl(home, true);
  expect(doctorCheck(home, "agent").check).toEqual({
    name: "agent",
    state: "ok",
    detail: "the launchd agent is loaded",
    fix: null,
  });

  writeFileSync(plist, "<plist/>\n");
  expect(doctorCheck(home, "agent")).toEqual({
    exitCode: 0,
    check: {
      name: "agent",
      state: "warn",
      detail: `the launchd agent does not run ${SOURCE_SYNC.join(" ")}, the sync this agent-record schedules`,
      fix:
        "agent-record agent install, then launchctl bootout gui/$(id -u)/dev.agentrecord.sync and " +
        `launchctl bootstrap gui/$(id -u) ${plist}`,
    },
  });
});

test("AC-19 a sync that succeeds, one with failed files and one that fails each leave an outcome doctor reads", () => {
  const home = scratchHome();
  const unreadable = withUnreadableSession(home);
  const syncState = () => doctorCheck(home, "sync").check;

  expect(syncState()).toMatchObject({ state: "fail", detail: "no sync has ever finished" });
  sync(home);
  expect(syncState()).toMatchObject({
    state: "warn",
    detail: `1 file failed in the last sync, first ${unreadable}`,
  });
  chmodSync(unreadable, 0o644);
  sync(home);
  expect(syncState()).toMatchObject({ state: "ok", fix: null });
  const error = syncRefusedOverSchemaVersion(home);
  expect(syncState()).toMatchObject({ state: "fail", detail: `the last sync failed: ${error.message}` });
});

test("AC-20 agent install writes a missing agent, keeps the same one, and backs up a different one", () => {
  const home = scratchHome();
  const plist = plistOf(home);
  const loading = {
    path: plist,
    unchanged: false,
    next: `launchctl bootstrap gui/$(id -u) ${plist}`,
    remove: "launchctl bootout gui/$(id -u)/dev.agentrecord.sync",
  };

  expect(agentInstall(home)).toEqual(loading);
  const written = readFileSync(plist, "utf8");
  expect(written).toContain(
    `<array>\n${SOURCE_SYNC.map((arg) => `    <string>${arg}</string>\n`).join("")}  </array>`,
  );
  expect(written).toContain("<key>StartInterval</key>\n  <integer>900</integer>");
  expect(written).toContain("<key>RunAtLoad</key>\n  <true/>");
  expect(written).toContain(`<string>${join(home.state, "sync.log")}</string>`);

  expect(agentInstall(home)).toEqual({ path: plist, unchanged: true });
  expect(readFileSync(plist, "utf8")).toBe(written);

  const different = "<plist>different</plist>\n";
  writeFileSync(plist, different);
  expect(agentInstall(home)).toEqual(loading);
  expect(readFileSync(plist, "utf8")).toBe(written);
  expect(readFileSync(`${plist}.agent-record-backup`, "utf8")).toBe(different);
});

test("AC-18 doctor fails a busy record with the refusal's fix", () => {
  const home = syncedHome();
  expect(holdingRecord(home, "exclusive", () => doctorCheck(home, "record"))).toEqual({
    exitCode: 1,
    check: {
      name: "record",
      state: "fail",
      detail: `another process holds ${home.record}, or SQLite is recovering it after a crash`,
      fix: "run this again; if it keeps failing, close whatever holds the file",
    },
  });
});
test.todo("AC-21 the plugin hook starts sync when agent-record is on PATH and does nothing otherwise", () => {});
