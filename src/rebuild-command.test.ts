import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli, scratchEnv } from "./fixtures.test-support";
import { syncStampPath } from "./paths";

describe("agent-record rebuild", () => {
  test("stamps the time it finished, as a sync does", () => {
    const root = mkdtempSync(join(tmpdir(), "agent-record-rebuild-"));
    try {
      const env = scratchEnv(root);
      expect(runCli(env, ["rebuild"]).exitCode).toBe(0);
      expect(existsSync(syncStampPath(env))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
