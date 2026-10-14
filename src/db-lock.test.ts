import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { withLock } from "./db-lock";

const LOCK_HELD = expect.objectContaining({ code: "lock_held" });

import type { Env } from "./env";
import { scratchEnv } from "./fixtures.test-support";

const roots: string[] = [];

function newRoot(): { env: Env; lock: string } {
  const root = mkdtempSync(join(tmpdir(), "agent-record-lock-"));
  roots.push(root);
  return { env: scratchEnv(root), lock: join(root, "state", "agent-record", "locks", "record") };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("the write lock", () => {
  test("releases after synchronous work", () => {
    const { env, lock } = newRoot();
    expect(withLock(env, () => existsSync(lock))).toBe(true);
    expect(existsSync(lock)).toBe(false);
  });

  test("releases when synchronous work throws", () => {
    const { env, lock } = newRoot();
    expect(() =>
      withLock(env, () => {
        throw new Error("mid-write");
      }),
    ).toThrow("mid-write");
    expect(existsSync(lock)).toBe(false);
  });

  test("stays held until asynchronous work finishes", async () => {
    const { env, lock } = newRoot();
    let heldMidway = false;
    const running = withLock(env, async () => {
      await Bun.sleep(20);
      heldMidway = existsSync(lock);
    });

    expect(existsSync(lock)).toBe(true);
    await running;
    expect(heldMidway).toBe(true);
    expect(existsSync(lock)).toBe(false);
  });

  test("a second run is refused while asynchronous work is still in flight", async () => {
    const { env, lock } = newRoot();
    const running = withLock(env, async () => {
      await Bun.sleep(20);
    });

    expect(() => withLock(env, () => null)).toThrow(LOCK_HELD);
    await running;
    expect(existsSync(lock)).toBe(false);
  });

  test("releases when asynchronous work rejects", async () => {
    const { env, lock } = newRoot();
    const running = withLock(env, async () => {
      await Bun.sleep(5);
      throw new Error("mid-write");
    });

    await expect(running).rejects.toThrow("mid-write");
    expect(existsSync(lock)).toBe(false);
  });

  test("a lock left behind by a killed run is taken over", () => {
    const { env, lock } = newRoot();
    mkdirSync(lock, { recursive: true });
    writeFileSync(join(lock, "pid"), "999999");
    expect(withLock(env, () => existsSync(lock))).toBe(true);
    expect(existsSync(lock)).toBe(false);
  });

  test("the lock names its holder for as long as it is held", () => {
    const { env, lock } = newRoot();
    withLock(env, () => {
      expect(readFileSync(join(lock, "pid"), "utf8")).toBe(String(process.pid));
    });
  });

  test("a lock directory with no pid file is not a holder", () => {
    const { env, lock } = newRoot();
    mkdirSync(lock, { recursive: true });
    writeFileSync(join(lock, "stray"), "");
    expect(withLock(env, () => "ran")).toBe("ran");
  });

  test("an empty pid file is not a holder", () => {
    const { env, lock } = newRoot();
    mkdirSync(lock, { recursive: true });
    writeFileSync(join(lock, "pid"), "");
    expect(withLock(env, () => "ran")).toBe("ran");
  });

  test("a pid file that cannot be read is refused, not taken over", () => {
    const { env, lock } = newRoot();
    mkdirSync(join(lock, "pid"), { recursive: true });
    let ran = false;
    expect(() =>
      withLock(env, () => {
        ran = true;
      }),
    ).toThrow(
      expect.objectContaining({
        kind: "refusal",
        code: "lock_unreadable",
        meta: expect.objectContaining({ path: lock }),
        resolve: `remove ${lock} if no agent-record is running`,
      }),
    );
    expect(ran).toBe(false);
    expect(readdirSync(lock)).toEqual(["pid"]);
  });

  test("a refused run leaves nothing of its own behind", () => {
    const { env, lock } = newRoot();
    mkdirSync(lock, { recursive: true });
    writeFileSync(join(lock, "pid"), String(process.pid));
    expect(() => withLock(env, () => "ran")).toThrow(LOCK_HELD);
    expect(readdirSync(dirname(lock))).toEqual(["record"]);
  });
});
