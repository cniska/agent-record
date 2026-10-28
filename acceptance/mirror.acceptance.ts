import { afterEach, expect, test } from "bun:test";
import {
  appendFileSync,
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";
import {
  archivedPath,
  doctor,
  type Fixture,
  filesUnder,
  type Home,
  livePath,
  rebuild,
  refused,
  removeScratchDirs,
  rowsOf,
  runCli,
  scratchDir,
  scratchHome,
  setSchemaVersion,
  sync,
  withFixtures,
  withICloudDrive,
  withMirroredAt,
} from "./cli";
import { CLAUDE, CODEX, CODEX_ROLLOUT, LONG } from "./fixture-names";

afterEach(removeScratchDirs);

const UNREADABLE_SCHEMA_VERSION = 999;

const mirrorCopy = (home: Home, fixture: Fixture) =>
  join(home.mirror, "archive", relative(home.archive, archivedPath(home, fixture)));

const mirrorCheck = (home: Home) => {
  const { exitCode, report } = doctor(home, "full");
  return { exitCode, check: report.checks.find((check) => check.name === "mirror") };
};

test("AC-32 sync mirrors every archive file into iCloud Drive, again after it grows, or where AGENT_RECORD_MIRROR says", () => {
  const home = withFixtures(withICloudDrive(scratchHome()), [CLAUDE, CODEX]);
  expect(sync(home).mirror).toMatchObject({ state: "mirrored", path: home.mirror });
  expect([...filesUnder(join(home.mirror, "archive"))].toSorted()).toEqual(
    [...filesUnder(home.archive)].toSorted(),
  );
  for (const fixture of [CLAUDE, CODEX])
    expect(readFileSync(mirrorCopy(home, fixture), "utf8")).toBe(
      readFileSync(archivedPath(home, fixture), "utf8"),
    );

  appendFileSync(livePath(home, CLAUDE), readFileSync(livePath(home, CLAUDE), "utf8"));
  expect(sync(home).mirror).toMatchObject({ state: "mirrored", files: 1 });
  expect(readFileSync(mirrorCopy(home, CLAUDE), "utf8")).toBe(
    readFileSync(archivedPath(home, CLAUDE), "utf8"),
  );

  const elsewhere = join(scratchDir(), "record-mirror");
  const other = withFixtures(scratchHome(), [CLAUDE]);
  expect(sync(other, { AGENT_RECORD_MIRROR: elsewhere }).mirror).toMatchObject({
    state: "mirrored",
    path: elsewhere,
    files: 1,
  });
  expect(filesUnder(join(elsewhere, "archive"))).toEqual(filesUnder(other.archive));
  expect(existsSync(other.mirror)).toBe(false);
});

test("AC-33 a Codex rollout the archive moved keeps its mirror copy at the old path beside the new one", () => {
  const home = withFixtures(withICloudDrive(scratchHome()), [CODEX]);
  sync(home);
  const archivedSessions = join(home.root, ".codex", "archived_sessions");
  mkdirSync(archivedSessions);
  renameSync(livePath(home, CODEX), join(archivedSessions, CODEX_ROLLOUT));
  sync(home);

  expect([...filesUnder(join(home.mirror, "archive", "codex"))].toSorted()).toEqual(
    [
      join("archived_sessions", CODEX_ROLLOUT),
      relative(join(home.archive, "codex"), archivedPath(home, CODEX)),
    ].toSorted(),
  );
});

test("AC-34 a sync sets a mirror copy aside before a shorter or empty archive file replaces it", () => {
  const home = withFixtures(withICloudDrive(scratchHome()), [CLAUDE, LONG]);
  sync(home);
  const before = [CLAUDE, LONG].map((fixture) => ({
    fixture,
    held: readFileSync(mirrorCopy(home, fixture), "utf8"),
  }));
  writeFileSync(livePath(home, CLAUDE), "");
  const [firstLine = ""] = readFileSync(livePath(home, LONG), "utf8").split("\n");
  writeFileSync(livePath(home, LONG), `${firstLine}\n`);
  sync(home);

  for (const { fixture, held } of before) {
    expect(readFileSync(mirrorCopy(home, fixture), "utf8")).toBe(
      readFileSync(archivedPath(home, fixture), "utf8"),
    );
    expect(readFileSync(`${mirrorCopy(home, fixture)}.agent-record-backup`, "utf8")).toBe(held);
  }
  expect(readFileSync(mirrorCopy(home, CLAUDE), "utf8")).toBe("");
  expect(readFileSync(mirrorCopy(home, LONG), "utf8")).toBe(`${firstLine}\n`);
});

test("AC-35 a sync with no iCloud Drive folder still reads its sessions, says the mirror is unreachable and creates nothing", () => {
  const home = withFixtures(scratchHome(), [CLAUDE]);
  const result = sync(home);

  expect(result.mirror).toEqual({
    state: "unreachable",
    path: home.mirror,
    detail: `there is no folder at ${dirname(home.mirror)}`,
  });
  expect(result.failures).toEqual([]);
  expect(rowsOf(home, "select count(*) from session")).toEqual([[1]]);
  expect(existsSync(join(home.root, "Library"))).toBe(false);
  expect(mirrorCheck(home)).toEqual({
    exitCode: 0,
    check: {
      name: "mirror",
      state: "warn",
      detail: `the archive cannot be mirrored to ${home.mirror}: there is no folder at ${dirname(home.mirror)}`,
      fix: `make ${dirname(home.mirror)} reachable (for the default, turn on iCloud Drive), or set AGENT_RECORD_MIRROR to an absolute path whose parent folder exists, then run agent-record sync`,
    },
  });
});

test("AC-36 a mirror copy that cannot be written is listed with its fix, the rest is mirrored, and doctor warns until it is fixed", () => {
  const home = withFixtures(withICloudDrive(scratchHome()), [CLAUDE, CODEX]);
  const blocked = dirname(mirrorCopy(home, CLAUDE));
  mkdirSync(blocked, { recursive: true });
  chmodSync(blocked, 0o500);

  const result = sync(home);
  chmodSync(blocked, 0o755);
  expect(result.failures).toEqual([
    {
      path: mirrorCopy(home, CLAUDE),
      kind: "refusal",
      code: "mirror_unwritable",
      message: expect.stringContaining(`cannot write the mirror copy ${mirrorCopy(home, CLAUDE)}: `),
      resolve: `free space in or fix the permissions of ${blocked}, then run agent-record sync; until then the mirror keeps the copy made before`,
    },
  ]);
  expect(readFileSync(mirrorCopy(home, CODEX), "utf8")).toBe(readFileSync(archivedPath(home, CODEX), "utf8"));
  expect(mirrorCheck(home).check).toEqual({
    name: "mirror",
    state: "warn",
    detail: `no sync has mirrored the whole archive to ${home.mirror} yet`,
    fix: "agent-record sync, and fix any mirror failure it reports",
  });

  expect(sync(home).failures).toEqual([]);
  expect(mirrorCheck(home).check).toMatchObject({ name: "mirror", state: "ok" });
});

test("AC-37 rebuild reads no session from the mirror", () => {
  const home = withFixtures(withICloudDrive(scratchHome()), [CLAUDE]);
  sync(home);
  const planted = join(home.mirror, "archive", relative(home.archive, archivedPath(home, LONG)));
  mkdirSync(dirname(planted), { recursive: true });
  copyFileSync(livePath(withFixtures(scratchHome(), [LONG]), LONG), planted);
  const sessions = rowsOf(home, "select id from session");

  rebuild(home);
  expect(rowsOf(home, "select id from session")).toEqual(sessions);
});

test("AC-38 doctor passes a mirror made by the last sync and warns of one over a day old, naming the folder", () => {
  const home = withFixtures(withICloudDrive(scratchHome()), [CLAUDE]);
  sync(home);
  expect(mirrorCheck(home)).toEqual({
    exitCode: 0,
    check: {
      name: "mirror",
      state: "ok",
      detail: `the whole archive was last mirrored to ${home.mirror} 0 hours ago`,
      fix: null,
    },
  });

  withMirroredAt(home, "2026-01-01T00:00:00.000Z");
  expect(mirrorCheck(home)).toEqual({
    exitCode: 0,
    check: {
      name: "mirror",
      state: "warn",
      detail: expect.stringMatching(/^the whole archive was last mirrored to .+ \d+ hours ago$/),
      fix: "agent-record sync, and fix any mirror failure it reports",
    },
  });
  expect(mirrorCheck(home).check?.detail).toContain(home.mirror);
});

test("AC-39 a sync refused over a newer schema version still mirrors the archive", () => {
  const home = withFixtures(scratchHome(), [CLAUDE]);
  expect(sync(home).mirror.state).toBe("unreachable");
  withICloudDrive(home);
  setSchemaVersion(home, UNREADABLE_SCHEMA_VERSION);

  expect(refused(runCli(home, ["sync"]), "sync").code).toBe("record_version");
  expect(readFileSync(mirrorCopy(home, CLAUDE), "utf8")).toBe(
    readFileSync(archivedPath(home, CLAUDE), "utf8"),
  );
});
