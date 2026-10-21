import { afterAll } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TEST_GIT_ENV = {
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "T",
  GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "T",
  GIT_COMMITTER_EMAIL: "t@example.com",
} as const;

const SCRATCH_DIRS = {
  HOME: "home",
  XDG_CONFIG_HOME: "config",
  XDG_DATA_HOME: "data",
  XDG_STATE_HOME: "state",
} as const;

type ScratchVariable = keyof typeof SCRATCH_DIRS;

export const ownerEnv: Readonly<Record<ScratchVariable, string | undefined>> = {
  HOME: process.env.HOME,
  XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
  XDG_DATA_HOME: process.env.XDG_DATA_HOME,
  XDG_STATE_HOME: process.env.XDG_STATE_HOME,
};

for (const name of Object.keys(process.env)) {
  if (name.startsWith("GIT_")) delete process.env[name];
}

Object.assign(process.env, TEST_GIT_ENV);

const scratchHome = realpathSync(mkdtempSync(join(tmpdir(), "agent-record-test-home-")));

for (const [variable, dir] of Object.entries(SCRATCH_DIRS)) {
  const path = join(scratchHome, dir);
  mkdirSync(path);
  process.env[variable] = path;
}

afterAll(() => rmSync(scratchHome, { recursive: true, force: true }));
