import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOOKS = join(import.meta.dir, "..", "plugin", "hooks");
const HOOK = join(HOOKS, "session-start.sh");
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function binWith(cli: boolean): { bin: string; synced: string } {
  const root = mkdtempSync(join(tmpdir(), "agent-record-hook-"));
  roots.push(root);
  const bin = join(root, "bin");
  mkdirSync(bin);
  const synced = join(root, "synced");
  if (cli) {
    expect(Bun.spawnSync(["mkfifo", synced]).exitCode).toBe(0);
    const stub = join(bin, "agent-record");
    writeFileSync(stub, `#!/bin/sh\necho "$@" > "${synced}"\n`);
    chmodSync(stub, 0o755);
  }
  return { bin, synced };
}

function runHook(bin: string) {
  const ran = Bun.spawnSync(["/bin/sh", HOOK], { env: { PATH: `${bin}:/usr/bin:/bin` } });
  return { exitCode: ran.exitCode, stdout: ran.stdout.toString() };
}

describe("the plugin's session-start hook", () => {
  test("starts a sync and prints the note that points the session at the record", async () => {
    const { bin, synced } = binWith(true);
    const ran = runHook(bin);
    expect(ran.exitCode).toBe(0);
    expect(ran.stdout).toBe(readFileSync(join(HOOKS, "note.md"), "utf8"));
    expect(await readFile(synced, "utf8")).toBe("sync\n");
  });

  test("prints nothing when the CLI is not on PATH", () => {
    const { bin } = binWith(false);
    expect(runHook(bin)).toEqual({ exitCode: 0, stdout: "" });
  });
});
