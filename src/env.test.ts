import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Invocation, parseEnv, releaseCommand } from "./env";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const EXEC_PATH = "/opt/homebrew/Cellar/agent-record/0.1.0/bin/agent-record";

type Machine = { readonly root: string; readonly bin: string };

function machine(): Machine {
  const root = mkdtempSync(join(tmpdir(), "agent-record-env-"));
  roots.push(root);
  const build = join(root, "Cellar", "agent-record");
  mkdirSync(join(root, "Cellar"));
  writeFileSync(build, "#!/bin/sh\n");
  chmodSync(build, 0o755);
  const bin = join(root, "bin");
  mkdirSync(bin);
  symlinkSync(build, join(bin, "agent-record"));
  return { root, bin };
}

function invocation(overrides: Partial<Invocation>): Invocation {
  return { raw: {}, argv0: "", cwd: "/", execPath: EXEC_PATH, ...overrides };
}

describe("the command a release was started as", () => {
  test("is the absolute command the npm package passes", () => {
    const raw = { AGENT_RECORD_COMMAND: "/usr/local/bin/agent-record" };
    expect(releaseCommand(invocation({ raw, argv0: "node" }))).toBe("/usr/local/bin/agent-record");
  });

  test("ignores a passed command that is relative or empty", () => {
    for (const given of ["agent-record", ""])
      expect(releaseCommand(invocation({ raw: { AGENT_RECORD_COMMAND: given } }))).toBe(EXEC_PATH);
  });

  test("is the PATH entry a bare name was found in, without following its symlink", () => {
    const { root, bin } = machine();
    const empty = join(root, "empty");
    mkdirSync(empty);
    const raw = { PATH: ["relative", empty, bin, "/usr/bin"].join(":") };
    expect(releaseCommand(invocation({ raw, argv0: "agent-record" }))).toBe(join(bin, "agent-record"));
  });

  test("skips a PATH entry whose file of that name is not executable", () => {
    const { root, bin } = machine();
    const shadow = join(root, "shadow");
    mkdirSync(shadow);
    writeFileSync(join(shadow, "agent-record"), "");
    const raw = { PATH: [shadow, bin].join(":") };
    expect(releaseCommand(invocation({ raw, argv0: "agent-record" }))).toBe(join(bin, "agent-record"));
  });

  test("is a relative path made absolute against the working directory, without following its symlink", () => {
    const { root, bin } = machine();
    expect(releaseCommand(invocation({ argv0: "./bin/agent-record", cwd: root }))).toBe(
      join(bin, "agent-record"),
    );
  });

  test("is an absolute path as typed, without following its symlink", () => {
    const { bin } = machine();
    const typed = join(bin, "agent-record");
    expect(releaseCommand(invocation({ argv0: typed }))).toBe(typed);
  });

  test("is the running binary when what was typed finds no executable", () => {
    const { root } = machine();
    const raw = { PATH: join(root, "bin") };
    for (const argv0 of ["", "missing", "./missing", join(root, "Cellar")])
      expect(releaseCommand(invocation({ raw, argv0, cwd: root }))).toBe(EXEC_PATH);
  });
});

describe("the update check", () => {
  test("is on unless CI or AGENT_RECORD_NO_UPDATE_CHECK is set", () => {
    const home = { HOME: "/home/owner" };
    expect(parseEnv(home).updateCheck).toBe(true);
    expect(parseEnv({ ...home, CI: "", AGENT_RECORD_NO_UPDATE_CHECK: " " }).updateCheck).toBe(true);
    expect(parseEnv({ ...home, CI: "true" }).updateCheck).toBe(false);
    expect(parseEnv({ ...home, AGENT_RECORD_NO_UPDATE_CHECK: "1" }).updateCheck).toBe(false);
  });
});

describe("the launchd job", () => {
  test("is the one running it, if any", () => {
    const home = { HOME: "/home/owner" };
    expect(parseEnv(home).launchdJob).toBeNull();
    expect(parseEnv({ ...home, XPC_SERVICE_NAME: " " }).launchdJob).toBeNull();
    expect(parseEnv({ ...home, XPC_SERVICE_NAME: "dev.agentrecord.sync" }).launchdJob).toBe(
      "dev.agentrecord.sync",
    );
  });
});

describe("bun's global install", () => {
  test("is under BUN_INSTALL, else ~/.bun", () => {
    expect(parseEnv({ HOME: "/home/owner" }).bunInstall).toBe("/home/owner/.bun");
    expect(parseEnv({ HOME: "/home/owner", BUN_INSTALL: "/opt/bun" }).bunInstall).toBe("/opt/bun");
  });
});
