import { afterEach, expect, test } from "bun:test";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { version } from "../package.json";
import {
  compiledRelease,
  curlServing,
  type Home,
  installedLauncher,
  QUERY_RESULT,
  releaseAssets,
  removeScratch,
  runOnCleanMachine,
  SYNC_COMMAND_RESULT,
  scratchHome,
  scratchTempDir,
  succeeded,
  withFixtures,
} from "./cli";
import { LONG } from "./fixture-names";

afterEach(removeScratch);

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
  "AC-60 the release binary, alone on PATH in a fresh home, syncs, answers a query and schedules its own sync",
  () => {
    const binary = compiledRelease(scratchTempDir());
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

    expect(scheduledSync(home, bins)).toContain(runsSync(realpathSync(binary)));
  },
  BUILD_TIMEOUT_MS,
);

test(
  "AC-62 the launcher runs the newest of its binary and the staged builds, and the agent runs the launcher",
  () => {
    const dir = scratchTempDir();
    const baseline = compiledRelease(join(dir, "lib"), "0.1.0");
    const bin = join(dir, "bin");
    const launcher = installedLauncher(bin, baseline, "0.1.0");
    const home = scratchHome();

    expect(versionOf(home, [bin])).toEqual({ exitCode: 0, stdout: "0.1.0\n", stderr: "" });

    const staged = join(home.root, ".local", "share", "agent-record", "bin");
    compiledRelease(join(staged, "0.2.0"), "0.2.0");
    mkdirSync(join(staged, "0.0.9"), { recursive: true });
    cpSync(baseline, join(staged, "0.0.9", "agent-record"));
    expect(versionOf(home, [bin]).stdout).toBe("0.2.0\n");

    expect(scheduledSync(home, [bin])).toContain(runsSync(launcher));
  },
  BUILD_TIMEOUT_MS,
);

test(
  "AC-63 install.sh installs the latest release after checking its checksums, and installs nothing from a bad download",
  () => {
    const dir = scratchTempDir();
    const assets = releaseAssets(join(dir, "assets"), compiledRelease(join(dir, "build")));
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
    const refused = runOnCleanMachine(fresh, [curl], ["/bin/sh", INSTALL]);
    expect(refused.exitCode).toBe(1);
    expect(refused.stderr).toContain("agent-record install: checksum mismatch for");
    expect(existsSync(join(fresh.root, ".local"))).toBe(false);
  },
  BUILD_TIMEOUT_MS,
);

test(
  "AC-64 the npm package runs its platform's binary through the launcher, and the agent runs the npm command",
  () => {
    const dir = scratchTempDir();
    const assets = releaseAssets(join(dir, "assets"), compiledRelease(join(dir, "build")));
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
    cpSync(join(tree, "darwin-arm64"), join(modules, "agent-record-darwin-arm64"), { recursive: true });
    const bin = join(dir, "prefix", "bin");
    mkdirSync(bin);
    symlinkSync(join(modules, "agent-record", "bin", "agent-record.cjs"), join(bin, "agent-record"));
    const node = Bun.which("node");
    expect(node).not.toBeNull();
    const bins = [bin, dirname(node ?? "")];
    const home = scratchHome();

    expect(versionOf(home, bins)).toEqual({ exitCode: 0, stdout: `${version}\n`, stderr: "" });
    expect(scheduledSync(home, bins)).toContain(runsSync(join(bin, "agent-record")));
  },
  BUILD_TIMEOUT_MS,
);
