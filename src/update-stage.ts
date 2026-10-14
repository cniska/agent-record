import { randomUUID } from "node:crypto";
import { chmodSync, copyFileSync, mkdirSync, realpathSync, renameSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { VERSION_FLAG } from "./cli-contract";
import type { Env } from "./env";
import { stagedBuildPath, stagedBuildsDir } from "./paths";
import { refuseUpdate } from "./update-contract";
import { stagedBuilds } from "./update-state";
import { isNewer } from "./update-version";

function reportedVersion(binary: string): string | null {
  const ran = Bun.spawnSync([binary, VERSION_FLAG], { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
  return ran.exitCode === 0 ? ran.stdout.toString() : null;
}

export function stageBuild(source: string, version: string, env: Env): string {
  const root = stagedBuildsDir(env);
  const target = stagedBuildPath(env, version);
  const partial = join(root, `.${version}.${randomUUID()}.partial`);
  mkdirSync(root, { recursive: true });
  try {
    copyFileSync(source, partial);
    chmodSync(partial, 0o755);
    const reported = reportedVersion(partial);
    if (reported !== `${version}\n`) {
      const said = reported === null ? "fails" : `prints ${JSON.stringify(reported.trim())}`;
      throw refuseUpdate("update_failed", {
        detail: `the downloaded ${version} build ${said} on ${VERSION_FLAG}, so it is not staged`,
      });
    }
    mkdirSync(dirname(target), { recursive: true });
    renameSync(partial, target);
  } finally {
    rmSync(partial, { force: true });
  }
  return target;
}

export function pruneStaged(running: string, executable: string, env: Env): readonly string[] {
  const spared = dirname(realpathSync(executable));
  return stagedBuilds(env)
    .filter(({ version, dir }) => !isNewer(version, running) && realpathSync(dir) !== spared)
    .map(({ version, dir }) => {
      rmSync(dir, { recursive: true, force: true });
      return version;
    });
}
