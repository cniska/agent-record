import { afterEach, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import {
  compiledRelease,
  DOCTOR_RESULT,
  type Home,
  installedLauncher,
  type ReleaseServer,
  refused,
  releaseAssets,
  releaseServer,
  removeScratch,
  runCli,
  runReleased,
  scratchHome,
  scratchTempDir,
  settledUpdateCheck,
  succeeded,
  updateStampAfter,
  withUpdateCheckedAt,
} from "./cli";

const servers: ReleaseServer[] = [];

afterEach(() => {
  for (const server of servers.splice(0)) server.stop();
  removeScratch();
});

const BUILD_TIMEOUT_MS = 120_000;
const NO_CHECK_WITHIN_MS = 1500;
const TWO_DAYS_AGO = new Date(Date.now() - 48 * 3_600_000).toISOString();

const UPDATE_RESULT = z.union([
  z.strictObject({
    checked: z.literal(true),
    running: z.string(),
    latest: z.string(),
    staged: z.string().nullable(),
    pruned: z.array(z.string()),
  }),
  z.strictObject({ checked: z.literal(false), running: z.string(), lastCheck: z.string() }),
]);

const ROLLBACK_RESULT = z.strictObject({
  removed: z.string(),
  rejected: z.array(z.string()),
  next: z.string(),
});

type Released = {
  readonly home: Home;
  readonly bin: string;
  readonly baseline: string;
  readonly server: ReleaseServer;
  readonly assets: string;
  readonly run: (
    args: readonly string[],
    env?: Readonly<Record<string, string>>,
  ) => ReturnType<typeof runReleased>;
};

function released({ tag = "v0.2.0", builds = "0.2.0" } = {}): Released {
  const dir = scratchTempDir();
  const assets = join(dir, "assets");
  mkdirSync(assets);
  const server = releaseServer(assets, tag);
  servers.push(server);
  releaseAssets(assets, compiledRelease(join(dir, "latest"), builds, server.url));
  const baseline = compiledRelease(join(dir, "lib"), "0.1.0", server.url);
  const bin = join(dir, "bin");
  installedLauncher(bin, baseline, "0.1.0");
  const home = scratchHome();
  return {
    home,
    bin,
    baseline,
    server,
    assets,
    run: (args, env = {}) => runReleased(home, [bin], ["agent-record", ...args], env),
  };
}

const stagedDir = (home: Home) => join(home.root, "data", "agent-record", "bin");

const staged = (home: Home): string[] =>
  existsSync(stagedDir(home)) ? readdirSync(stagedDir(home)).sort() : [];

const downloads = (server: ReleaseServer) => server.requests.filter((path) => path.startsWith("/download/"));

const checks = (server: ReleaseServer) => server.requests.filter((path) => path === "/releases/latest");

const updateCheck = async (run: Released["run"]) => {
  const report = DOCTOR_RESULT.parse(JSON.parse((await run(["doctor"])).stdout).result);
  return report.checks.find(({ name }) => name === "update");
};

test(
  "AC-65 update stages a newer release beside the installed build, runs it next, and prunes what it caught up with",
  async () => {
    const { home, run, server, baseline } = released();

    expect(succeeded(await run(["update"]), "update", UPDATE_RESULT)).toEqual({
      checked: true,
      running: "0.1.0",
      latest: "0.2.0",
      staged: "0.2.0",
      pruned: [],
    });
    expect(staged(home)).toEqual(["0.2.0"]);
    expect((await run(["--version"])).stdout).toBe("0.2.0\n");

    mkdirSync(join(stagedDir(home), "0.0.9"));
    cpSync(baseline, join(stagedDir(home), "0.0.9", "agent-record"));
    expect(succeeded(await run(["update"]), "update", UPDATE_RESULT)).toEqual({
      checked: true,
      running: "0.2.0",
      latest: "0.2.0",
      staged: null,
      pruned: ["0.0.9"],
    });
    expect(staged(home)).toEqual(["0.2.0"]);
    expect(downloads(server)).toEqual([
      "/download/agent-record-darwin-arm64.tar.gz",
      "/download/agent-record-darwin-arm64.sha256",
    ]);

    const before = server.requests.length;
    expect(refused(await run(["update"], { AGENT_RECORD_SKIP_UPDATE: "1" }), "update").code).toBe(
      "update_skipped",
    );
    expect(server.requests.length).toBe(before);
    expect(refused(runCli(scratchHome(), ["update"]), "update").code).toBe("update_from_checkout");
  },
  BUILD_TIMEOUT_MS,
);

test(
  "AC-66 update refuses a download that fails its checksum or does not print its version, and stages nothing",
  async () => {
    const corrupt = released();
    writeFileSync(
      join(corrupt.assets, "agent-record-darwin-arm64.sha256"),
      `${"0".repeat(64)}  agent-record-darwin-arm64.tar.gz\n`,
    );
    const mismatch = refused(await corrupt.run(["update"]), "update");
    expect(mismatch).toMatchObject({ code: "update_failed" });
    expect(mismatch.message).toContain("the 0.2.0 download does not match its sha256");
    expect(staged(corrupt.home)).toEqual([]);
    expect(await updateCheck(corrupt.run)).toEqual({
      name: "update",
      state: "warn",
      detail: `the last update check failed, and this machine was likely offline: ${mismatch.message}`,
      fix: "agent-record update",
    });

    const mislabelled = released({ builds: "0.3.0" });
    const wrong = refused(await mislabelled.run(["update"]), "update");
    expect(wrong.message).toContain(
      'the downloaded 0.2.0 build prints "0.3.0" on --version, so it is not staged',
    );
    expect(staged(mislabelled.home)).toEqual([]);
    expect((await mislabelled.run(["--version"])).stdout).toBe("0.1.0\n");
  },
  BUILD_TIMEOUT_MS,
);

test(
  "AC-67 a command other than sync, rebuild and update starts one detached update check a day, and sync and the skip switch start none",
  async () => {
    const { home, run, server } = released();
    withUpdateCheckedAt(home, TWO_DAYS_AGO);

    expect((await run(["sync"])).exitCode).toBe(0);
    expect((await run(["doctor"], { AGENT_RECORD_SKIP_UPDATE: "1" })).stdout).toContain('"ok":true');
    expect(await updateStampAfter(home, NO_CHECK_WITHIN_MS)).toMatchObject({ at: TWO_DAYS_AGO });
    expect(server.requests).toEqual([]);

    const [first, second] = await Promise.all([run(["doctor"]), run(["doctor"])]);
    expect(first.stdout).toContain('"ok":true');
    expect(second.stdout).toContain('"ok":true');
    expect(await settledUpdateCheck(home, TWO_DAYS_AGO)).toBe("staged");
    expect(staged(home)).toEqual(["0.2.0"]);
    expect(checks(server)).toEqual(["/releases/latest"]);

    await run(["doctor"]);
    await updateStampAfter(home, NO_CHECK_WITHIN_MS);
    expect(checks(server)).toEqual(["/releases/latest"]);
  },
  BUILD_TIMEOUT_MS,
);

test(
  "AC-68 update --rollback removes the staged build and rejects its version, so the installed build runs and no check stages it again",
  async () => {
    const { home, run, server } = released();
    succeeded(await run(["update"]), "update", UPDATE_RESULT);

    expect(succeeded(await run(["update", "--rollback"]), "update", ROLLBACK_RESULT)).toEqual({
      removed: "0.2.0",
      rejected: ["0.2.0"],
      next: "agent-record rebuild",
    });
    expect(staged(home)).toEqual([]);
    expect((await run(["--version"])).stdout).toBe("0.1.0\n");

    const fetched = downloads(server).length;
    expect(succeeded(await run(["update"]), "update", UPDATE_RESULT)).toEqual({
      checked: true,
      running: "0.1.0",
      latest: "0.2.0",
      staged: null,
      pruned: [],
    });
    expect(downloads(server).length).toBe(fetched);
    expect(staged(home)).toEqual([]);
    expect(refused(await run(["update", "--rollback"]), "update").code).toBe("nothing_staged");
  },
  BUILD_TIMEOUT_MS,
);

test(
  "AC-18 doctor warns of a missing or stale update check and of a staged build that is not running, and passes a current one",
  async () => {
    const { home, run, baseline } = released();

    expect(await updateCheck(run)).toEqual({
      name: "update",
      state: "warn",
      detail: "no update check has run; this machine was likely offline",
      fix: "agent-record update",
    });
    expect(await settledUpdateCheck(home)).toBe("staged");

    expect(await updateCheck(run)).toEqual({
      name: "update",
      state: "ok",
      detail: "agent-record 0.2.0 is current, checked 0 hours ago",
      fix: null,
    });
    expect(
      await updateCheck((args) => runReleased(home, [dirname(baseline)], ["agent-record", ...args])),
    ).toEqual({
      name: "update",
      state: "warn",
      detail:
        "agent-record 0.2.0 is staged but this run is 0.1.0; the next run through the installed agent-record starts it",
      fix: "agent-record update",
    });

    withUpdateCheckedAt(home, TWO_DAYS_AGO);
    expect(await updateCheck(run)).toEqual({
      name: "update",
      state: "warn",
      detail: "the last update check began 48 hours ago; this machine was likely offline",
      fix: "agent-record update",
    });
    await settledUpdateCheck(home, TWO_DAYS_AGO);
  },
  BUILD_TIMEOUT_MS,
);
