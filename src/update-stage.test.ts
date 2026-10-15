import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseEnv } from "./env";
import { stageBuild } from "./update-stage";

const cleanups: (() => void)[] = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function scratchDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "agent-record-update-stage-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function build(dir: string, script: string): string {
  const path = join(dir, "downloaded");
  writeFileSync(path, `#!/bin/sh\n${script}\n`);
  return path;
}

describe("stageBuild", () => {
  test("refuses a build that prints its version but cannot load its commands", () => {
    const dir = scratchDir();
    const env = parseEnv({ HOME: dir });
    const source = build(dir, 'if [ "$1" = "--version" ]; then echo 0.2.0; exit 0; fi\nexit 1');
    expect(() => stageBuild(source, "0.2.0", env)).toThrow(
      expect.objectContaining({
        code: "build_unrunnable",
        message: "the downloaded 0.2.0 build fails to list its commands, so it is not staged",
      }),
    );
    expect(existsSync(join(dir, ".local", "share", "agent-record", "bin", "0.2.0"))).toBe(false);
  });

  test("stages a build that prints its version and lists its commands", () => {
    const dir = scratchDir();
    const env = parseEnv({ HOME: dir });
    const source = build(dir, 'if [ "$1" = "--version" ]; then echo 0.2.0; fi\nexit 0');
    expect(stageBuild(source, "0.2.0", env)).toBe(
      join(dir, ".local", "share", "agent-record", "bin", "0.2.0", "agent-record"),
    );
  });
});
