import { afterEach, expect, test } from "bun:test";
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { version } from "../package.json";
import {
  compiledRelease,
  curlServing,
  type Home,
  QUERY_RESULT,
  refused,
  releaseAssets,
  removeScratchDirs,
  runOnCleanMachine,
  SYNC_COMMAND_RESULT,
  SYSTEM_PATH,
  scratchDir,
  scratchHome,
  succeeded,
  unameSaying,
  withFixtures,
} from "./cli";
import { LONG } from "./fixture-names";

afterEach(removeScratchDirs);

const BUILD_TIMEOUT_MS = 60_000;
const INSTALL = join(import.meta.dir, "..", "scripts", "install.sh");
const BUILD_NPM = join(import.meta.dir, "..", "scripts", "build-npm.ts");

const AGENT_INSTALL = z.looseObject({ path: z.string() });

const scheduledSync = (home: Home, bins: readonly string[]): string => {
  const { path } = succeeded(
    runOnCleanMachine(home, bins, ["agent-record", "agent", "install"]),
    "agent",
    AGENT_INSTALL,
  );
  expect(path).toBe(join(home.root, "Library", "LaunchAgents", "dev.agentrecord.sync.plist"));
  return readFileSync(path, "utf8");
};

const runsSync = (program: string): string =>
  `<array>\n    <string>${program}</string>\n    <string>sync</string>\n  </array>`;

const versionOf = (home: Home, bins: readonly string[]) =>
  runOnCleanMachine(home, bins, ["agent-record", "--version"]);

test(
  "AC-60 the release binary, alone on PATH in a fresh home, syncs, answers a query and schedules the sync of the command it was run as",
  () => {
    const binary = compiledRelease(scratchDir());
    const bins = [dirname(binary)];
    const home = withFixtures(scratchHome(), [LONG]);

    const synced = succeeded(
      runOnCleanMachine(home, bins, ["agent-record", "sync"]),
      "sync",
      SYNC_COMMAND_RESULT,
    );
    expect(synced.sources).toContainEqual({ tool: "claude", files: 1 });

    const found = succeeded(
      runOnCleanMachine(home, bins, ["agent-record", "query", "search", "parser"]),
      "query",
      QUERY_RESULT,
    );
    expect(found.rows.length).toBeGreaterThan(0);

    expect(scheduledSync(home, bins)).toContain(runsSync(binary));

    const linked = join(scratchDir(), "bin", "agent-record");
    mkdirSync(dirname(linked));
    symlinkSync(binary, linked);
    const { path } = succeeded(
      runOnCleanMachine(home, bins, [linked, "agent", "install"]),
      "agent",
      AGENT_INSTALL,
    );
    expect(readFileSync(path, "utf8")).toContain(runsSync(linked));
  },
  BUILD_TIMEOUT_MS,
);

test(
  "AC-63 install.sh installs the latest release after checking its checksums, and installs nothing from a bad download",
  () => {
    const dir = scratchDir();
    const assets = releaseAssets(join(dir, "assets"), compiledRelease(join(dir, "build")), "darwin-arm64");
    const curl = curlServing(join(dir, "fake-bin"), assets);
    const home = scratchHome();
    const installed = join(home.root, ".local", "bin");

    const ran = runOnCleanMachine(home, [curl], ["/bin/sh", INSTALL]);
    expect(ran).toMatchObject({ exitCode: 0, stderr: "" });
    expect(versionOf(home, [installed])).toEqual({ exitCode: 0, stdout: `${version}\n`, stderr: "" });
    expect(runOnCleanMachine(home, [curl], ["/bin/sh", INSTALL]).exitCode).toBe(0);
    expect(scheduledSync(home, [installed])).toContain(runsSync(join(installed, "agent-record")));

    writeFileSync(
      join(assets, "agent-record-darwin-arm64.sha256"),
      `${"0".repeat(64)}  agent-record-darwin-arm64.tar.gz\n`,
    );
    const fresh = scratchHome();
    const badDownload = runOnCleanMachine(fresh, [curl], ["/bin/sh", INSTALL]);
    expect(badDownload.exitCode).toBe(1);
    expect(badDownload.stderr).toContain("agent-record install: checksum mismatch for");
    expect(existsSync(join(fresh.root, ".local"))).toBe(false);
  },
  BUILD_TIMEOUT_MS,
);

test(
  "AC-64 the npm package runs its platform's binary with no runtime on PATH, refuses on another platform and when the platform package is missing or cannot start, and the agent runs the npm command",
  () => {
    const dir = scratchDir();
    const assets = releaseAssets(join(dir, "assets"), compiledRelease(join(dir, "build")), "darwin-arm64");
    cpSync(join(assets, "agent-record-darwin-arm64.tar.gz"), join(assets, "agent-record-linux-x64.tar.gz"));
    const tree = join(dir, "npm");
    const built = Bun.spawnSync([process.execPath, BUILD_NPM, assets, tree]);
    expect({ exitCode: built.exitCode, stderr: built.stderr.toString() }).toEqual({
      exitCode: 0,
      stderr: "",
    });

    const modules = join(dir, "prefix", "lib", "node_modules", "@cniska");
    mkdirSync(modules, { recursive: true });
    cpSync(join(tree, "agent-record"), join(modules, "agent-record"), { recursive: true });
    const bin = join(dir, "prefix", "bin");
    mkdirSync(bin);
    symlinkSync(join(modules, "agent-record", "bin", "agent-record"), join(bin, "agent-record"));
    const bins = [bin];
    for (const runtime of ["node", "bun"])
      expect(Bun.which(runtime, { PATH: [...bins, SYSTEM_PATH].join(":") })).toBeNull();
    expect(Bun.which("git", { PATH: SYSTEM_PATH })).not.toBeNull();
    const home = scratchHome();

    expect(refused(versionOf(home, [unameSaying("Plan9", "mips"), ...bins]), "agent-record").code).toBe(
      "no_build_for_platform",
    );
    expect(refused(versionOf(home, bins), "agent-record").code).toBe("platform_package_missing");

    const nested = join(modules, "agent-record", "node_modules", "@cniska", "agent-record-darwin-arm64");
    cpSync(join(tree, "darwin-arm64"), nested, { recursive: true });
    const platformBinary = join(nested, "agent-record");
    chmodSync(platformBinary, 0o644);
    expect(refused(versionOf(home, bins), "agent-record").code).toBe("binary_failed");
    chmodSync(platformBinary, 0o755);

    expect(versionOf(home, bins)).toEqual({ exitCode: 0, stdout: `${version}\n`, stderr: "" });
    expect(scheduledSync(home, bins)).toContain(runsSync(join(bin, "agent-record")));
  },
  BUILD_TIMEOUT_MS,
);
