import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withLock } from "./db-lock";
import { runCli, scratchEnv } from "./fixtures.test-support";
import { syncStampPath } from "./paths";

describe("agent-record sync", () => {
  test("stamps the time it finished, which lets the doctor pass", () => {
    const root = mkdtempSync(join(tmpdir(), "agent-record-sync-"));
    try {
      const env = scratchEnv(root);
      const before = Date.now();
      expect(runCli(env, ["sync"]).exitCode).toBe(0);
      const stamp = JSON.parse(readFileSync(syncStampPath(env), "utf8"));
      expect(stamp).toMatchObject({ kind: "finished", failures: null });
      expect(Date.parse(stamp.at)).toBeGreaterThanOrEqual(before - 1000);
      const ran = runCli(env, ["doctor"]);
      expect(JSON.parse(ran.stdout)).toMatchObject({ command: "doctor", ok: true, result: { failing: 0 } });
      expect(ran.exitCode).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("refused while another run holds the record, leaves the last outcome as it was", () => {
    const root = mkdtempSync(join(tmpdir(), "agent-record-sync-"));
    try {
      const env = scratchEnv(root);
      const ran = withLock(() => runCli(env, ["sync"]), env);
      expect(ran.exitCode).toBe(1);
      expect(JSON.parse(ran.stderr)).toMatchObject({ error: { code: "lock_held" } });
      expect(existsSync(syncStampPath(env))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
