import { randomUUID } from "node:crypto";
import { chmodSync, copyFileSync, mkdirSync, realpathSync, renameSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { VERSION_FLAG } from "./cli-contract";
import type { Env } from "./env";
import { stagedBuildPath, stagedBuildsDir } from "./paths";
import { refuseUpdate } from "./update-contract";
import { stagedBuilds } from "./update-state";
import { isNewer } from "./update-version";

const STARTUP_CHECK_TIMEOUT_MS = 30_000;

function printed(binary: string, args: readonly string[]): string | null {
  const ran = Bun.spawnSync([binary, ...args], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "ignore",
    timeout: STARTUP_CHECK_TIMEOUT_MS,
  });
  return ran.exitCode === 0 ? ran.stdout.toString() : null;
}

function startupFailure(binary: string, version: string): string | null {
  const reported = printed(binary, [VERSION_FLAG]);
  if (reported === null) return `fails on ${VERSION_FLAG}`;
  if (reported !== `${version}\n`) return `prints ${JSON.stringify(reported.trim())} on ${VERSION_FLAG}`;
  if (printed(binary, []) === null) return "fails to list its commands";
  return null;
}

export function stageBuild(source: string, version: string, env: Env): string {
  const root = stagedBuildsDir(env);
  const target = stagedBuildPath(env, version);
  const partial = join(root, `.${version}.${randomUUID()}.partial`);
  mkdirSync(root, { recursive: true });
  try {
    copyFileSync(source, partial);
    chmodSync(partial, 0o755);
    const failure = startupFailure(partial, version);
    if (failure !== null) {
      throw refuseUpdate("build_unrunnable", { version, failure });
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
