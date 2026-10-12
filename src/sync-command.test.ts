import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli, scratchEnv } from "./fixtures.test-support";
import { syncStampPath } from "./paths";

describe("agent-record sync", () => {
  test("stamps the time it finished, which lets the doctor pass", () => {
    const root = mkdtempSync(join(tmpdir(), "agent-record-sync-"));
    try {
      const env = scratchEnv(root);
      const before = Date.now();
      expect(runCli(env, ["sync"]).exitCode).toBe(0);
      const stamp = readFileSync(syncStampPath(env), "utf8");
      expect(Date.parse(stamp.trim())).toBeGreaterThanOrEqual(before - 1000);
      const ran = runCli(env, ["doctor"]);
      expect(JSON.parse(ran.stdout)).toMatchObject({ command: "doctor", ok: true, result: { failing: 0 } });
      expect(ran.exitCode).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
