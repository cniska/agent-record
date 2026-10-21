import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { removeScratch, scratchTempDir } from "../acceptance/cli";
import { version } from "../package.json";
import { ownerEnv } from "../src/git-test-env.test-support";

const LAUNCHER = resolve(import.meta.dir, "..", "bin", "agent-record");

afterEach(removeScratch);

function ownerEnvWith(dataHome: string): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env, ...ownerEnv, XDG_DATA_HOME: dataHome };
  delete env.MISE_DATA_DIR;
  return env;
}

describe("the source launcher", () => {
  test("finds bun through mise when XDG_DATA_HOME points at an empty directory", () => {
    const run = spawnSync(LAUNCHER, ["--version"], {
      encoding: "utf8",
      env: ownerEnvWith(scratchTempDir()),
    });
    expect([run.status, run.stdout, run.stderr]).toEqual([0, `${version}\n`, ""]);
  });
});
