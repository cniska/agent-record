import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOOKS = join(import.meta.dir, "..", "plugin", "hooks");
const HOOK = join(HOOKS, "session-start.sh");
const SETTLE_TRIES = 200;
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
    const stub = join(bin, "agent-record");
    writeFileSync(stub, `#!/bin/sh\necho "$@" > "${synced}.tmp" && mv "${synced}.tmp" "${synced}"\n`);
    chmodSync(stub, 0o755);
  }
  return { bin, synced };
}

function runHook(bin: string) {
  const ran = Bun.spawnSync(["/bin/sh", HOOK], { env: { PATH: `${bin}:/usr/bin:/bin` } });
  return { exitCode: ran.exitCode, stdout: ran.stdout.toString() };
}

async function settled(path: string): Promise<boolean> {
  for (let tries = 0; tries < SETTLE_TRIES && !existsSync(path); tries += 1) await Bun.sleep(20);
  return existsSync(path);
}

describe("the plugin's session-start hook", () => {
  test("starts a sync and prints the note that points the session at the record", async () => {
    const { bin, synced } = binWith(true);
    const ran = runHook(bin);
    expect(ran.exitCode).toBe(0);
    expect(ran.stdout).toBe(readFileSync(join(HOOKS, "note.md"), "utf8"));
    expect(await settled(synced)).toBe(true);
    expect(readFileSync(synced, "utf8")).toBe("sync\n");
  });

  test("prints nothing when the CLI is not on PATH", () => {
    const { bin } = binWith(false);
    expect(runHook(bin)).toEqual({ exitCode: 0, stdout: "" });
  });
});
